/**
 * GET /api/disruptions
 * Returns active rail disruptions.
 * Fast path: KV cache. Fallback: D1 disruptions table.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface Disruption {
  disruptionId: number;
  typeCode: string;
  startStation: string;
  endStation: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
}

const CACHE_TTL = 300; // 5 min — disruptions polled every 5 min

export const GET: APIRoute = async () => {
  try {
    // ── Fast path: KV cache ──────────────────────────────────────────
    const kvData = await env.DELAYS_KV.get('disruptions:active', 'json') as {
      disruptions?: Array<{
        disruptionId: number;
        disruptionTypeCode: string;
        startStation: string;
        endStation: string;
        message: string;
      }>;
    } | null;

    if (kvData?.disruptions) {
      const disruptions: Disruption[] = kvData.disruptions.map((d) => ({
        disruptionId: d.disruptionId,
        typeCode: d.disruptionTypeCode,
        startStation: d.startStation,
        endStation: d.endStation,
        message: d.message,
        firstSeen: '',
        lastSeen: '',
      }));

      return new Response(JSON.stringify({ disruptions }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      });
    }

    // ── Fallback: D1 ────────────────────────────────────────────────
    const rows = await env.DB.prepare(`
      SELECT
        disruption_id,
        type_code,
        start_station,
        end_station,
        message,
        first_seen,
        last_seen
      FROM disruptions
      WHERE is_active = 1
      ORDER BY last_seen DESC
    `).all();

    const disruptions: Disruption[] = (rows.results || []).map((r) => ({
      disruptionId: r.disruption_id as number,
      typeCode: (r.type_code as string) || '',
      startStation: (r.start_station as string) || '',
      endStation: (r.end_station as string) || '',
      message: (r.message as string) || '',
      firstSeen: (r.first_seen as string) || '',
      lastSeen: (r.last_seen as string) || '',
    }));

    return new Response(JSON.stringify({ disruptions }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch (err) {
    console.error('[api/disruptions] Error:', err);
    return new Response(
      JSON.stringify({ disruptions: [] }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
        },
      },
    );
  }
};
