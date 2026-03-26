// gtfs-rt.ts — mkuran.pl GTFS-RT data source for niejedzie.pl
//
// Fetches real-time train data from the mkuran.pl GTFS-RT JSON feed.
// This feed covers ALL Polish trains (~14K entries), not just delayed ones.
// Used to get accurate total train counts per agency for punctuality calculation.
//
// Data: https://mkuran.pl/gtfs/polish_trains/updates.json
// License: CC BY 4.0 (credit: mkuran.pl)
// Size: ~35MB JSON — parsed selectively to avoid OOM in Workers (128MB limit).

// ---------------------------------------------------------------------------
// Types (re-declared to avoid circular imports — same pattern as scraper.ts)
// ---------------------------------------------------------------------------

interface Env {
	DB: D1Database;
	DELAYS_KV: KVNamespace;
	PKP_API_KEY: string;
	DATA_SOURCE?: string;
}

/** Shape of a single stop_time in the GTFS-RT feed */
interface GtfsStopTime {
	stop_sequence: number;
	arrival: string | null;   // ISO 8601 datetime or null
	departure: string | null; // ISO 8601 datetime or null
	platform: string | null;
	track: string | null;
}

/** Shape of a single trip_update in the GTFS-RT feed */
interface GtfsTripUpdate {
	id: string;
	trip_id: string;
	start_date: string;
	agency_id: string;
	numbers: string[];
	stop_times: GtfsStopTime[];
}

/** Top-level response from mkuran.pl updates.json */
interface GtfsRtResponse {
	timestamp: string;
	trip_updates: GtfsTripUpdate[];
}

/** Aggregated stats returned by fetchGtfsRtStats */
export interface GtfsRtStats {
	totalTrains: number;
	byAgency: Record<string, number>;
	timestamp: string;
	fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GTFS_RT_URL = 'https://mkuran.pl/gtfs/polish_trains/updates.json';

/** KV cache key for GTFS-RT stats */
const STATS_CACHE_KEY = 'gtfs:stats';

/** KV cache TTL — 3 minutes (matches the cron poll interval) */
const STATS_CACHE_TTL = 180;

/** Fetch timeout — 25 seconds (Workers have 30s wall-clock on paid plan) */
const FETCH_TIMEOUT_MS = 25_000;

/**
 * Agencies we care about for total train count.
 * Covers all significant passenger rail operators in Poland.
 */
const TARGET_AGENCIES = new Set([
	'IC',    // PKP Intercity (EIC, EIP, IC, TLK)
	'PR',    // PolRegio
	'KM',    // Koleje Mazowieckie
	'SKM',   // SKM Trójmiasto
	'SKMT',  // SKM Warszawa
	'KD',    // Koleje Dolnośląskie
	'KS',    // Koleje Śląskie
	'KW',    // Koleje Wielkopolskie
	'LKA',   // Łódzka Kolej Aglomeracyjna
	'KML',   // Koleje Małopolskie
	'AR',    // Arriva RP
	'RJ',    // RegioJet
	'LEO',   // Leo Express
]);

/** Human-readable agency names */
const AGENCY_NAMES: Record<string, string> = {
	IC:   'PKP Intercity',
	PR:   'PolRegio',
	KM:   'Koleje Mazowieckie',
	SKM:  'SKM Trójmiasto',
	SKMT: 'SKM Warszawa',
	KD:   'Koleje Dolnośląskie',
	KS:   'Koleje Śląskie',
	KW:   'Koleje Wielkopolskie',
	LKA:  'Łódzka Kolej Aglomeracyjna',
	KML:  'Koleje Małopolskie',
	AR:   'Arriva RP',
	RJ:   'RegioJet',
	LEO:  'Leo Express',
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch aggregate train stats from the mkuran.pl GTFS-RT feed.
 *
 * Returns total train count and per-agency breakdown. Results are cached
 * in KV for STATS_CACHE_TTL seconds to avoid hammering the upstream feed.
 *
 * On failure (network error, OOM, timeout), returns null — callers should
 * fall back to scraper-only stats.
 */
export async function fetchGtfsRtStats(env: Env): Promise<GtfsRtStats | null> {
	// 1. Check KV cache first
	try {
		const cached = await env.DELAYS_KV.get(STATS_CACHE_KEY);
		if (cached) {
			const parsed: GtfsRtStats = JSON.parse(cached);
			console.log(
				`[gtfs-rt] Using cached stats — ${parsed.totalTrains} trains, fetched at ${parsed.fetchedAt}`,
			);
			return parsed;
		}
	} catch {
		// Cache read failed — proceed to fetch
	}

	// 2. Fetch the feed with a timeout
	console.log('[gtfs-rt] Fetching mkuran.pl GTFS-RT feed');
	let res: Response;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		res = await fetch(GTFS_RT_URL, {
			signal: controller.signal,
			headers: {
				'Accept': 'application/json',
				'User-Agent': 'niejedzie.pl/1.0 (train delay tracker)',
			},
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			console.error(`[gtfs-rt] HTTP error: ${res.status} ${res.statusText}`);
			return null;
		}
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			console.error(`[gtfs-rt] Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
		} else {
			console.error(`[gtfs-rt] Fetch failed: ${err}`);
		}
		return null;
	}

	// 3. Parse JSON — this is the risky part (~35MB → ~100-200MB in memory).
	//    Wrap in try/catch to handle OOM gracefully.
	let data: GtfsRtResponse;

	try {
		data = await res.json() as GtfsRtResponse;
	} catch (err) {
		console.error(`[gtfs-rt] JSON parse failed (possible OOM): ${err}`);
		return null;
	}

	if (!data.trip_updates || !Array.isArray(data.trip_updates)) {
		console.error('[gtfs-rt] Invalid response structure — missing trip_updates array');
		return null;
	}

	// 4. Count trains by agency — only process target agencies
	const byAgency: Record<string, number> = {};
	let totalTrains = 0;

	for (const update of data.trip_updates) {
		if (!TARGET_AGENCIES.has(update.agency_id)) {
			continue;
		}

		totalTrains++;
		byAgency[update.agency_id] = (byAgency[update.agency_id] || 0) + 1;
	}

	const stats: GtfsRtStats = {
		totalTrains,
		byAgency,
		timestamp: data.timestamp || new Date().toISOString(),
		fetchedAt: new Date().toISOString(),
	};

	console.log(
		`[gtfs-rt] Parsed ${data.trip_updates.length} total entries, ` +
		`${totalTrains} from target agencies ` +
		`(${Object.entries(byAgency).map(([k, v]) => `${k}:${v}`).join(', ')})`,
	);

	// 5. Cache in KV
	try {
		await env.DELAYS_KV.put(STATS_CACHE_KEY, JSON.stringify(stats), {
			expirationTtl: STATS_CACHE_TTL,
		});
	} catch (err) {
		console.warn(`[gtfs-rt] KV cache write failed: ${err}`);
		// Non-fatal — still return the stats
	}

	return stats;
}

/**
 * Get the human-readable name for an agency code.
 */
export function getAgencyName(agencyId: string): string {
	return AGENCY_NAMES[agencyId] || agencyId;
}
