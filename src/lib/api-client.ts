/**
 * PKP PLK API client
 * Wraps calls to pdp-api.plk-sa.pl with auth, retries, and typed responses.
 * Used by cron workers and API routes.
 */
import { env } from 'cloudflare:workers';

const PKP_BASE = 'https://pdp-api.plk-sa.pl/api/v1';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ── Types ──────────────────────────────────────────────────────────────

export interface PKPStation {
  stationId: number;
  stationName: string;
  sequenceNumber: number;
  plannedArrival: string | null;
  plannedDeparture: string | null;
  actualArrival: string | null;
  actualDeparture: string | null;
  arrivalDelayMinutes: number | null;
  departureDelayMinutes: number | null;
  isConfirmed: boolean;
  isCancelled: boolean;
}

export interface PKPTrain {
  scheduleId: number;
  orderId: number;
  trainNumber?: string;
  carrier?: string;
  category?: string;
  routeStart?: string;
  routeEnd?: string;
  stations: PKPStation[];
}

export interface PKPOperationsResponse {
  success: boolean;
  data: {
    trains: PKPTrain[];
  };
}

export interface PKPTrainDetailResponse {
  success: boolean;
  data: {
    scheduleId: number;
    orderId: number;
    trainNumber?: string;
    carrier?: string;
    category?: string;
    stations: PKPStation[];
  };
}

export interface PKPDisruption {
  disruptionId: number;
  disruptionTypeCode: string;
  startStation: string;
  endStation: string;
  message: string;
}

export interface PKPDisruptionsResponse {
  success: boolean;
  data: {
    disruptions: PKPDisruption[];
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = (env as Record<string, unknown>).PKP_API_KEY as string | undefined;
  return key ?? '';
}

async function pkpFetch<T>(path: string, retries = MAX_RETRIES): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null; // API key not yet activated

  const url = `${PKP_BASE}${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'X-API-Key': apiKey,
          'Accept': 'application/json',
        },
      });

      if (res.status === 429) {
        // Rate limited — wait and retry
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        console.error(`[pkp-api] Rate limited after ${retries + 1} attempts: ${url}`);
        return null;
      }

      if (!res.ok) {
        console.error(`[pkp-api] HTTP ${res.status} for ${url}`);
        return null;
      }

      return (await res.json()) as T;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      console.error(`[pkp-api] Fetch failed after ${retries + 1} attempts:`, err);
      return null;
    }
  }

  return null;
}

// ── Exported functions ─────────────────────────────────────────────────

/** Fetch all current train operations (real-time delays). */
export async function fetchOperations(): Promise<PKPOperationsResponse | null> {
  return pkpFetch<PKPOperationsResponse>('/operations?fullRoutes=true&withPlanned=true');
}

/** Fetch detail for a single train by scheduleId/orderId/date. */
export async function fetchTrainDetail(
  scheduleId: number,
  orderId: number,
  date: string,
): Promise<PKPTrainDetailResponse | null> {
  return pkpFetch<PKPTrainDetailResponse>(
    `/operations/train/${scheduleId}/${orderId}/${date}`,
  );
}

/** Fetch active disruptions. */
export async function fetchDisruptions(): Promise<PKPDisruptionsResponse | null> {
  return pkpFetch<PKPDisruptionsResponse>('/disruptions');
}
