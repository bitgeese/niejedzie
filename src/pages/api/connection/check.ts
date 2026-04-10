/**
 * GET /api/connection/check?train=IC+5313&destination=Kraków+Główny
 *
 * Checks if a train goes directly to a destination, or suggests connections.
 */

export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getPolandDate, formatTime } from '../../../lib/time-utils';

interface RouteStop {
  stopSequence: number;
  stopId: number;
  stationName: string;
  arrivalTime: string | null;
  departureTime: string | null;
}

interface Alternative {
  trainNumber: string;
  carrier: string;
  departureTime: string | null;
  arrivalTime: string | null;
  isDelayed: boolean;
  maxDelay: number;
}

interface ConnectionResponse {
  type: 'direct' | 'connection' | 'not_found' | 'no_route';
  train?: {
    trainNumber: string;
    carrier: string;
    isDelayed: boolean;
    maxDelay: number;
  };
  destination?: {
    stationId: number;
    stationName: string;
  };
  direct?: {
    arrivalTime: string | null;
    departureTime: string | null;
    stopSequence: number;
  };
  route?: RouteStop[];
  transfer?: {
    stationName: string;
    stationId: number;
    trainArrival: string | null;
  };
  alternatives?: Alternative[];
  message?: string;
}

const CACHE_TTL = 60;

export const GET: APIRoute = async ({ url }) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${CACHE_TTL}`,
  };

  try {
    const trainParam = url.searchParams.get('train')?.trim();
    const destParam = url.searchParams.get('destination')?.trim();

    if (!trainParam || !destParam) {
      return json({ type: 'not_found', message: 'Podaj numer pociągu i stację docelową' }, headers, 400);
    }

    const today = getPolandDate();

    // 1. Resolve train
    const numericPart = trainParam.replace(/^(IC|EIC|EIP|TLK|KS|KM|SKM|R|RE|IR|EN)\s*/i, '').trim();
    const trainRow = await env.DB.prepare(`
      SELECT train_number, carrier, is_delayed, max_delay
      FROM active_trains
      WHERE operating_date = ? AND (train_number LIKE ? OR train_number_numeric LIKE ?)
      LIMIT 1
    `).bind(today, `%${numericPart}%`, `%${numericPart}%`).first();

    if (!trainRow) {
      return json({ type: 'not_found', message: `Nie znaleziono pociągu "${trainParam}"` }, headers);
    }

    const trainNumber = trainRow.train_number as string;
    const trainInfo = {
      trainNumber,
      carrier: (trainRow.carrier as string) || (trainRow.agency_id as string) || '',
      isDelayed: (trainRow.is_delayed as number) === 1,
      maxDelay: (trainRow.max_delay as number) || 0,
    };

    // 2. Resolve destination station
    const destStation = await resolveStation(destParam);
    if (!destStation) {
      return json({
        type: 'not_found',
        train: trainInfo,
        message: `Nie znaleziono stacji "${destParam}"`,
      }, headers);
    }

    // 3. Get train's route
    const routeRows = await env.DB.prepare(`
      SELECT tr.stop_sequence, tr.stop_id, tr.arrival_time, tr.departure_time,
             s.name AS station_name
      FROM train_routes tr
      LEFT JOIN stations s ON s.station_id = tr.stop_id
      WHERE tr.operating_date = ? AND tr.train_number = ?
      ORDER BY tr.stop_sequence
    `).bind(today, trainNumber).all();

    if (!routeRows.results?.length) {
      return json({
        type: 'no_route',
        train: trainInfo,
        destination: destStation,
        message: 'Brak danych o trasie tego pociągu',
      }, headers);
    }

    const route: RouteStop[] = routeRows.results.map((r) => ({
      stopSequence: r.stop_sequence as number,
      stopId: r.stop_id as number,
      stationName: (r.station_name as string) || '',
      arrivalTime: formatIsoTime(r.arrival_time as string | null),
      departureTime: formatIsoTime(r.departure_time as string | null),
    }));

    // 4. Check if destination is on the route
    const destStop = route.find((s) => s.stopId === destStation.stationId);

    if (destStop) {
      // Direct train!
      return json({
        type: 'direct',
        train: trainInfo,
        destination: destStation,
        direct: {
          arrivalTime: destStop.arrivalTime,
          departureTime: destStop.departureTime,
          stopSequence: destStop.stopSequence,
        },
        route,
      }, headers);
    }

    // 5. Not direct — find connections from train's last stop
    const lastStop = route[route.length - 1];

    const alternatives = await findAlternatives(
      today,
      lastStop.stopId,
      destStation.stationId,
      lastStop.arrivalTime,
    );

    return json({
      type: 'connection',
      train: trainInfo,
      destination: destStation,
      route,
      transfer: {
        stationName: lastStop.stationName,
        stationId: lastStop.stopId,
        trainArrival: lastStop.arrivalTime,
      },
      alternatives,
      message: `Pociąg ${trainNumber} nie jedzie do ${destStation.stationName}. Kończy trasę w ${lastStop.stationName}.`,
    }, headers);
  } catch (err) {
    console.error('[api/connection/check] Error:', err);
    return json({ type: 'not_found', message: 'Wewnętrzny błąd serwera' }, headers, 500);
  }
};

// ── Helpers ──────────────────────────────────────────────────────

function json(data: ConnectionResponse, headers: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

/** Normalize time to HH:MM (reuses formatTime from time-utils) */
function formatIsoTime(t: string | null): string | null {
  return formatTime(t);
}

/**
 * Resolve a station name to station_id.
 * Prefers main stations (Główny/Centralna) over minor stops.
 */
async function resolveStation(
  name: string,
): Promise<{ stationId: number; stationName: string } | null> {
  // Exact match
  let row = await env.DB.prepare(
    `SELECT station_id, name FROM stations WHERE name = ? LIMIT 1`,
  ).bind(name).first();

  // Prefix match — prefer Główny/Centralna
  if (!row) {
    row = await env.DB.prepare(
      `SELECT station_id, name FROM stations WHERE name LIKE ?
       ORDER BY
         CASE WHEN name LIKE '%Główny%' OR name LIKE '%Główna%' OR name LIKE '%Centralna%' OR name LIKE '%Centralny%' THEN 0 ELSE 1 END,
         length(name)
       LIMIT 1`,
    ).bind(`${name}%`).first();
  }

  // Fuzzy match — same priority
  if (!row) {
    row = await env.DB.prepare(
      `SELECT station_id, name FROM stations WHERE name LIKE ?
       ORDER BY
         CASE WHEN name LIKE '%Główny%' OR name LIKE '%Główna%' OR name LIKE '%Centralna%' OR name LIKE '%Centralny%' THEN 0 ELSE 1 END,
         length(name)
       LIMIT 1`,
    ).bind(`%${name}%`).first();
  }

  if (!row) return null;
  return { stationId: row.station_id as number, stationName: row.name as string };
}

/** Find trains from transfer station to destination */
async function findAlternatives(
  date: string,
  transferStopId: number,
  destStopId: number,
  afterTime: string | null,
): Promise<Alternative[]> {
  // Find trains with delay data in a single query (no N+1)
  const rows = await env.DB.prepare(`
    SELECT DISTINCT tr1.train_number, tr1.departure_time, tr2.arrival_time,
           at.carrier, at.is_delayed, at.max_delay
    FROM train_routes tr1
    JOIN train_routes tr2
      ON tr1.train_number = tr2.train_number
      AND tr1.operating_date = tr2.operating_date
    LEFT JOIN active_trains at
      ON at.train_number = tr1.train_number
      AND at.operating_date = tr1.operating_date
    WHERE tr1.operating_date = ?
      AND tr1.stop_id = ?
      AND tr2.stop_id = ?
      AND tr1.stop_sequence < tr2.stop_sequence
    ORDER BY tr1.departure_time
    LIMIT 5
  `).bind(date, transferStopId, destStopId).all();

  if (!rows.results?.length) return [];

  return rows.results.map((r) => ({
    trainNumber: r.train_number as string,
    carrier: (r.carrier as string) || '',
    departureTime: formatIsoTime(r.departure_time as string | null),
    arrivalTime: formatIsoTime(r.arrival_time as string | null),
    isDelayed: (r.is_delayed as number) === 1,
    maxDelay: (r.max_delay as number) || 0,
  }));
}
