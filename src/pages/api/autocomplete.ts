/**
 * GET /api/autocomplete?q=Warsz&type=station
 * GET /api/autocomplete?q=3517&type=train
 * GET /api/autocomplete?q=IC 35&type=all
 *
 * Fast autocomplete for station names and train numbers.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getPolandDate } from '../../lib/time-utils';

interface Suggestion {
  text: string;
  type: 'train' | 'station';
  detail?: string;
}

export const GET: APIRoute = async ({ url }) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  try {
    const q = url.searchParams.get('q')?.trim();
    const type = url.searchParams.get('type') || 'all';

    if (!q || q.length < 2) {
      return new Response(JSON.stringify({ suggestions: [] }), { headers });
    }

    const suggestions: Suggestion[] = [];
    const searchTerm = `${q}%`;

    // Search trains
    if (type === 'all' || type === 'train') {
      const trains = await env.DB.prepare(`
        SELECT DISTINCT train_number, carrier, route_start, route_end
        FROM trains
        WHERE train_number LIKE ?
        ORDER BY train_number
        LIMIT 5
      `).bind(searchTerm).all();

      for (const t of trains.results) {
        const num = t.train_number as string;
        const start = t.route_start as string;
        const end = t.route_end as string;
        suggestions.push({
          text: num,
          type: 'train',
          detail: start && end ? `${start} → ${end}` : undefined,
        });
      }

      // Also try with stripped prefix (user types "35" → find "IC 35...")
      if (trains.results.length === 0 && /^\d/.test(q)) {
        const numTrains = await env.DB.prepare(`
          SELECT DISTINCT train_number, carrier, route_start, route_end
          FROM trains
          WHERE train_number LIKE ?
          ORDER BY train_number
          LIMIT 5
        `).bind(`%${q}%`).all();

        for (const t of numTrains.results) {
          suggestions.push({
            text: t.train_number as string,
            type: 'train',
            detail: (t.route_start && t.route_end)
              ? `${t.route_start} → ${t.route_end}`
              : undefined,
          });
        }
      }

      // Also check active_trains (GTFS-RT roster) for on-time trains
      const today = getPolandDate();

      const activeTrains = await env.DB.prepare(`
        SELECT DISTINCT train_number, carrier
        FROM active_trains
        WHERE operating_date = ? AND (train_number LIKE ? OR train_number_numeric LIKE ?)
        ORDER BY train_number_numeric
        LIMIT 15
      `).bind(today, `${q}%`, `${q}%`).all();

      const existingNums = new Set(suggestions.filter(s => s.type === 'train').map(s => s.text));
      for (const t of activeTrains.results) {
        const num = t.train_number as string;
        if (existingNums.has(num)) continue;
        suggestions.push({
          text: num,
          type: 'train',
          detail: (t.carrier as string) || (t.agency_id as string) || undefined,
        });
      }
    }

    // Search stations
    if (type === 'all' || type === 'station') {
      const stations = await env.DB.prepare(`
        SELECT DISTINCT name, city
        FROM stations
        WHERE name LIKE ?
        ORDER BY name
        LIMIT 8
      `).bind(searchTerm).all();

      for (const s of stations.results) {
        suggestions.push({
          text: s.name as string,
          type: 'station',
          detail: s.city as string,
        });
      }
    }

    return new Response(JSON.stringify({ suggestions }), { headers });
  } catch (err) {
    console.error('[autocomplete] Error:', err);
    return new Response(JSON.stringify({ suggestions: [] }), { status: 500, headers });
  }
};
