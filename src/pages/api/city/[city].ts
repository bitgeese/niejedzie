/**
 * GET /api/city/{city}
 * Returns city-level delay data: today's stats, top delayed trains, historical trend.
 * City slug mapped to station names (warszawa → Warszawa Centralna, Wschodnia, etc.)
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// ── City → Station mapping ─────────────────────────────────────────────

const CITY_STATIONS: Record<string, { display: string; patterns: string[] }> = {
  warszawa: {
    display: 'Warszawa',
    patterns: [
      'Warszawa Centralna', 'Warszawa Wschodnia', 'Warszawa Zachodnia',
      'Warszawa Gdańska', 'Warszawa Wileńska',
    ],
  },
  krakow: {
    display: 'Kraków',
    patterns: ['Kraków Główny', 'Kraków Płaszów', 'Kraków Łobzów'],
  },
  gdansk: {
    display: 'Gdańsk',
    patterns: ['Gdańsk Główny', 'Gdańsk Wrzeszcz', 'Gdańsk Oliwa'],
  },
  wroclaw: {
    display: 'Wrocław',
    patterns: ['Wrocław Główny', 'Wrocław Mikołajów'],
  },
  poznan: {
    display: 'Poznań',
    patterns: ['Poznań Główny', 'Poznań Wschód'],
  },
  katowice: {
    display: 'Katowice',
    patterns: ['Katowice', 'Katowice Ligota'],
  },
  szczecin: {
    display: 'Szczecin',
    patterns: ['Szczecin Główny', 'Szczecin Dąbie'],
  },
  lodz: {
    display: 'Łódź',
    patterns: ['Łódź Fabryczna', 'Łódź Kaliska', 'Łódź Widzew'],
  },
};

interface CityTodayStats {
  trainCount: number;
  avgDelay: number;
  punctuality: number;
}

interface CityTopDelayed {
  trainNumber: string;
  delay: number;
  route: string;
  station: string;
}

interface CityHistoryDay {
  date: string;
  punctuality: number;
}

interface CityResponse {
  city: string;
  today: CityTodayStats;
  topDelayed: CityTopDelayed[];
  history: CityHistoryDay[];
}

const CACHE_TTL = 120;

export const GET: APIRoute = async ({ params }) => {
  try {
    const citySlug = params.city?.toLowerCase();

    if (!citySlug || !CITY_STATIONS[citySlug]) {
      return new Response(
        JSON.stringify({ error: 'Unknown city', validCities: Object.keys(CITY_STATIONS) }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const cityConfig = CITY_STATIONS[citySlug];
    const today = new Date().toISOString().split('T')[0];

    // Build SQL WHERE clause for station matching
    const stationPlaceholders = cityConfig.patterns.map(() => 'station_name = ?').join(' OR ');
    const stationBindings = cityConfig.patterns;

    // ── Today's stats ────────────────────────────────────────────────
    const todayRow = await env.DB.prepare(`
      SELECT
        COUNT(DISTINCT schedule_id || '-' || order_id) AS train_count,
        AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay,
        SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) <= 5 THEN 1 ELSE 0 END) AS on_time
      FROM delay_snapshots
      WHERE operating_date = ? AND (${stationPlaceholders})
    `).bind(today, ...stationBindings).first();

    const trainCount = (todayRow?.train_count as number) || 0;
    const onTime = (todayRow?.on_time as number) || 0;

    const todayStats: CityTodayStats = {
      trainCount,
      avgDelay: Math.round(((todayRow?.avg_delay as number) || 0) * 10) / 10,
      punctuality: trainCount > 0 ? Math.round((onTime / trainCount) * 100) : 0,
    };

    // ── Top delayed trains at this city's stations ───────────────────
    const topRows = await env.DB.prepare(`
      SELECT
        ds.schedule_id,
        ds.order_id,
        COALESCE(t.train_number, ds.schedule_id || '/' || ds.order_id) AS train_number,
        MAX(COALESCE(ds.arrival_delay, ds.departure_delay, 0)) AS max_delay,
        COALESCE(t.route_start || ' → ' || t.route_end, '') AS route,
        ds.station_name
      FROM delay_snapshots ds
      LEFT JOIN trains t ON t.schedule_id = ds.schedule_id AND t.order_id = ds.order_id
      WHERE ds.operating_date = ? AND (${stationPlaceholders})
      GROUP BY ds.schedule_id, ds.order_id
      HAVING max_delay > 0
      ORDER BY max_delay DESC
      LIMIT 10
    `).bind(today, ...stationBindings).all();

    const topDelayed: CityTopDelayed[] = (topRows.results || []).map((r) => ({
      trainNumber: r.train_number as string,
      delay: r.max_delay as number,
      route: r.route as string,
      station: (r.station_name as string) || '',
    }));

    // ── Historical data from city_daily (last 30 days) ───────────────
    const histRows = await env.DB.prepare(`
      SELECT date, punctuality_pct
      FROM city_daily
      WHERE city = ?
      ORDER BY date DESC
      LIMIT 30
    `).bind(cityConfig.display).all();

    const history: CityHistoryDay[] = (histRows.results || [])
      .map((r) => ({
        date: r.date as string,
        punctuality: (r.punctuality_pct as number) || 0,
      }))
      .reverse(); // chronological order

    const response: CityResponse = {
      city: cityConfig.display,
      today: todayStats,
      topDelayed,
      history,
    };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch (err) {
    console.error('[api/city] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
