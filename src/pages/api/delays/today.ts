/**
 * GET /api/delays/today
 * Returns today's delay dashboard: stats, hourly breakdown, top delayed, disruptions.
 * Fast path: KV cache. Fallback: D1 queries.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface TodayStats {
  totalTrains: number;
  punctuality: number;
  avgDelay: number;
  cancelled: number;
}

interface HourlyDelay {
  hour: string;
  avgDelay: number;
}

interface TopDelayed {
  trainNumber: string;
  delay: number;
  route: string;
  station: string;
  carrier?: string;
}

interface DisruptionItem {
  message: string;
  route: string;
}

interface TodayResponse {
  stats: TodayStats;
  hourlyDelays: HourlyDelay[];
  topDelayed: TopDelayed[];
  disruptions: DisruptionItem[];
}

const CACHE_TTL = 120; // 2 min — data updates every 2 min via cron

function emptyResponse(): TodayResponse {
  return {
    stats: { totalTrains: 0, punctuality: 0, avgDelay: 0, cancelled: 0 },
    hourlyDelays: [],
    topDelayed: [],
    disruptions: [],
  };
}

export const GET: APIRoute = async () => {
  try {
    // ── Fast path: KV cache ──────────────────────────────────────────
    const cached = await env.DELAYS_KV.get('stats:today', 'json') as Record<string, any> | null;
    if (cached) {
      // Normalize: prefer Portal Pasażera real punctuality > GTFS-RT corrected > scraper-only
      const normalized: TodayResponse = {
        stats: {
          totalTrains: cached.gtfsRtTotalTrains || cached.totalTrains || 0,
          punctuality: cached.portalPunctualityOnRoute
            ?? cached.correctedPunctualityPct
            ?? cached.punctualityPct
            ?? 0,
          avgDelay: cached.avgDelay || 0,
          cancelled: cached.cancelledCount || 0,
        },
        hourlyDelays: cached.hourlyDelays || [],
        topDelayed: cached.topDelayed || [],
        disruptions: cached.disruptions || [],
      };
      return new Response(JSON.stringify(normalized), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      });
    }

    // ── Fallback: D1 queries ─────────────────────────────────────────
    // TIMEZONE FIX: Use Poland timezone instead of server time
    const now = new Date();
    const polandTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Warsaw"}));
    const today = [
      polandTime.getFullYear(),
      String(polandTime.getMonth() + 1).padStart(2, '0'),
      String(polandTime.getDate()).padStart(2, '0'),
    ].join('-');

    // Overall stats for today
    const statsRow = await env.DB.prepare(`
      SELECT
        COUNT(DISTINCT schedule_id || '-' || order_id) AS total_trains,
        AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay,
        SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) <= 5 THEN 1 ELSE 0 END) AS on_time,
        SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END) AS cancelled
      FROM delay_snapshots
      WHERE operating_date = ?
    `).bind(today).first();

    const totalTrains = (statsRow?.total_trains as number) || 0;
    const onTime = (statsRow?.on_time as number) || 0;
    const punctuality = totalTrains > 0 ? Math.round((onTime / totalTrains) * 100) : 0;

    const stats: TodayStats = {
      totalTrains,
      punctuality,
      avgDelay: Math.round(((statsRow?.avg_delay as number) || 0) * 10) / 10,
      cancelled: (statsRow?.cancelled as number) || 0,
    };

    // Hourly breakdown
    const hourlyRows = await env.DB.prepare(`
      SELECT
        strftime('%H:00', COALESCE(planned_departure, planned_arrival)) AS hour,
        ROUND(AVG(COALESCE(departure_delay, arrival_delay, 0)), 1) AS avg_delay
      FROM delay_snapshots
      WHERE operating_date = ?
        AND COALESCE(planned_departure, planned_arrival) IS NOT NULL
      GROUP BY hour
      ORDER BY hour
    `).bind(today).all();

    const hourlyDelays: HourlyDelay[] = (hourlyRows.results || []).map((r) => ({
      hour: r.hour as string,
      avgDelay: r.avg_delay as number,
    }));

    // Top delayed trains — subquery to get the station with the actual max delay
    const topRows = await env.DB.prepare(`
      SELECT
        agg.schedule_id,
        agg.order_id,
        COALESCE(t.train_number, agg.schedule_id || '/' || agg.order_id) AS train_number,
        agg.max_delay,
        COALESCE(t.route_start || ' \u2192 ' || t.route_end, '') AS route,
        COALESCE(detail.station_name, '') AS station_name
      FROM (
        SELECT schedule_id, order_id,
               MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay
        FROM delay_snapshots
        WHERE operating_date = ?
        GROUP BY schedule_id, order_id
        HAVING max_delay > 0
      ) agg
      LEFT JOIN trains t
        ON t.schedule_id = agg.schedule_id AND t.order_id = agg.order_id
      LEFT JOIN delay_snapshots detail
        ON detail.schedule_id = agg.schedule_id
        AND detail.order_id = agg.order_id
        AND detail.operating_date = ?
        AND COALESCE(detail.arrival_delay, detail.departure_delay, 0) = agg.max_delay
      ORDER BY agg.max_delay DESC
      LIMIT 10
    `).bind(today, today).all();

    const topDelayed: TopDelayed[] = (topRows.results || []).map((r) => ({
      trainNumber: r.train_number as string,
      delay: r.max_delay as number,
      route: r.route as string,
      station: (r.station_name as string) || '',
    }));

    // Active disruptions from KV or D1
    let disruptions: DisruptionItem[] = [];
    const kvDisruptions = await env.DELAYS_KV.get('disruptions:active', 'json') as { disruptions?: Array<{ message: string; startStation: string; endStation: string }> } | null;

    if (kvDisruptions?.disruptions) {
      disruptions = kvDisruptions.disruptions.map((d) => ({
        message: d.message,
        route: `${d.startStation} → ${d.endStation}`,
      }));
    } else {
      const dRows = await env.DB.prepare(`
        SELECT message, start_station, end_station
        FROM disruptions
        WHERE is_active = 1
        ORDER BY last_seen DESC
        LIMIT 20
      `).all();

      disruptions = (dRows.results || []).map((r) => ({
        message: r.message as string,
        route: `${r.start_station} → ${r.end_station}`,
      }));
    }

    const response: TodayResponse = { stats, hourlyDelays, topDelayed, disruptions };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch (err) {
    console.error('[api/delays/today] Database error:', err);

    // Return 503 Service Unavailable so clients can distinguish from "no delays"
    return new Response(JSON.stringify({
      error: 'Nie udało się pobrać danych opóźnień',
      code: 'DATABASE_ERROR',
      message: err instanceof Error ? err.message : 'Unknown error'
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });
  }
};
