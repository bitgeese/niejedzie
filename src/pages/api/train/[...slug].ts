/**
 * GET /api/train/{scheduleId}/{orderId}/{date}
 * Returns single train detail with per-station delays.
 * Fast path: KV operations cache. Fallback: D1.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface StationDetail {
  name: string;
  plannedArr: string | null;
  actualArr: string | null;
  plannedDep: string | null;
  actualDep: string | null;
  delay: number;
  passed: boolean;
  current: boolean;
}

interface TrainResponse {
  train: {
    number: string;
    carrier: string;
    category: string;
    routeStart: string;
    routeEnd: string;
  };
  stations: StationDetail[];
}

const CACHE_TTL = 60; // 1 min — individual train checks can be more aggressive

export const GET: APIRoute = async ({ params }) => {
  try {
    const slug = params.slug;
    if (!slug) {
      return new Response(JSON.stringify({ error: 'Missing train identifier' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const parts = slug.split('/');
    if (parts.length < 3) {
      return new Response(
        JSON.stringify({ error: 'Expected format: /api/train/{scheduleId}/{orderId}/{date}' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const scheduleId = parseInt(parts[0], 10);
    const orderId = parseInt(parts[1], 10);
    const date = parts[2]; // YYYY-MM-DD

    if (isNaN(scheduleId) || isNaN(orderId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'Invalid parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Train metadata from D1 ─────────────────────────────────────
    const trainMeta = await env.DB.prepare(`
      SELECT train_number, carrier, category, route_start, route_end
      FROM trains
      WHERE schedule_id = ? AND order_id = ?
    `).bind(scheduleId, orderId).first();

    const trainInfo = {
      number: (trainMeta?.train_number as string) || `${scheduleId}/${orderId}`,
      carrier: (trainMeta?.carrier as string) || '',
      category: (trainMeta?.category as string) || '',
      routeStart: (trainMeta?.route_start as string) || '',
      routeEnd: (trainMeta?.route_end as string) || '',
    };

    // ── Try KV cache (operations:latest) ───────────────────────────
    const kvData = await env.DELAYS_KV.get('operations:latest', 'json') as {
      trains: Array<{
        scheduleId: number;
        orderId: number;
        stations: Array<{
          stationName: string;
          plannedArrival: string | null;
          actualArrival: string | null;
          plannedDeparture: string | null;
          actualDeparture: string | null;
          arrivalDelayMinutes: number | null;
          departureDelayMinutes: number | null;
          isConfirmed: boolean;
        }>;
      }>;
    } | null;

    if (kvData?.trains) {
      const match = kvData.trains.find(
        (t) => t.scheduleId === scheduleId && t.orderId === orderId,
      );

      if (match) {
        const stations = buildStationList(match.stations, date);
        const response: TrainResponse = { train: trainInfo, stations };

        return new Response(JSON.stringify(response), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        });
      }
    }

    // ── Fallback: D1 ───────────────────────────────────────────────
    const rows = await env.DB.prepare(`
      SELECT
        station_name,
        planned_arrival,
        actual_arrival,
        planned_departure,
        actual_departure,
        arrival_delay,
        departure_delay,
        is_confirmed,
        sequence_num
      FROM delay_snapshots
      WHERE schedule_id = ? AND order_id = ? AND operating_date = ?
      ORDER BY sequence_num ASC, recorded_at DESC
    `).bind(scheduleId, orderId, date).all();

    if (!rows.results?.length) {
      return new Response(
        JSON.stringify({ train: trainInfo, stations: [] }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=30',
          },
        },
      );
    }

    // Deduplicate: keep latest snapshot per station (sequence_num)
    const stationMap = new Map<number, typeof rows.results[0]>();
    for (const row of rows.results) {
      const seq = row.sequence_num as number;
      if (!stationMap.has(seq)) {
        stationMap.set(seq, row);
      }
    }

    const stations: StationDetail[] = Array.from(stationMap.values()).map((r) => {
      const delay = Math.max(
        (r.arrival_delay as number) || 0,
        (r.departure_delay as number) || 0,
      );
      const hasActual = r.actual_arrival !== null || r.actual_departure !== null;
      const isConfirmed = r.is_confirmed === 1;

      // CRITICAL FIX: Only mark as "passed" if actual time is in the past
      const actualTimeInPast = hasActual && isConfirmed &&
        isActualTimeInPast(r.actual_arrival as string | null, r.actual_departure as string | null, date);

      return {
        name: (r.station_name as string) || '',
        plannedArr: r.planned_arrival as string | null,
        actualArr: r.actual_arrival as string | null,
        plannedDep: r.planned_departure as string | null,
        actualDep: r.actual_departure as string | null,
        delay,
        passed: actualTimeInPast,
        current: false,
      };
    });

    // Mark the last "passed" station's next station as current
    const lastPassedIdx = stations.reduce((acc, s, i) => (s.passed ? i : acc), -1);
    if (lastPassedIdx >= 0 && lastPassedIdx < stations.length - 1) {
      stations[lastPassedIdx + 1].current = true;
    }

    const response: TrainResponse = { train: trainInfo, stations };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  } catch (err) {
    console.error('[api/train] Error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

// ── Helpers ────────────────────────────────────────────────────────────

function buildStationList(
  stations: Array<{
    stationName: string;
    plannedArrival: string | null;
    actualArrival: string | null;
    plannedDeparture: string | null;
    actualDeparture: string | null;
    arrivalDelayMinutes: number | null;
    departureDelayMinutes: number | null;
    isConfirmed: boolean;
  }>,
  operatingDate: string,
): StationDetail[] {
  const result: StationDetail[] = stations.map((s) => {
    const delay = Math.max(s.arrivalDelayMinutes ?? 0, s.departureDelayMinutes ?? 0);
    const hasActual = s.actualArrival !== null || s.actualDeparture !== null;

    // CRITICAL FIX: Only mark as "passed" if actual time is in the past
    const actualTimeInPast = hasActual && s.isConfirmed &&
      isActualTimeInPast(s.actualArrival, s.actualDeparture, operatingDate);

    return {
      name: s.stationName,
      plannedArr: s.plannedArrival,
      actualArr: s.actualArrival,
      plannedDep: s.plannedDeparture,
      actualDep: s.actualDeparture,
      delay,
      passed: actualTimeInPast,
      current: false,
    };
  });

  // Mark current station
  const lastPassedIdx = result.reduce((acc, s, i) => (s.passed ? i : acc), -1);
  if (lastPassedIdx >= 0 && lastPassedIdx < result.length - 1) {
    result[lastPassedIdx + 1].current = true;
  }

  return result;
}

/**
 * Checks if actual arrival/departure time is in the past compared to current Poland time.
 * Critical for preventing trains from showing as "passed" when they're actually in the future.
 */
function isActualTimeInPast(actualArr: string | null, actualDep: string | null, operatingDate: string): boolean {
  // Get the latest actual time (departure usually happens after arrival)
  const actualTime = actualDep || actualArr;
  if (!actualTime) return false;

  try {
    // Current time in Poland
    const now = new Date();
    const polandTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Warsaw"}));
    const currentHour = polandTime.getHours();
    const currentMinute = polandTime.getMinutes();

    // Parse actual time (format: "HH:MM" or "HH:MM:SS")
    const [hourStr, minuteStr] = actualTime.split(':');
    const actualHour = parseInt(hourStr, 10);
    const actualMinute = parseInt(minuteStr, 10);

    // Check if operating date is today
    const todayStr = [
      polandTime.getFullYear(),
      String(polandTime.getMonth() + 1).padStart(2, '0'),
      String(polandTime.getDate()).padStart(2, '0'),
    ].join('-');

    if (operatingDate !== todayStr) {
      // If data is from a different date, assume it's in the past
      return operatingDate < todayStr;
    }

    // Same day: compare times
    const actualTotalMinutes = actualHour * 60 + actualMinute;
    const currentTotalMinutes = currentHour * 60 + currentMinute;

    return actualTotalMinutes < currentTotalMinutes;
  } catch (error) {
    console.warn(`[train/detail] Time validation error for ${actualTime}:`, error);
    return false; // Safer to assume not passed if time parsing fails
  }
}
