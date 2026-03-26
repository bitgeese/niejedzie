/**
 * GET /api/stats/monthly
 * Returns punctuality stats for the stats dashboard.
 * Aggregates daily_stats into monthly trend + operator/category breakdown.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface MonthlyTrend {
  month: string; // YYYY-MM
  totalTrains: number;
  punctuality: number;
  avgDelay: number;
  cancelled: number;
}

interface OperatorStats {
  carrier: string;
  trainCount: number;
  avgDelay: number;
  punctuality: number;
}

interface CategoryStats {
  category: string;
  trainCount: number;
  avgDelay: number;
  punctuality: number;
}

interface MonthlyResponse {
  monthlyTrend: MonthlyTrend[];
  byOperator: OperatorStats[];
  byCategory: CategoryStats[];
}

const CACHE_TTL = 600; // 10 min — historical stats don't change fast

export const GET: APIRoute = async () => {
  try {
    // ── Monthly trend from daily_stats (last 12 months) ────────────
    const trendRows = await env.DB.prepare(`
      SELECT
        strftime('%Y-%m', date) AS month,
        SUM(total_trains) AS total_trains,
        SUM(on_time_count) AS on_time,
        ROUND(AVG(avg_delay), 1) AS avg_delay,
        SUM(cancelled_count) AS cancelled
      FROM daily_stats
      WHERE date >= date('now', '-12 months')
      GROUP BY month
      ORDER BY month ASC
    `).all();

    const monthlyTrend: MonthlyTrend[] = (trendRows.results || []).map((r) => {
      const total = (r.total_trains as number) || 0;
      const onTime = (r.on_time as number) || 0;
      return {
        month: r.month as string,
        totalTrains: total,
        punctuality: total > 0 ? Math.round((onTime / total) * 100) : 0,
        avgDelay: (r.avg_delay as number) || 0,
        cancelled: (r.cancelled as number) || 0,
      };
    });

    // ── By operator (from delay_snapshots, last 30 days) ───────────
    const operatorRows = await env.DB.prepare(`
      SELECT
        COALESCE(t.carrier, 'Nieznany') AS carrier,
        COUNT(DISTINCT ds.schedule_id || '-' || ds.order_id) AS train_count,
        ROUND(AVG(COALESCE(ds.arrival_delay, ds.departure_delay, 0)), 1) AS avg_delay,
        ROUND(
          100.0 * SUM(CASE WHEN COALESCE(ds.arrival_delay, ds.departure_delay, 0) <= 5 THEN 1 ELSE 0 END)
          / MAX(COUNT(*), 1),
          1
        ) AS punctuality
      FROM delay_snapshots ds
      LEFT JOIN trains t ON t.schedule_id = ds.schedule_id AND t.order_id = ds.order_id
      WHERE ds.operating_date >= date('now', '-30 days')
      GROUP BY carrier
      ORDER BY train_count DESC
      LIMIT 10
    `).all();

    const byOperator: OperatorStats[] = (operatorRows.results || []).map((r) => ({
      carrier: r.carrier as string,
      trainCount: (r.train_count as number) || 0,
      avgDelay: (r.avg_delay as number) || 0,
      punctuality: (r.punctuality as number) || 0,
    }));

    // ── By category (IC, TLK, REG, etc., last 30 days) ─────────────
    const categoryRows = await env.DB.prepare(`
      SELECT
        COALESCE(t.category, 'Inne') AS category,
        COUNT(DISTINCT ds.schedule_id || '-' || ds.order_id) AS train_count,
        ROUND(AVG(COALESCE(ds.arrival_delay, ds.departure_delay, 0)), 1) AS avg_delay,
        ROUND(
          100.0 * SUM(CASE WHEN COALESCE(ds.arrival_delay, ds.departure_delay, 0) <= 5 THEN 1 ELSE 0 END)
          / MAX(COUNT(*), 1),
          1
        ) AS punctuality
      FROM delay_snapshots ds
      LEFT JOIN trains t ON t.schedule_id = ds.schedule_id AND t.order_id = ds.order_id
      WHERE ds.operating_date >= date('now', '-30 days')
      GROUP BY category
      ORDER BY train_count DESC
    `).all();

    const byCategory: CategoryStats[] = (categoryRows.results || []).map((r) => ({
      category: r.category as string,
      trainCount: (r.train_count as number) || 0,
      avgDelay: (r.avg_delay as number) || 0,
      punctuality: (r.punctuality as number) || 0,
    }));

    const response: MonthlyResponse = { monthlyTrend, byOperator, byCategory };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch (err) {
    console.error('[api/stats/monthly] Error:', err);

    // Graceful: return empty structure
    return new Response(
      JSON.stringify({ monthlyTrend: [], byOperator: [], byCategory: [] }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      },
    );
  }
};
