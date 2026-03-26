// gtfs-static.ts — Load GTFS static stops data from mkuran.pl
//
// Fetches the polish_trains.zip GTFS feed, extracts stops.txt,
// parses station data, and loads it into D1 `stations` table.
// This maps station IDs to names and cities, enabling city-level queries.
//
// Data: https://mkuran.pl/gtfs/polish_trains.zip
// License: CC BY 4.0 (credit: mkuran.pl)
// Runs: daily at 02:00 (with aggregateDaily) + manual trigger

import { unzipSync } from 'fflate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	DB: D1Database;
	DELAYS_KV: KVNamespace;
	PKP_API_KEY: string;
	DATA_SOURCE?: string;
}

interface StopRecord {
	stop_id: string;
	stop_name: string;
	stop_lat: string;
	stop_lon: string;
	city: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GTFS_ZIP_URL = 'https://mkuran.pl/gtfs/polish_trains.zip';

/** Fetch timeout — 30 seconds */
const FETCH_TIMEOUT_MS = 30_000;

/** D1 batch limit */
const D1_BATCH_MAX = 100;

/** KV key to store station load metadata */
const STATIONS_META_KEY = 'gtfs:stations:meta';

/**
 * Multi-word city names that should NOT be split on first space.
 * Order matters — longer prefixes first to match greedily.
 */
const MULTI_WORD_CITIES: string[] = [
	'Bielsko-Biała',
	'Zielona Góra',
	'Jelenia Góra',
	'Nowy Sącz',
	'Nowy Dwór Mazowiecki',
	'Nowy Dwór Gdański',
	'Nowy Targ',
	'Stargard Szczeciński',
	'Kędzierzyn-Koźle',
	'Stalowa Wola',
	'Inowrocław-Rąbinek',
	'Dąbrowa Górnicza',
	'Gorzów Wielkopolski',
	'Piotrków Trybunalski',
	'Ruda Śląska',
	'Jastrzębie-Zdrój',
	'Ostrów Wielkopolski',
	'Tomaszów Mazowiecki',
];

// ---------------------------------------------------------------------------
// City extraction
// ---------------------------------------------------------------------------

/**
 * Extract the city name from a station name.
 *
 * Rules:
 * 1. Check multi-word city prefixes first (e.g. "Zielona Góra Główna" → "Zielona Góra")
 * 2. Otherwise, take the first word (e.g. "Warszawa Centralna" → "Warszawa")
 * 3. If station name is a single word, that's the city (e.g. "Tłuszcz" → "Tłuszcz")
 */
function extractCity(stationName: string): string {
	// Check multi-word city prefixes
	for (const prefix of MULTI_WORD_CITIES) {
		if (stationName === prefix || stationName.startsWith(prefix + ' ')) {
			return prefix;
		}
	}

	// Default: first word is the city
	const spaceIdx = stationName.indexOf(' ');
	if (spaceIdx === -1) return stationName;
	return stationName.substring(0, spaceIdx);
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into an array of objects.
 * Handles quoted fields (standard GTFS CSVs use them occasionally).
 */
function parseCSV(csv: string): Record<string, string>[] {
	const lines = csv.split('\n').filter((line) => line.trim().length > 0);
	if (lines.length < 2) return [];

	const headers = parseCSVLine(lines[0]);
	const records: Record<string, string>[] = [];

	for (let i = 1; i < lines.length; i++) {
		const values = parseCSVLine(lines[i]);
		if (values.length !== headers.length) continue; // skip malformed rows

		const record: Record<string, string> = {};
		for (let j = 0; j < headers.length; j++) {
			record[headers[j]] = values[j];
		}
		records.push(record);
	}

	return records;
}

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCSVLine(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];

		if (inQuotes) {
			if (ch === '"') {
				// Check for escaped quote ""
				if (i + 1 < line.length && line[i + 1] === '"') {
					current += '"';
					i++; // skip next quote
				} else {
					inQuotes = false;
				}
			} else {
				current += ch;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
			} else if (ch === ',') {
				fields.push(current.trim());
				current = '';
			} else {
				current += ch;
			}
		}
	}

	fields.push(current.trim());
	return fields;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch polish_trains.zip, extract stops.txt, parse it, and load stations into D1.
 *
 * Returns the number of stations loaded, or throws on failure.
 */
export async function loadStations(env: Env): Promise<number> {
	console.log('[gtfs-static] Starting station load from mkuran.pl GTFS');

	// 1. Fetch the ZIP
	let zipBuffer: ArrayBuffer;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		const res = await fetch(GTFS_ZIP_URL, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'niejedzie.pl/1.0 (train delay tracker)',
			},
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}

		zipBuffer = await res.arrayBuffer();
		console.log(`[gtfs-static] Downloaded ZIP: ${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			throw new Error(`ZIP download timed out after ${FETCH_TIMEOUT_MS}ms`);
		}
		throw new Error(`ZIP download failed: ${err}`);
	}

	// 2. Unzip and extract stops.txt
	let stopsCSV: string;

	try {
		const zipData = new Uint8Array(zipBuffer);
		const files = unzipSync(zipData);

		// Find stops.txt (might be at root or in a subdirectory)
		let stopsBytes: Uint8Array | undefined;
		for (const [name, data] of Object.entries(files)) {
			if (name === 'stops.txt' || name.endsWith('/stops.txt')) {
				stopsBytes = data;
				break;
			}
		}

		if (!stopsBytes) {
			const fileNames = Object.keys(files).join(', ');
			throw new Error(`stops.txt not found in ZIP. Files: ${fileNames}`);
		}

		stopsCSV = new TextDecoder('utf-8').decode(stopsBytes);
		console.log(`[gtfs-static] Extracted stops.txt: ${(stopsCSV.length / 1024).toFixed(1)} KB`);
	} catch (err) {
		throw new Error(`ZIP extraction failed: ${err}`);
	}

	// 3. Parse CSV
	const rawStops = parseCSV(stopsCSV);
	console.log(`[gtfs-static] Parsed ${rawStops.length} stops from CSV`);

	if (rawStops.length === 0) {
		throw new Error('stops.txt parsed to 0 records — check CSV format');
	}

	// Log the first record to verify column names
	const firstRecord = rawStops[0];
	console.log(`[gtfs-static] CSV columns: ${Object.keys(firstRecord).join(', ')}`);

	// 4. Map to StopRecord with city extraction
	const stops: StopRecord[] = rawStops.map((row) => ({
		stop_id: row.stop_id ?? row.id ?? '',
		stop_name: row.stop_name ?? row.name ?? '',
		stop_lat: row.stop_lat ?? row.lat ?? '0',
		stop_lon: row.stop_lon ?? row.lon ?? '0',
		city: extractCity(row.stop_name ?? row.name ?? ''),
	})).filter((s) => s.stop_id && s.stop_name);

	console.log(`[gtfs-static] Valid stops after filtering: ${stops.length}`);

	// Log some examples for verification
	const examples = stops.slice(0, 5).map((s) => `${s.stop_name} → city: ${s.city}`);
	console.log(`[gtfs-static] Examples: ${examples.join(' | ')}`);

	// 5. Batch INSERT OR REPLACE into D1 stations table
	const upsertStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO stations (station_id, name, city)
		VALUES (?, ?, ?)
	`);

	const stmts: D1PreparedStatement[] = stops.map((s) =>
		upsertStmt.bind(
			parseInt(s.stop_id, 10) || s.stop_id, // handle numeric or string IDs
			s.stop_name,
			s.city,
		),
	);

	// Execute in batches of D1_BATCH_MAX
	let executed = 0;
	for (let i = 0; i < stmts.length; i += D1_BATCH_MAX) {
		const chunk = stmts.slice(i, i + D1_BATCH_MAX);
		await env.DB.batch(chunk);
		executed += chunk.length;
	}

	console.log(`[gtfs-static] Loaded ${executed} stations into D1`);

	// 6. Store metadata in KV for verification
	const meta = {
		loadedAt: new Date().toISOString(),
		stationCount: executed,
		csvRows: rawStops.length,
		zipSizeMB: (zipBuffer.byteLength / 1024 / 1024).toFixed(1),
	};

	try {
		await env.DELAYS_KV.put(STATIONS_META_KEY, JSON.stringify(meta), {
			expirationTtl: 86400 * 7, // cache for 7 days
		});
	} catch (err) {
		console.warn(`[gtfs-static] KV meta write failed: ${err}`);
	}

	console.log(`[gtfs-static] Done — ${executed} stations loaded`);
	return executed;
}
