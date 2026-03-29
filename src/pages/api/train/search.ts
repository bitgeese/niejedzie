/**
 * GET /api/train/search?q=35170
 * Searches D1 trains table, returns train + per-station delay data.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { formatTime, isActualTimeInPast, isPlannedTimeInPast } from '../../../lib/time-utils';

interface StationResult {
  name: string;
  plannedArr: string | null;
  plannedDep: string | null;
  actualArr: string | null;
  actualDep: string | null;
  delay: number;
  passed: boolean;
  current: boolean;
}

interface SearchResponse {
  train: {
    trainNumber: string;
    carrier: string;
    category: string;
    routeStart: string;
    routeEnd: string;
    scheduleId: number;
    orderId: number;
  } | null;
  stations: StationResult[];
  suggestions: string[];
  error?: string;
}

const CACHE_TTL = 60;

export const GET: APIRoute = async ({ url }) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${CACHE_TTL}`,
  };

  try {
    const q = url.searchParams.get('q')?.trim();

    if (!q || q.length < 2) {
      return new Response(
        JSON.stringify({
          error: 'Wpisz minimum 2 znaki',
          train: null,
          stations: [],
          suggestions: [],
        } satisfies SearchResponse),
        { status: 400, headers },
      );
    }

    // Strip common prefixes for numeric search — users may type "IC 35170" or just "35170"
    const numericPart = q.replace(/^(IC|EIC|TLK|KS|KM|SKM|R|RE|IR|EN)\s*/i, '').trim();
    const searchTerm = `%${numericPart}%`;

    // ── Search trains table ──────────────────────────────────────────
    const trainRows = await env.DB.prepare(`
      SELECT schedule_id, order_id, train_number, carrier, category, route_start, route_end
      FROM trains
      WHERE train_number LIKE ?
      LIMIT 5
    `).bind(searchTerm).all();

    if (!trainRows.results?.length) {
      return new Response(
        JSON.stringify({
          error: `Nie znaleziono pociągu "${q}"`,
          train: null,
          stations: [],
          suggestions: [],
        } satisfies SearchResponse),
        { headers },
      );
    }

    // Suggestions: all matching train numbers
    const suggestions = trainRows.results.map((r) => r.train_number as string);

    // Use the first match for detailed data
    const first = trainRows.results[0];
    const scheduleId = first.schedule_id as number;
    const orderId = first.order_id as number;
    const trainNumber = first.train_number as string;
    const carrier = first.carrier as string;
    const category = first.category as string;
    const routeStart = first.route_start as string;
    const routeEnd = first.route_end as string;

    const train = {
      trainNumber,
      carrier,
      category,
      routeStart,
      routeEnd,
      scheduleId,
      orderId,
    };

    // ── Get today's date in YYYY-MM-DD (Poland timezone) ─────────────
    const now = new Date();
    const polandTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Warsaw"}));
    const operatingDate = [
      polandTime.getFullYear(),
      String(polandTime.getMonth() + 1).padStart(2, '0'),
      String(polandTime.getDate()).padStart(2, '0'),
    ].join('-');

    // ── Query delay_snapshots for today ──────────────────────────────
    // Try ALL matching schedule_ids (scraper may generate different hashes on different days)
    // D1 bind() doesn't support spreading arrays into IN(), so we run multiple queries
    let snapshotRows: { results: any[] } = { results: [] };

    for (const row of trainRows.results) {
      const sid = row.schedule_id as number;
      const oid = row.order_id as number;
      const result = await env.DB.prepare(`
        SELECT station_name, planned_arrival, planned_departure, actual_arrival, actual_departure,
               arrival_delay, departure_delay, sequence_num, is_confirmed, is_cancelled, recorded_at,
               arrival_confidence, departure_confidence
        FROM delay_snapshots
        WHERE schedule_id = ? AND order_id = ? AND operating_date = ?
        ORDER BY sequence_num ASC, recorded_at DESC
      `).bind(sid, oid, operatingDate).all();

      if (result.results?.length > snapshotRows.results.length) {
        snapshotRows = result; // Use the schedule_id with the most data
      }
    }

    if (!snapshotRows.results?.length) {
      // Also try without date filter as fallback (show any recent data)
      for (const row of trainRows.results) {
        const sid = row.schedule_id as number;
        const oid = row.order_id as number;
        const fallback = await env.DB.prepare(`
          SELECT station_name, planned_arrival, planned_departure, actual_arrival, actual_departure,
                 arrival_delay, departure_delay, sequence_num, is_confirmed, is_cancelled, recorded_at
          FROM delay_snapshots
          WHERE schedule_id = ? AND order_id = ?
          ORDER BY sequence_num ASC, recorded_at DESC
          LIMIT 100
        `).bind(sid, oid).all();

        if (fallback.results?.length > snapshotRows.results.length) {
          snapshotRows = fallback;
        }
      }
    }

    if (!snapshotRows.results?.length) {
      return new Response(
        JSON.stringify({
          train,
          stations: [],
          suggestions,
          error: 'Brak danych o przejazdach',
        } satisfies SearchResponse),
        { headers },
      );
    }

    // Deduplicate by sequence_num — keep latest recorded_at per position
    // (Using station_name would collapse all null-named stations into one)
    const stationMap = new Map<number, typeof snapshotRows.results[0]>();
    for (const row of snapshotRows.results) {
      const seq = row.sequence_num as number;
      if (!stationMap.has(seq)) {
        stationMap.set(seq, row);
      }
      // rows are ordered by recorded_at DESC within same sequence_num,
      // so the first occurrence per sequence_num is already the latest
    }

    // Build station list, ordered by sequence_num
    const stationEntries = Array.from(stationMap.values()).sort(
      (a, b) => (a.sequence_num as number) - (b.sequence_num as number),
    );

    const stations: StationResult[] = stationEntries.map((r) => {
      const arrDelay = (r.arrival_delay as number) || 0;
      const depDelay = (r.departure_delay as number) || 0;
      const delay = Math.max(arrDelay, depDelay);
      const arrConfidence = (r.arrival_confidence as string) || 'planned';
      const depConfidence = (r.departure_confidence as string) || 'planned';
      const hasConfirmed = arrConfidence === 'confirmed' || depConfidence === 'confirmed';
      const hasActual = r.actual_arrival !== null || r.actual_departure !== null;

      // Primary: use confirmed actual times (CSS class + actual time + in past)
      let passed = hasConfirmed &&
        isActualTimeInPast(r.actual_arrival as string | null, r.actual_departure as string | null, operatingDate);

      // Secondary: use estimated actual times (actual time present but no CSS class)
      if (!passed && hasActual && !hasConfirmed) {
        passed = isActualTimeInPast(r.actual_arrival as string | null, r.actual_departure as string | null, operatingDate);
      }

      // Fallback: use planned time when no actual data available
      if (!passed && !hasActual) {
        passed = isPlannedTimeInPast(
          r.planned_departure as string | null,
          r.planned_arrival as string | null,
          operatingDate,
        );
      }

      return {
        name: (r.station_name as string) || '',
        plannedArr: formatTime(r.planned_arrival as string | null),
        plannedDep: formatTime(r.planned_departure as string | null),
        actualArr: formatTime(r.actual_arrival as string | null),
        actualDep: formatTime(r.actual_departure as string | null),
        delay,
        passed,
        current: false,
      };
    });

    // Mark the last passed station as current
    const lastPassedIdx = stations.reduce((acc, s, i) => (s.passed ? i : acc), -1);
    if (lastPassedIdx >= 0) {
      stations[lastPassedIdx].current = true;
    }

    // DATA FRESHNESS CHECK: Warn if data appears stale
    const dataFreshness = validateDataFreshness(stations, operatingDate);

    const response: SearchResponse & { _debug?: any } = { train, stations, suggestions };
    response._debug = {
      matchCount: trainRows.results.length,
      scheduleIds: trainRows.results.map(r => r.schedule_id),
      operatingDate,
      rawSnapshotCount: snapshotRows.results.length,
      dataFreshness,
    };
    return new Response(JSON.stringify(response), { headers });
  } catch (err) {
    console.error('[api/train/search] Error:', err);
    return new Response(
      JSON.stringify({
        error: 'Wewnętrzny błąd serwera',
        train: null,
        stations: [],
        suggestions: [],
      } satisfies SearchResponse),
      { status: 500, headers },
    );
  }
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Validates data freshness and detects potential stale data issues
 */
function validateDataFreshness(stations: StationResult[], operatingDate: string) {
  const now = new Date();
  const polandTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Warsaw"}));
  const todayStr = [
    polandTime.getFullYear(),
    String(polandTime.getMonth() + 1).padStart(2, '0'),
    String(polandTime.getDate()).padStart(2, '0'),
  ].join('-');

  const isToday = operatingDate === todayStr;
  const passedCount = stations.filter(s => s.passed).length;
  const futureActualTimes = stations.filter(s =>
    s.passed === false && (s.actualArr || s.actualDep)
  ).length;

  return {
    isToday,
    operatingDate,
    currentDate: todayStr,
    passedStations: passedCount,
    futureActualTimes,
    warning: futureActualTimes > 0 ? 'Data contains future actual times - possible stale data' : null,
  };
}

