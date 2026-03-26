// niejedzie-cron — Cloudflare Worker cron for polling PKP PLK API
//
// Cron schedules:
//   every 2 min   — pollOperations (current train delays -> D1 + KV)
//   every 5 min   — pollDisruptions (active disruptions -> D1 + KV)
//   0 2 * * *     — aggregateDaily (yesterday's stats -> D1, prune old data)

import { fetchFromScraper } from './scraper';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	DB: D1Database;
	DELAYS_KV: KVNamespace;
	PKP_API_KEY: string;
	DATA_SOURCE?: string; // 'api' | 'scraper' | 'auto'
}

/** Shape of a single station entry returned by /operations */
interface ApiStation {
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

/** Shape of a single train entry returned by /operations */
interface ApiTrain {
	scheduleId: number;
	orderId: number;
	trainNumber?: string;
	carrier?: string;
	category?: string;
	routeStartStation?: string;
	routeEndStation?: string;
	stations: ApiStation[];
}

/** Top-level /operations response */
interface OperationsResponse {
	success: boolean;
	data: {
		trains: ApiTrain[];
		totalCount?: number;
		pageNumber?: number;
		pageSize?: number;
		totalPages?: number;
	};
}

/** Single disruption from /disruptions */
interface ApiDisruption {
	disruptionId: number;
	disruptionTypeCode: string;
	startStation: string;
	endStation: string;
	message: string;
}

/** Top-level /disruptions response */
interface DisruptionsResponse {
	success: boolean;
	data: {
		disruptions: ApiDisruption[];
	};
}

/** Schedule route metadata response */
interface ScheduleRouteResponse {
	success: boolean;
	data: {
		trainNumber: string;
		carrier: string;
		category: string;
		routeStartStation: string;
		routeEndStation: string;
	};
}

/** Monitoring session row from D1 */
interface MonitoringSession {
	id: string;
	push_subscription: string;
	train_a_schedule_id: number;
	train_a_order_id: number;
	transfer_station_id: number;
	train_b_schedule_id: number;
	train_b_order_id: number;
	operating_date: string;
	status: string;
	last_checked: string | null;
}

/** KV stats shape */
interface TodayStats {
	timestamp: string;
	totalTrains: number;
	avgDelay: number;
	punctualityPct: number;
	cancelledCount: number;
	onTimeCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PKP_API_BASE = "https://pdp-api.plk-sa.pl";
const D1_BATCH_MAX = 100;
const MAJOR_CITIES = [
	"Warszawa",
	"Kraków",
	"Gdańsk",
	"Wrocław",
	"Poznań",
	"Katowice",
	"Szczecin",
	"Łódź",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayDateStr(): string {
	return new Date().toISOString().split("T")[0];
}

function yesterdayDateStr(): string {
	return new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
}

/** Typed fetch wrapper for PKP PLK API with error handling */
async function pkpFetch<T>(
	path: string,
	apiKey: string,
	params?: Record<string, string>,
): Promise<T | null> {
	const url = new URL(path, PKP_API_BASE);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}
	}

	const res = await fetch(url.toString(), {
		headers: {
			"X-API-Key": apiKey,
			Accept: "application/json",
		},
	});

	if (!res.ok) {
		console.error(
			`PKP API error: ${res.status} ${res.statusText} for ${url.pathname}`,
		);
		return null;
	}

	return res.json() as Promise<T>;
}

/**
 * Execute an array of D1 prepared statements in batches of D1_BATCH_MAX.
 * Returns total number of statements executed.
 */
async function batchExecute(
	db: D1Database,
	statements: D1PreparedStatement[],
): Promise<number> {
	let executed = 0;
	for (let i = 0; i < statements.length; i += D1_BATCH_MAX) {
		const chunk = statements.slice(i, i + D1_BATCH_MAX);
		await db.batch(chunk);
		executed += chunk.length;
	}
	return executed;
}

// ---------------------------------------------------------------------------
// pollOperations — runs every 2 minutes
// ---------------------------------------------------------------------------

async function pollOperations(env: Env): Promise<void> {
	const today = todayDateStr();
	const source = env.DATA_SOURCE || 'auto';
	console.log(`[pollOperations] Starting poll for ${today} (source: ${source})`);

	// 1. Fetch all current operations (handle pagination)
	let allTrains: ApiTrain[] = [];

	// Try official API first (if key available and not forced to scraper)
	if (source !== 'scraper' && env.PKP_API_KEY) {
		let page = 1;
		const pageSize = 500;

		while (true) {
			const res = await pkpFetch<OperationsResponse>(
				"/api/v1/operations",
				env.PKP_API_KEY,
				{
					fullRoutes: "true",
					withPlanned: "true",
					pageNumber: String(page),
					pageSize: String(pageSize),
				},
			);

			if (!res || !res.success || !res.data?.trains?.length) {
				if (page === 1) {
					console.warn("[pollOperations] No data from API on first page");
				}
				break;
			}

			allTrains = allTrains.concat(res.data.trains);

			// Check if there are more pages
			const totalPages = res.data.totalPages ?? 1;
			if (page >= totalPages) break;
			page++;
		}

		if (allTrains.length > 0) {
			console.log(`[pollOperations] Fetched ${allTrains.length} trains from API`);
		}
	}

	// Fall back to scraper (if API failed/empty or forced to scraper)
	if (allTrains.length === 0 && source !== 'api') {
		console.log('[pollOperations] Using Portal Pasażera scraper');
		try {
			const scraped = await fetchFromScraper(env);
			if (scraped && scraped.length > 0) {
				allTrains = scraped;
				console.log(`[pollOperations] Fetched ${allTrains.length} trains from scraper`);
			}
		} catch (err) {
			console.error(`[pollOperations] Scraper failed: ${err}`);
		}
	}

	if (allTrains.length === 0) {
		console.warn('[pollOperations] No data from any source');
		return;
	}

	console.log(`[pollOperations] Processing ${allTrains.length} trains total`);

	// 2. Write latest snapshot to KV (hot cache for frontend)
	await env.DELAYS_KV.put(
		"operations:latest",
		JSON.stringify({
			timestamp: new Date().toISOString(),
			trainCount: allTrains.length,
			trains: allTrains,
		}),
		{ expirationTtl: 180 },
	);

	// 3. Compute summary stats → KV
	let totalDelay = 0;
	let delayCount = 0;
	let onTimeCount = 0;
	let cancelledCount = 0;
	const trainIds = new Set<string>();

	for (const train of allTrains) {
		const trainKey = `${train.scheduleId}-${train.orderId}`;
		if (trainIds.has(trainKey)) continue;
		trainIds.add(trainKey);

		// Use the last station with actual data to determine train-level stats
		let trainMaxDelay = 0;
		let trainCancelled = false;

		for (const st of train.stations) {
			const delay = st.arrivalDelayMinutes ?? st.departureDelayMinutes ?? 0;
			if (delay > trainMaxDelay) trainMaxDelay = delay;
			if (st.isCancelled) trainCancelled = true;

			if (st.arrivalDelayMinutes !== null || st.departureDelayMinutes !== null) {
				totalDelay += delay;
				delayCount++;
			}
		}

		if (trainCancelled) {
			cancelledCount++;
		} else if (trainMaxDelay <= 5) {
			onTimeCount++;
		}
	}

	const totalTrains = trainIds.size;
	const avgDelay = delayCount > 0 ? Math.round((totalDelay / delayCount) * 10) / 10 : 0;
	const punctualityPct =
		totalTrains > 0
			? Math.round((onTimeCount / totalTrains) * 1000) / 10
			: 0;

	const todayStats: TodayStats = {
		timestamp: new Date().toISOString(),
		totalTrains,
		avgDelay,
		punctualityPct,
		cancelledCount,
		onTimeCount,
	};

	await env.DELAYS_KV.put("stats:today", JSON.stringify(todayStats), {
		expirationTtl: 180,
	});

	console.log(
		`[pollOperations] Stats — trains: ${totalTrains}, onTime: ${onTimeCount}, ` +
			`avgDelay: ${avgDelay}min, cancelled: ${cancelledCount}, punctuality: ${punctualityPct}%`,
	);

	// 4. Batch INSERT OR REPLACE into delay_snapshots
	const insertStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO delay_snapshots
			(schedule_id, order_id, operating_date, station_id, station_name,
			 sequence_num, planned_arrival, planned_departure, actual_arrival,
			 actual_departure, arrival_delay, departure_delay, is_confirmed, is_cancelled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const batch: D1PreparedStatement[] = [];
	for (const train of allTrains) {
		for (const st of train.stations) {
			batch.push(
				insertStmt.bind(
					train.scheduleId,
					train.orderId,
					today,
					st.stationId,
					st.stationName,
					st.sequenceNumber,
					st.plannedArrival,
					st.plannedDeparture,
					st.actualArrival,
					st.actualDeparture,
					st.arrivalDelayMinutes,
					st.departureDelayMinutes,
					st.isConfirmed ? 1 : 0,
					st.isCancelled ? 1 : 0,
				),
			);
		}
	}

	const inserted = await batchExecute(env.DB, batch);
	console.log(`[pollOperations] Wrote ${inserted} station snapshots to D1`);

	// 5. Backfill train metadata for any new schedule_id/order_id combos
	await backfillTrainMetadata(env, allTrains, today);

	// 6. Check active monitoring sessions
	await checkMonitoringSessions(env, allTrains);
}

// ---------------------------------------------------------------------------
// backfillTrainMetadata — fetch /schedules for unknown trains
// ---------------------------------------------------------------------------

async function backfillTrainMetadata(
	env: Env,
	trains: ApiTrain[],
	today: string,
): Promise<void> {
	// Deduplicate by schedule_id + order_id
	const uniqueTrains = new Map<string, ApiTrain>();
	for (const t of trains) {
		const key = `${t.scheduleId}-${t.orderId}`;
		if (!uniqueTrains.has(key)) {
			uniqueTrains.set(key, t);
		}
	}

	// Check which ones we already have in the trains table
	// Query in batches to avoid huge IN clauses
	const keys = Array.from(uniqueTrains.keys());
	const existingKeys = new Set<string>();

	for (let i = 0; i < keys.length; i += 50) {
		const chunk = keys.slice(i, i + 50);
		const placeholders = chunk.map(() => "(?, ?)").join(", ");
		const binds: (number | string)[] = [];
		for (const k of chunk) {
			const [sid, oid] = k.split("-");
			binds.push(Number(sid), Number(oid));
		}

		const result = await env.DB.prepare(
			`SELECT schedule_id || '-' || order_id AS k FROM trains WHERE (schedule_id, order_id) IN (${placeholders})`,
		)
			.bind(...binds)
			.all();

		for (const row of result.results) {
			existingKeys.add(row.k as string);
		}
	}

	// Fetch metadata for missing trains
	const missing = keys.filter((k) => !existingKeys.has(k));
	if (missing.length === 0) return;

	console.log(
		`[backfillTrainMetadata] Fetching metadata for ${missing.length} new trains`,
	);

	const upsertStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO trains
			(schedule_id, order_id, train_number, carrier, category, route_start, route_end, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`);

	const stmts: D1PreparedStatement[] = [];

	// Limit to 20 per poll cycle to stay within rate limits
	const toFetch = missing.slice(0, 20);

	for (const key of toFetch) {
		const train = uniqueTrains.get(key)!;

		// If the operations response already contains train metadata, use it directly
		if (train.trainNumber) {
			stmts.push(
				upsertStmt.bind(
					train.scheduleId,
					train.orderId,
					train.trainNumber,
					train.carrier ?? null,
					train.category ?? null,
					train.routeStartStation ?? null,
					train.routeEndStation ?? null,
				),
			);
			continue;
		}

		// Otherwise, fetch from /schedules endpoint
		try {
			const meta = await pkpFetch<ScheduleRouteResponse>(
				`/api/v1/schedules/route/${train.scheduleId}/${train.orderId}`,
				env.PKP_API_KEY,
				{ date: today },
			);

			if (meta?.success && meta.data) {
				stmts.push(
					upsertStmt.bind(
						train.scheduleId,
						train.orderId,
						meta.data.trainNumber ?? "unknown",
						meta.data.carrier ?? null,
						meta.data.category ?? null,
						meta.data.routeStartStation ?? null,
						meta.data.routeEndStation ?? null,
					),
				);
			}
		} catch (err) {
			console.error(
				`[backfillTrainMetadata] Failed for ${key}: ${err}`,
			);
			// Don't let one failure crash the batch
		}
	}

	if (stmts.length > 0) {
		await batchExecute(env.DB, stmts);
		console.log(
			`[backfillTrainMetadata] Upserted ${stmts.length} train records`,
		);
	}
}

// ---------------------------------------------------------------------------
// pollDisruptions — runs every 5 minutes
// ---------------------------------------------------------------------------

async function pollDisruptions(env: Env): Promise<void> {
	console.log("[pollDisruptions] Starting");

	const res = await pkpFetch<DisruptionsResponse>(
		"/api/v1/disruptions",
		env.PKP_API_KEY,
	);

	if (!res || !res.success || !res.data?.disruptions) {
		console.warn("[pollDisruptions] No data from API");
		return;
	}

	const disruptions = res.data.disruptions;
	console.log(`[pollDisruptions] Fetched ${disruptions.length} disruptions`);

	// 1. Write to KV (hot cache for frontend)
	await env.DELAYS_KV.put(
		"disruptions:active",
		JSON.stringify({
			timestamp: new Date().toISOString(),
			disruptions,
		}),
		{ expirationTtl: 600 },
	);

	// 2. Upsert each disruption into D1
	const upsertStmt = env.DB.prepare(`
		INSERT INTO disruptions (disruption_id, type_code, start_station, end_station, message, last_seen, is_active)
		VALUES (?, ?, ?, ?, ?, datetime('now'), 1)
		ON CONFLICT(disruption_id) DO UPDATE SET
			type_code = excluded.type_code,
			start_station = excluded.start_station,
			end_station = excluded.end_station,
			message = excluded.message,
			last_seen = datetime('now'),
			is_active = 1
	`);

	const stmts: D1PreparedStatement[] = disruptions.map((d) =>
		upsertStmt.bind(
			d.disruptionId,
			d.disruptionTypeCode,
			d.startStation,
			d.endStation,
			d.message,
		),
	);

	await batchExecute(env.DB, stmts);

	// 3. Mark disruptions NOT in current response as inactive
	if (disruptions.length > 0) {
		const activeIds = disruptions.map((d) => d.disruptionId);
		const placeholders = activeIds.map(() => "?").join(", ");

		await env.DB.prepare(
			`UPDATE disruptions SET is_active = 0 WHERE is_active = 1 AND disruption_id NOT IN (${placeholders})`,
		)
			.bind(...activeIds)
			.run();
	} else {
		// No active disruptions — mark all as inactive
		await env.DB.prepare(
			`UPDATE disruptions SET is_active = 0 WHERE is_active = 1`,
		).run();
	}

	console.log("[pollDisruptions] Done");
}

// ---------------------------------------------------------------------------
// aggregateDaily — runs daily at 02:00 UTC
// ---------------------------------------------------------------------------

async function aggregateDaily(env: Env): Promise<void> {
	const yesterday = yesterdayDateStr();
	console.log(`[aggregateDaily] Aggregating data for ${yesterday}`);

	// 1. Compute daily_stats from delay_snapshots
	// Use the latest snapshot per train (max sequence_num) to determine train-level status
	const stats = await env.DB.prepare(`
		SELECT
			COUNT(DISTINCT schedule_id || '-' || order_id) AS total_trains,
			AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay,
			SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) <= 5 AND is_cancelled = 0 THEN 1 ELSE 0 END) AS on_time_stations,
			SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END) AS cancelled_stations,
			COUNT(*) AS total_stations,
			SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 0 AND 5 THEN 1 ELSE 0 END) AS delay_0_5,
			SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 6 AND 15 THEN 1 ELSE 0 END) AS delay_6_15,
			SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 16 AND 30 THEN 1 ELSE 0 END) AS delay_16_30,
			SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) BETWEEN 31 AND 60 THEN 1 ELSE 0 END) AS delay_31_60,
			SUM(CASE WHEN COALESCE(arrival_delay, departure_delay, 0) > 60 THEN 1 ELSE 0 END) AS delay_60_plus
		FROM delay_snapshots
		WHERE operating_date = ?
	`)
		.bind(yesterday)
		.first();

	if (!stats || (stats.total_trains as number) === 0) {
		console.warn(`[aggregateDaily] No snapshots found for ${yesterday}`);
		return;
	}

	// Compute train-level on-time and cancelled counts
	const trainStats = await env.DB.prepare(`
		SELECT
			schedule_id || '-' || order_id AS train_key,
			MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay,
			MAX(is_cancelled) AS was_cancelled
		FROM delay_snapshots
		WHERE operating_date = ?
		GROUP BY schedule_id, order_id
	`)
		.bind(yesterday)
		.all();

	let onTimeTrains = 0;
	let cancelledTrains = 0;
	const totalTrains = trainStats.results.length;

	for (const row of trainStats.results) {
		if ((row.was_cancelled as number) === 1) {
			cancelledTrains++;
		} else if ((row.max_delay as number) <= 5) {
			onTimeTrains++;
		}
	}

	const punctualityPct =
		totalTrains > 0
			? Math.round((onTimeTrains / totalTrains) * 1000) / 10
			: 0;

	await env.DB.prepare(`
		INSERT OR REPLACE INTO daily_stats
			(date, total_trains, on_time_count, punctuality_pct, avg_delay, cancelled_count,
			 delay_0_5, delay_6_15, delay_16_30, delay_31_60, delay_60_plus)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
		.bind(
			yesterday,
			totalTrains,
			onTimeTrains,
			punctualityPct,
			Math.round((stats.avg_delay as number) * 10) / 10,
			cancelledTrains,
			stats.delay_0_5,
			stats.delay_6_15,
			stats.delay_16_30,
			stats.delay_31_60,
			stats.delay_60_plus,
		)
		.run();

	console.log(
		`[aggregateDaily] daily_stats — ${totalTrains} trains, ` +
			`${onTimeTrains} on time (${punctualityPct}%), ${cancelledTrains} cancelled`,
	);

	// 2. Compute city_daily for each major city
	for (const city of MAJOR_CITIES) {
		const cityStats = await env.DB.prepare(`
			SELECT
				COUNT(DISTINCT schedule_id || '-' || order_id) AS train_count,
				AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay
			FROM delay_snapshots
			WHERE operating_date = ? AND station_name LIKE ?
		`)
			.bind(yesterday, `%${city}%`)
			.first();

		if (!cityStats || (cityStats.train_count as number) === 0) continue;

		// Compute city-level punctuality
		const cityTrainStats = await env.DB.prepare(`
			SELECT
				MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay,
				MAX(is_cancelled) AS was_cancelled
			FROM delay_snapshots
			WHERE operating_date = ? AND station_name LIKE ?
			GROUP BY schedule_id, order_id
		`)
			.bind(yesterday, `%${city}%`)
			.all();

		let cityOnTime = 0;
		for (const row of cityTrainStats.results) {
			if (
				(row.was_cancelled as number) === 0 &&
				(row.max_delay as number) <= 5
			) {
				cityOnTime++;
			}
		}

		const cityTrainCount = cityTrainStats.results.length;
		const cityPunctuality =
			cityTrainCount > 0
				? Math.round((cityOnTime / cityTrainCount) * 1000) / 10
				: 0;

		await env.DB.prepare(`
			INSERT OR REPLACE INTO city_daily (city, date, train_count, avg_delay, punctuality_pct)
			VALUES (?, ?, ?, ?, ?)
		`)
			.bind(
				city,
				yesterday,
				cityTrainCount,
				Math.round((cityStats.avg_delay as number) * 10) / 10,
				cityPunctuality,
			)
			.run();
	}

	console.log(`[aggregateDaily] city_daily computed for ${MAJOR_CITIES.length} cities`);

	// 3. Prune old delay_snapshots (keep 30 days)
	const pruneResult = await env.DB.prepare(
		`DELETE FROM delay_snapshots WHERE operating_date < date('now', '-30 days')`,
	).run();

	console.log(
		`[aggregateDaily] Pruned ${pruneResult.meta.changes ?? 0} old snapshot rows`,
	);
}

// ---------------------------------------------------------------------------
// checkMonitoringSessions — runs after each pollOperations
// ---------------------------------------------------------------------------

async function checkMonitoringSessions(
	env: Env,
	trains: ApiTrain[],
): Promise<void> {
	const today = todayDateStr();

	// Fetch active sessions for today
	const sessions = await env.DB.prepare(
		`SELECT * FROM monitoring_sessions WHERE status = 'active' AND operating_date = ?`,
	)
		.bind(today)
		.all<MonitoringSession>();

	if (sessions.results.length === 0) return;

	console.log(
		`[checkMonitoringSessions] Checking ${sessions.results.length} active sessions`,
	);

	// Build a lookup map: "scheduleId-orderId" → train
	const trainMap = new Map<string, ApiTrain>();
	for (const t of trains) {
		trainMap.set(`${t.scheduleId}-${t.orderId}`, t);
	}

	for (const session of sessions.results) {
		try {
			await processSession(env, session, trainMap);
		} catch (err) {
			console.error(
				`[checkMonitoringSessions] Error processing session ${session.id}: ${err}`,
			);
		}
	}
}

async function processSession(
	env: Env,
	session: MonitoringSession,
	trainMap: Map<string, ApiTrain>,
): Promise<void> {
	const trainAKey = `${session.train_a_schedule_id}-${session.train_a_order_id}`;
	const trainA = trainMap.get(trainAKey);

	if (!trainA) {
		// Train A not in current operations — might not have departed yet or already finished
		await env.DB.prepare(
			`UPDATE monitoring_sessions SET last_checked = datetime('now') WHERE id = ?`,
		)
			.bind(session.id)
			.run();
		return;
	}

	// Find train A's data at the transfer station
	const transferStop = trainA.stations.find(
		(st) => st.stationId === session.transfer_station_id,
	);

	if (!transferStop) {
		await env.DB.prepare(
			`UPDATE monitoring_sessions SET last_checked = datetime('now') WHERE id = ?`,
		)
			.bind(session.id)
			.run();
		return;
	}

	// Get train B's scheduled departure at the transfer station
	const trainBKey = `${session.train_b_schedule_id}-${session.train_b_order_id}`;
	const trainB = trainMap.get(trainBKey);

	let trainBDeparture: string | null = null;
	if (trainB) {
		const trainBStop = trainB.stations.find(
			(st) => st.stationId === session.transfer_station_id,
		);
		trainBDeparture = trainBStop?.plannedDeparture ?? null;
	}

	if (!trainBDeparture) {
		// Can't compute buffer without train B departure time
		await env.DB.prepare(
			`UPDATE monitoring_sessions SET last_checked = datetime('now') WHERE id = ?`,
		)
			.bind(session.id)
			.run();
		return;
	}

	// Compute buffer: train A estimated arrival vs train B scheduled departure
	const trainAArrival =
		transferStop.actualArrival ?? transferStop.plannedArrival;

	if (!trainAArrival) {
		await env.DB.prepare(
			`UPDATE monitoring_sessions SET last_checked = datetime('now') WHERE id = ?`,
		)
			.bind(session.id)
			.run();
		return;
	}

	const arrivalTime = new Date(trainAArrival).getTime();
	const departureTime = new Date(trainBDeparture).getTime();
	const bufferMinutes = (departureTime - arrivalTime) / 60_000;

	console.log(
		`[checkMonitoringSessions] Session ${session.id}: buffer = ${bufferMinutes.toFixed(1)} min`,
	);

	// Connection missed — buffer < 0
	if (bufferMinutes < 0) {
		await env.DB.prepare(
			`UPDATE monitoring_sessions SET status = 'missed', last_checked = datetime('now') WHERE id = ?`,
		)
			.bind(session.id)
			.run();

		await sendPushNotification(session.push_subscription, {
			title: "Przesiadka niemozliwa!",
			body: `Pociag A jest opozniony o ${Math.abs(Math.round(bufferMinutes))} min. Polaczenie utracone.`,
			tag: `session-${session.id}`,
			data: { sessionId: session.id, status: "missed", bufferMinutes },
		});

		return;
	}

	// Connection at risk — buffer < 10 min
	if (bufferMinutes < 10) {
		await sendPushNotification(session.push_subscription, {
			title: "Uwaga — przesiadka zagrozzona!",
			body: `Zostalo tylko ${Math.round(bufferMinutes)} min na przesiadke. Obserwuj opoznienia.`,
			tag: `session-${session.id}`,
			data: { sessionId: session.id, status: "at_risk", bufferMinutes },
		});
	}

	await env.DB.prepare(
		`UPDATE monitoring_sessions SET last_checked = datetime('now') WHERE id = ?`,
	)
		.bind(session.id)
		.run();
}

// ---------------------------------------------------------------------------
// Web Push notification sender
// ---------------------------------------------------------------------------

interface PushPayload {
	title: string;
	body: string;
	tag: string;
	data?: Record<string, unknown>;
}

async function sendPushNotification(
	subscriptionJson: string,
	payload: PushPayload,
): Promise<void> {
	try {
		const subscription = JSON.parse(subscriptionJson);

		// Standard Web Push: POST to the subscription endpoint with the payload
		// Note: Production implementation should use VAPID authentication.
		// For now, we send a simple push message. The full VAPID signing
		// requires the web-push library or manual JWT creation, which should
		// be added when the push feature is built out in Phase 3.
		const res = await fetch(subscription.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				TTL: "86400",
			},
			body: JSON.stringify(payload),
		});

		if (!res.ok) {
			console.error(
				`[sendPushNotification] Failed: ${res.status} ${res.statusText}`,
			);
		}
	} catch (err) {
		console.error(`[sendPushNotification] Error: ${err}`);
	}
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		switch (controller.cron) {
			case "*/2 * * * *":
				ctx.waitUntil(
					pollOperations(env).catch((err) =>
						console.error(`[pollOperations] Fatal: ${err}`),
					),
				);
				break;

			case "*/5 * * * *":
				ctx.waitUntil(
					pollDisruptions(env).catch((err) =>
						console.error(`[pollDisruptions] Fatal: ${err}`),
					),
				);
				break;

			case "0 2 * * *":
				ctx.waitUntil(
					aggregateDaily(env).catch((err) =>
						console.error(`[aggregateDaily] Fatal: ${err}`),
					),
				);
				break;

			default:
				console.warn(`[cron] Unknown schedule: ${controller.cron}`);
		}
	},

	// Minimal fetch handler — useful for health checks and manual triggers
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({ status: "ok", worker: "niejedzie-cron" });
		}

		// Manual trigger endpoints (for testing / debugging)
		if (url.pathname === "/__trigger/operations") {
			ctx.waitUntil(pollOperations(env));
			return Response.json({ triggered: "pollOperations" });
		}

		if (url.pathname === "/__trigger/disruptions") {
			ctx.waitUntil(pollDisruptions(env));
			return Response.json({ triggered: "pollDisruptions" });
		}

		if (url.pathname === "/__trigger/aggregate") {
			ctx.waitUntil(aggregateDaily(env));
			return Response.json({ triggered: "aggregateDaily" });
		}

		if (url.pathname === "/__trigger/scraper") {
			try {
				const trains = await fetchFromScraper(env);
				return Response.json({
					triggered: "scraper",
					trainCount: trains?.length ?? 0,
					trains: trains?.slice(0, 10) ?? [], // Preview first 10
				});
			} catch (err) {
				return Response.json(
					{ error: "scraper failed", message: String(err) },
					{ status: 500 },
				);
			}
		}

		return new Response("niejedzie-cron worker", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
