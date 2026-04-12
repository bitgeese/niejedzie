// niejedzie-cron — Cloudflare Worker cron for polling PKP PLK API
//
// Cron schedules:
//   every 5 min   — pollOperations (current train delays -> D1 + KV)
//   every 5 min   — pollDisruptions (active disruptions -> D1 + KV)
//   0 2 * * *     — syncDaily (schedules + stations + aggregation + pruning)

import {
	fetchOperationsPages,
	fetchStatistics,
	fetchSchedulesPages,
	fetchDisruptions as fetchDisruptionsApi,
	type TrainOperationDto,
	type OperationStationDto,
	type RouteDto,
	type DisruptionDto,
} from './pkp-api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	DB: D1Database;
	DELAYS_KV: KVNamespace;
	PKP_API_KEY: string;
	ANTHROPIC_API_KEY?: string;
	// Modal hybrid scheduler — CF Worker cron fires HTTP POSTs to Modal web
	// endpoints which spawn the actual work on Modal compute.
	TRIGGER_TOKEN?: string;
}

const MODAL_TRIGGER_BASE = "https://maciek-61303--niejedzie-cron";
const MODAL_POLL_OPERATIONS_URL = `${MODAL_TRIGGER_BASE}-trigger-poll-operations.modal.run`;
const MODAL_POLL_DISRUPTIONS_URL = `${MODAL_TRIGGER_BASE}-trigger-poll-disruptions.modal.run`;
const MODAL_SYNC_DAILY_URL = `${MODAL_TRIGGER_BASE}-trigger-sync-daily.modal.run`;

async function fireModalTrigger(url: string, token: string | undefined): Promise<void> {
	if (!token) {
		console.error(`[modal-trigger] TRIGGER_TOKEN not set — skipping ${url}`);
		return;
	}
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "X-Trigger-Token": token },
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.error(`[modal-trigger] ${url} returned ${res.status}: ${body.slice(0, 200)}`);
		} else {
			const body = await res.json().catch(() => ({}));
			console.log(`[modal-trigger] ${url} spawned:`, body);
		}
	} catch (err) {
		console.error(`[modal-trigger] ${url} threw: ${err}`);
	}
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

export function todayDateStr(): string {
	const now = new Date();
	const pt = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
	return [pt.getFullYear(), String(pt.getMonth() + 1).padStart(2, '0'), String(pt.getDate()).padStart(2, '0')].join('-');
}

function yesterdayDateStr(): string {
	const now = new Date();
	const pt = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
	pt.setDate(pt.getDate() - 1);
	return [pt.getFullYear(), String(pt.getMonth() + 1).padStart(2, '0'), String(pt.getDate()).padStart(2, '0')].join('-');
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

// PKP /schedules returns scheduleId=YEAR (e.g. 2026) — never use it as train number.
// Real identifiers live on the route itself: nationalNumber, then international
// variants, then `name`. Compound key is the last-resort placeholder.
function extractTrainNumber(route: RouteDto): string {
	return (
		(route.nationalNumber && route.nationalNumber.trim()) ||
		(route.internationalDepartureNumber && route.internationalDepartureNumber.trim()) ||
		(route.internationalArrivalNumber && route.internationalArrivalNumber.trim()) ||
		(route.name && route.name.trim()) ||
		`${route.scheduleId}/${route.orderId}`
	);
}

// ---------------------------------------------------------------------------
// Delay computation helpers
// ---------------------------------------------------------------------------

function computeDelay(st: OperationStationDto, operatingDate: string): number {
	if (!st.plannedArrival || !st.actualArrival) return 0;
	// Only compute if actual differs from planned (skip scheduled trains with matching times)
	const planned = new Date(`${operatingDate}T${st.plannedArrival}`);
	const actual = new Date(st.actualArrival);
	const diffMin = Math.round((actual.getTime() - planned.getTime()) / 60000);
	// Clamp to ±720 min (12 hours) — anything larger is a date mismatch, not a real delay
	if (Math.abs(diffMin) > 720) return 0;
	return diffMin;
}

function computeDelayDeparture(st: OperationStationDto, operatingDate: string): number {
	if (!st.plannedDeparture || !st.actualDeparture) return 0;
	const planned = new Date(`${operatingDate}T${st.plannedDeparture}`);
	const actual = new Date(st.actualDeparture);
	const diffMin = Math.round((actual.getTime() - planned.getTime()) / 60000);
	if (Math.abs(diffMin) > 720) return 0;
	return diffMin;
}

// ---------------------------------------------------------------------------
// pollOperations — runs every 5 minutes
// ---------------------------------------------------------------------------

async function pollOperations(env: Env): Promise<void> {
	const today = todayDateStr();
	console.log(`[pollOperations] Starting poll for ${today}`);

	// 1. Load train metadata FIRST (before API calls) — needed in page callback
	const trainMetaRows = await env.DB.prepare(
		`SELECT schedule_id, order_id, train_number, carrier, category, route_start, route_end FROM trains`
	).all();

	const trainMeta = new Map<string, {
		train_number: string;
		carrier: string | null;
		category: string | null;
		route_start: string | null;
		route_end: string | null;
	}>();
	for (const row of trainMetaRows.results) {
		const key = `${row.schedule_id}-${row.order_id}`;
		trainMeta.set(key, {
			train_number: row.train_number as string,
			carrier: row.carrier as string | null,
			category: row.category as string | null,
			route_start: row.route_start as string | null,
			route_end: row.route_end as string | null,
		});
	}

	// 2. Fetch official statistics in parallel with operations paging
	const pkpStatsPromise = fetchStatistics(env.PKP_API_KEY, today).catch((err) => {
		console.warn(`[pollOperations] PKP stats failed: ${err}`);
		return null;
	});

	// 3. Accumulate stats across pages
	let totalDelay = 0;
	let delayCount = 0;
	let onTimeCount = 0;
	let cancelledCount = 0;
	let totalTrainsSeen = 0;
	const seenTrainIds = new Set<string>();

	// topDelayed candidates across all pages — keep top 10
	type TopDelayedCandidate = {
		trainNumber: string;
		delay: number;
		route: string;
		station: string;
		carrier: string;
	};
	const topDelayedCandidates: TopDelayedCandidate[] = [];

	const insertStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO delay_snapshots
			(schedule_id, order_id, operating_date, station_id, station_name,
			 sequence_num, planned_arrival, planned_departure, actual_arrival,
			 actual_departure, arrival_delay, departure_delay, is_confirmed, is_cancelled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const activeTrainStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO active_trains
			(operating_date, train_number, train_number_numeric, carrier, agency_id,
			 trip_id, stop_count, is_delayed, max_delay, schedule_id, order_id, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`);

	// 4. Stream pages — process each page immediately without holding all trains in memory
	const { totalTrains: apiTotalTrains, stations: finalStationDict } = await fetchOperationsPages(
		env.PKP_API_KEY,
		async (trains: TrainOperationDto[], stations: Record<string, string>, pageNum: number) => {
			console.log(`[pollOperations] Processing page ${pageNum} — ${trains.length} trains`);

			const snapshotBatch: D1PreparedStatement[] = [];
			const activeTrainBatch: D1PreparedStatement[] = [];

			for (const train of trains) {
				const trainKey = `${train.scheduleId}-${train.orderId}`;
				const isNew = !seenTrainIds.has(trainKey);
				if (isNew) {
					seenTrainIds.add(trainKey);
					totalTrainsSeen++;
				}

				// Skip Scheduled trains (no delay data yet) — just count them
				if (train.trainStatus === 'S') {
					if (isNew) onTimeCount++; // Scheduled = on time by default
					continue;
				}

				const meta = trainMeta.get(trainKey);
				// scheduleId is the annual timetable year (2026), so never use it
				// alone as a fallback — compound with orderId for a stable placeholder.
				const trainNumber = meta?.train_number ?? `${train.scheduleId}/${train.orderId}`;
				const carrier = meta?.carrier ?? '';

				let trainMaxDelay = 0;
				let trainCancelled = false;

				// Build delay_snapshots rows for this train
				for (const st of train.stations) {
					const stationName = stations[String(st.stationId)] ?? '';
					if (!stationName || stationName.trim() === '') continue;
					if (!st.plannedArrival && !st.plannedDeparture &&
						!st.actualArrival && !st.actualDeparture) continue;

					const arrDelay = st.arrivalDelayMinutes ?? computeDelay(st, train.operatingDate);
					const depDelay = st.departureDelayMinutes ?? computeDelayDeparture(st, train.operatingDate);
					const delay = st.arrivalDelayMinutes ?? arrDelay;

					if (Math.abs(delay) > Math.abs(trainMaxDelay)) trainMaxDelay = delay;
					if (st.isCancelled) trainCancelled = true;

					if (isNew && (st.actualArrival || st.actualDeparture)) {
						totalDelay += delay;
						delayCount++;
					}

					snapshotBatch.push(
						insertStmt.bind(
							train.scheduleId,
							train.orderId,
							train.operatingDate || today,
							st.stationId,
							stationName,
							st.actualSequenceNumber ?? st.plannedSequenceNumber ?? 0,
							st.plannedArrival ?? null,
							st.plannedDeparture ?? null,
							st.actualArrival ?? null,
							st.actualDeparture ?? null,
							arrDelay,
							depDelay,
							st.isConfirmed ? 1 : 0,
							st.isCancelled ? 1 : 0,
						),
					);
				}

				// Accumulate per-train stats (only count each train once)
				if (isNew) {
					if (trainCancelled || train.trainStatus === 'Cancelled') {
						cancelledCount++;
					} else if (trainMaxDelay <= 5) {
						onTimeCount++;
					}
				}

				// Build active_trains row
				let maxDelay = 0;
				let isDelayed = false;
				for (const st of train.stations) {
					const delay = st.arrivalDelayMinutes ?? computeDelay(st, train.operatingDate);
					if (delay > maxDelay) maxDelay = delay;
					if (delay > 5) isDelayed = true;
				}

				// Placeholder compound IDs (scheduleId/orderId) have no meaningful
				// "numeric train number" — leave it blank rather than mining the year.
				const isPlaceholder = trainNumber.includes('/');
				const numericMatch = isPlaceholder ? null : trainNumber.match(/\d+/);
				const trainNumberNumeric = numericMatch ? numericMatch[0] : '';

				activeTrainBatch.push(
					activeTrainStmt.bind(
						train.operatingDate || today,
						trainNumber,
						trainNumberNumeric,
						carrier,
						'', // agency_id not available from PKP API
						`${train.scheduleId}-${train.orderId}`, // trip_id placeholder
						train.stations.length,
						isDelayed ? 1 : 0,
						maxDelay,
						train.scheduleId,
						train.orderId,
					),
				);

				// Collect topDelayed candidates
				if (maxDelay > 0) {
					const firstStation = train.stations[0];
					const lastStation = train.stations[train.stations.length - 1];
					topDelayedCandidates.push({
						trainNumber,
						delay: maxDelay,
						route: `${meta?.route_start ?? stations[String(firstStation?.stationId)] ?? '?'} → ${meta?.route_end ?? stations[String(lastStation?.stationId)] ?? '?'}`,
						station: stations[String(lastStation?.stationId)] ?? '',
						carrier,
					});
					// Trim to keep memory bounded — keep only top 20 candidates
					if (topDelayedCandidates.length > 20) {
						topDelayedCandidates.sort((a, b) => b.delay - a.delay);
						topDelayedCandidates.splice(20);
					}
				}
			}

			// Write snapshots and active_trains immediately for this page
			if (snapshotBatch.length > 0) {
				await batchExecute(env.DB, snapshotBatch).catch((err) => {
					console.error(`[pollOperations] Snapshot write failed on page ${pageNum}: ${err}`);
				});
			}
			if (activeTrainBatch.length > 0) {
				await batchExecute(env.DB, activeTrainBatch).catch((err) => {
					console.error(`[pollOperations] Active trains upsert failed on page ${pageNum}: ${err}`);
				});
			}

			console.log(`[pollOperations] Page ${pageNum} — wrote ${snapshotBatch.length} snapshots, ${activeTrainBatch.length} active_trains`);
		},
	);

	if (totalTrainsSeen === 0) {
		console.log('[pollOperations] No trains from API — skipping stats write');
		return;
	}

	console.log(`[pollOperations] All pages processed — ${totalTrainsSeen} unique trains`);

	// 5. Final stats computation
	const avgDelay = delayCount > 0 ? Math.round((totalDelay / delayCount) * 10) / 10 : 0;
	const punctualityPct =
		totalTrainsSeen > 0
			? Math.round((onTimeCount / totalTrainsSeen) * 1000) / 10
			: 0;

	const topDelayed = topDelayedCandidates
		.sort((a, b) => b.delay - a.delay)
		.slice(0, 10);

	// 6. Await PKP official stats (started in parallel at top)
	const pkpStats = await pkpStatsPromise;

	// 6b. Write basic KV stats immediately (enhanced later)
	try {
		await env.DELAYS_KV.put("stats:today", JSON.stringify({
			timestamp: new Date().toISOString(),
			totalTrains: pkpStats?.totalTrains ?? apiTotalTrains,
			avgDelay,
			punctualityPct,
			cancelledCount: pkpStats?.cancelled ?? cancelledCount,
			onTimeCount,
			pkpOfficialStats: pkpStats ? {
				totalTrains: pkpStats.totalTrains,
				completed: pkpStats.completed,
				inProgress: pkpStats.inProgress,
				notStarted: pkpStats.notStarted,
				cancelled: pkpStats.cancelled,
				partialCancelled: pkpStats.partialCancelled,
			} : null,
			topDelayed,
		}), { expirationTtl: 600 });
		console.log(`[pollOperations] Basic KV stats written`);
	} catch (err) {
		console.error(`[pollOperations] Failed to write basic KV stats: ${err}`);
	}

	// 7. Fetch active disruptions from KV for inclusion in enhanced stats
	let disruptions: Array<{ message: string; route: string }> = [];
	try {
		const disruptionsRaw = await env.DELAYS_KV.get(
			'disruptions:active',
			'json',
		) as { disruptions?: Array<{ message: string; startStation: string; endStation: string }> } | null;
		if (disruptionsRaw?.disruptions) {
			disruptions = disruptionsRaw.disruptions.map((d) => ({
				message: d.message,
				route: `${d.startStation} → ${d.endStation}`,
			}));
		}
	} catch (err) {
		console.error(`[pollOperations] Failed to fetch disruptions from KV: ${err}`);
	}

	// 8. Compute hourly delay breakdown from D1
	let hourlyDelays: Array<{ hour: string; avgDelay: number }> = [];
	try {
		const hourlyRows = await env.DB.prepare(`
			SELECT
				strftime('%H:00', COALESCE(planned_departure, planned_arrival)) AS hour,
				ROUND(AVG(COALESCE(departure_delay, arrival_delay, 0)), 1) AS avg_delay
			FROM delay_snapshots
			WHERE operating_date = ?
				AND COALESCE(planned_departure, planned_arrival) IS NOT NULL
			GROUP BY hour
			ORDER BY hour
		`).bind(today).all();
		hourlyDelays = (hourlyRows.results || []).map((r: any) => ({
			hour: r.hour as string,
			avgDelay: r.avg_delay as number,
		}));
	} catch (err) {
		console.warn(`[pollOperations] Failed to compute hourly delays: ${err}`);
	}

	// 9. Compute accumulated daily punctuality from all delay_snapshots today
	let dailyPunctuality: number | null = null;
	let dailyAvgDelay: number | null = null;
	try {
		const dailyRow = await env.DB.prepare(`
			SELECT
				COUNT(*) AS total_trains,
				SUM(CASE WHEN max_delay <= 5 THEN 1 ELSE 0 END) AS on_time,
				ROUND(AVG(CASE WHEN max_delay > 0 THEN max_delay ELSE 0 END), 1) AS avg_delay
			FROM (
				SELECT schedule_id, order_id,
					MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay
				FROM delay_snapshots
				WHERE operating_date = ?
				GROUP BY schedule_id, order_id
			)
		`).bind(today).first();
		const total = (dailyRow?.total_trains as number) || 0;
		const onTime = (dailyRow?.on_time as number) || 0;
		if (total > 0) {
			dailyPunctuality = Math.round((onTime / total) * 1000) / 10;
			dailyAvgDelay = (dailyRow?.avg_delay as number) || 0;
		}
	} catch (err) {
		console.warn(`[pollOperations] Failed to compute daily punctuality: ${err}`);
	}

	// 10. Write stats:today to KV
	try {
		const todayStats = {
			timestamp: new Date().toISOString(),
			totalTrains: pkpStats?.totalTrains ?? apiTotalTrains,
			avgDelay: dailyAvgDelay ?? avgDelay,
			punctualityPct: dailyPunctuality ?? punctualityPct,
			cancelledCount: pkpStats?.cancelled ?? cancelledCount,
			onTimeCount,
			pkpOfficialStats: pkpStats ? {
				totalTrains: pkpStats.totalTrains,
				completed: pkpStats.completed,
				inProgress: pkpStats.inProgress,
				notStarted: pkpStats.notStarted,
				cancelled: pkpStats.cancelled,
				partialCancelled: pkpStats.partialCancelled,
			} : null,
			dailyPunctuality,
			dailyAvgDelay,
			topDelayed,
			disruptions,
			hourlyDelays,
		};

		await env.DELAYS_KV.put("stats:today", JSON.stringify(todayStats), {
			expirationTtl: 600,
		});
		console.log(`[pollOperations] KV stats:today written successfully`);
	} catch (err) {
		console.error(`[pollOperations] FAILED to write KV stats: ${err}`);
	}

	console.log(
		`[pollOperations] Stats — trains: ${todayStats.totalTrains}, onTime: ${onTimeCount}, ` +
			`avgDelay: ${avgDelay}min, cancelled: ${cancelledCount}, punctuality: ${todayStats.punctualityPct}%`
	);

	// 11. Write operations:latest to KV
	await env.DELAYS_KV.put(
		"operations:latest",
		JSON.stringify({
			timestamp: new Date().toISOString(),
			trainCount: totalTrainsSeen,
		}),
		{ expirationTtl: 600 },
	);

	// 12. Check active monitoring sessions
	// TODO: restructure to not need full train list — skipped for now, monitoring sessions are rare
	// await checkMonitoringSessions(env, allTrains, finalStationDict);

	// 14. Run data quality check every 10 minutes
	const currentMinute = new Date().getMinutes();
	if (currentMinute % 10 === 0) {
		await reportDataQualityIssues(env).catch((err) => {
			console.error(`[pollOperations] Data quality check failed: ${err}`);
		});
	}
}

// ---------------------------------------------------------------------------
// syncDaily — runs at 02:00
// ---------------------------------------------------------------------------

async function syncSchedulesForDate(env: Env, date: string): Promise<number> {
	console.log(`[syncSchedules] Syncing schedules for ${date}`);

	const trainUpsertStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO trains
			(schedule_id, order_id, train_number, carrier, category, route_start, route_end, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
	`);

	const routeStmt = env.DB.prepare(`
		INSERT OR REPLACE INTO train_routes
			(operating_date, train_number, stop_sequence, stop_id, arrival_time, departure_time, trip_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	const { totalRoutes, stations: stationDict } = await fetchSchedulesPages(
		env.PKP_API_KEY,
		date,
		async (routes: RouteDto[], stations: Record<string, string>, pageNum: number) => {
			const trainBatch: D1PreparedStatement[] = [];
			const routeBatch: D1PreparedStatement[] = [];

			for (const route of routes) {
				const trainNumber = extractTrainNumber(route);
				const carrier = route.carrierCode ?? '';
				const category = route.commercialCategorySymbol ?? '';
				const firstStation = route.stations?.[0];
				const lastStation = route.stations?.[route.stations.length - 1];
				const routeStart = firstStation ? (stations[String(firstStation.stationId)] ?? '') : '';
				const routeEnd = lastStation ? (stations[String(lastStation.stationId)] ?? '') : '';

				trainBatch.push(
					trainUpsertStmt.bind(
						route.scheduleId, route.orderId, trainNumber, carrier, category, routeStart, routeEnd,
					),
				);

				const tripId = `${route.scheduleId}-${route.orderId}`;
				for (const st of route.stations ?? []) {
					routeBatch.push(
						routeStmt.bind(
							date, trainNumber, st.orderNumber, st.stationId,
							st.arrivalTime ?? null, st.departureTime ?? null, tripId,
						),
					);
				}
			}

			if (trainBatch.length > 0) await batchExecute(env.DB, trainBatch);
			if (routeBatch.length > 0) await batchExecute(env.DB, routeBatch);
			console.log(`[syncSchedules] ${date} page ${pageNum} — ${trainBatch.length} trains, ${routeBatch.length} stops`);
		},
	);

	// Update stations from dictionary
	const stationStmt = env.DB.prepare(
		`INSERT OR REPLACE INTO stations (station_id, name, city) VALUES (?, ?, ?)`
	);
	const stationStmts: D1PreparedStatement[] = [];
	for (const [idStr, name] of Object.entries(stationDict)) {
		const stationId = Number(idStr);
		if (isNaN(stationId)) continue;
		const city = name.split(/\s+/)[0] ?? name;
		stationStmts.push(stationStmt.bind(stationId, name, city));
	}
	if (stationStmts.length > 0) await batchExecute(env.DB, stationStmts);

	return totalRoutes;
}

async function syncDaily(env: Env): Promise<void> {
	const today = todayDateStr();
	const yesterday = yesterdayDateStr();
	console.log(`[syncDaily] Starting daily sync`);

	// Sync both today and yesterday's schedules (yesterday's trains may still be running)
	const todayRoutes = await syncSchedulesForDate(env, today);
	const yesterdayRoutes = await syncSchedulesForDate(env, yesterday);
	console.log(`[syncDaily] Synced ${todayRoutes} today + ${yesterdayRoutes} yesterday routes`);

	// Run existing aggregation and backfill
	await aggregateDaily(env).catch((err) =>
		console.error(`[syncDaily] aggregateDaily failed: ${err}`),
	);
	await backfillCityDaily(env).catch((err) =>
		console.error(`[syncDaily] backfillCityDaily failed: ${err}`),
	);

	console.log('[syncDaily] Daily sync completed');
}

// ---------------------------------------------------------------------------
// pollDisruptions — runs every 5 minutes
// ---------------------------------------------------------------------------

async function pollDisruptions(env: Env): Promise<void> {
	console.log("[pollDisruptions] Starting");

	const disruptions = await fetchDisruptionsApi(env.PKP_API_KEY);

	if (disruptions.length === 0) {
		console.warn("[pollDisruptions] No disruptions from API");
	}

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
	const totalTrainsYesterday = trainStats.results.length;

	for (const row of trainStats.results) {
		if ((row.was_cancelled as number) === 1) {
			cancelledTrains++;
		} else if ((row.max_delay as number) <= 5) {
			onTimeTrains++;
		}
	}

	const punctualityPctYesterday =
		totalTrainsYesterday > 0
			? Math.round((onTimeTrains / totalTrainsYesterday) * 1000) / 10
			: 0;

	await env.DB.prepare(`
		INSERT OR REPLACE INTO daily_stats
			(date, total_trains, on_time_count, punctuality_pct, avg_delay, cancelled_count,
			 delay_0_5, delay_6_15, delay_16_30, delay_31_60, delay_60_plus)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
		.bind(
			yesterday,
			totalTrainsYesterday,
			onTimeTrains,
			punctualityPctYesterday,
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
		`[aggregateDaily] daily_stats — ${totalTrainsYesterday} trains, ` +
			`${onTimeTrains} on time (${punctualityPctYesterday}%), ${cancelledTrains} cancelled`,
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

	// 4. Prune old active_trains (keep 7 days)
	const pruneActiveResult = await env.DB.prepare(
		`DELETE FROM active_trains WHERE operating_date < date('now', '-7 days')`,
	).run();

	console.log(
		`[aggregateDaily] Pruned ${pruneActiveResult.meta.changes ?? 0} old active_trains rows`,
	);

	// 5. Prune old train_routes (keep 7 days)
	const pruneRoutesResult = await env.DB.prepare(
		`DELETE FROM train_routes WHERE operating_date < date('now', '-7 days')`,
	).run();

	console.log(
		`[aggregateDaily] Pruned ${pruneRoutesResult.meta.changes ?? 0} old train_routes rows`,
	);
}

// ---------------------------------------------------------------------------
// backfillCityDaily — populate historical city_daily data from delay_snapshots
// ---------------------------------------------------------------------------

async function backfillCityDaily(env: Env): Promise<void> {
	console.log('[backfillCityDaily] Starting historical data backfill');

	// Get all unique dates from delay_snapshots that don't have city_daily entries
	const missingDates = await env.DB.prepare(`
		SELECT DISTINCT ds.operating_date
		FROM delay_snapshots ds
		LEFT JOIN city_daily cd ON cd.date = ds.operating_date AND cd.city = ?
		WHERE cd.date IS NULL
		ORDER BY ds.operating_date DESC
		LIMIT 30
	`).bind(MAJOR_CITIES[0]).all();

	if (!missingDates.results || missingDates.results.length === 0) {
		console.log('[backfillCityDaily] No missing dates found');
		return;
	}

	console.log(`[backfillCityDaily] Found ${missingDates.results.length} missing dates`);

	// Process each missing date
	for (const dateRow of missingDates.results) {
		const date = dateRow.operating_date as string;
		console.log(`[backfillCityDaily] Processing ${date}`);

		// Process each major city for this date
		for (const city of MAJOR_CITIES) {
			const cityStats = await env.DB.prepare(`
				SELECT
					COUNT(DISTINCT schedule_id || '-' || order_id) AS train_count,
					AVG(COALESCE(arrival_delay, departure_delay, 0)) AS avg_delay
				FROM delay_snapshots ds
				LEFT JOIN stations s ON s.station_id = ds.station_id
				WHERE ds.operating_date = ?
					AND (s.city = ? OR ds.station_name LIKE ?)
			`).bind(date, city, `${city}%`).first();

			if (!cityStats || (cityStats.train_count as number) === 0) {
				continue;
			}

			// Count on-time trains for this city/date
			const onTimeStats = await env.DB.prepare(`
				SELECT COUNT(*) AS on_time FROM (
					SELECT schedule_id, order_id,
						   MAX(COALESCE(arrival_delay, departure_delay, 0)) AS max_delay
					FROM delay_snapshots ds
					LEFT JOIN stations s ON s.station_id = ds.station_id
					WHERE ds.operating_date = ?
						AND (s.city = ? OR ds.station_name LIKE ?)
					GROUP BY schedule_id, order_id
					HAVING max_delay <= 5
				)
			`).bind(date, city, `${city}%`).first();

			const trainCount = cityStats.train_count as number;
			const onTime = (onTimeStats?.on_time as number) || 0;
			const avgDelayVal = Math.round(((cityStats.avg_delay as number) || 0) * 10) / 10;
			const punctuality = trainCount > 0 ? Math.round((onTime / trainCount) * 1000) / 10 : 0;

			// Insert into city_daily
			await env.DB.prepare(`
				INSERT OR REPLACE INTO city_daily (city, date, train_count, avg_delay, punctuality_pct)
				VALUES (?, ?, ?, ?, ?)
			`).bind(city, date, trainCount, avgDelayVal, punctuality).run();

			console.log(`[backfillCityDaily] ${city} ${date}: ${trainCount} trains, ${punctuality}% punctual`);
		}
	}

	console.log('[backfillCityDaily] Backfill completed');
}

// ---------------------------------------------------------------------------
// dataQualityCheck — monitor data quality and alert on issues
// ---------------------------------------------------------------------------

interface DataQualityIssue {
	type: string;
	severity: 'warning' | 'error' | 'critical';
	message: string;
	count?: number;
	timestamp: string;
}

async function dataQualityCheck(env: Env): Promise<DataQualityIssue[]> {
	const issues: DataQualityIssue[] = [];
	const now = new Date().toISOString();
	const today = todayDateStr();

	// 1. Check for "Nieznana" (Unknown) stations
	const unknownStations = await env.DB.prepare(`
		SELECT COUNT(*) as count
		FROM delay_snapshots
		WHERE operating_date = ? AND station_name = 'Nieznana'
	`).bind(today).first();

	const unknownCount = (unknownStations?.count as number) || 0;
	if (unknownCount > 0) {
		issues.push({
			type: 'unknown_stations',
			severity: unknownCount > 50 ? 'error' : 'warning',
			message: `Found ${unknownCount} delay snapshots with "Nieznana" station names`,
			count: unknownCount,
			timestamp: now,
		});
	}

	// 2. Check data freshness - latest poll should be within last 5 minutes
	const latestSnapshot = await env.DB.prepare(`
		SELECT recorded_at
		FROM delay_snapshots
		ORDER BY recorded_at DESC
		LIMIT 1
	`).first();

	if (latestSnapshot) {
		const latestTime = new Date(latestSnapshot.recorded_at as string);
		const ageMinutes = (Date.now() - latestTime.getTime()) / (1000 * 60);

		if (ageMinutes > 10) {
			issues.push({
				type: 'stale_data',
				severity: ageMinutes > 30 ? 'critical' : 'error',
				message: `Latest data is ${Math.round(ageMinutes)} minutes old (last: ${latestSnapshot.recorded_at})`,
				timestamp: now,
			});
		}
	} else {
		issues.push({
			type: 'no_data',
			severity: 'critical',
			message: 'No delay snapshots found in database',
			timestamp: now,
		});
	}

	// 3. Check for reasonable data volumes - expect at least 10 trains per poll
	const recentSnapshots = await env.DB.prepare(`
		SELECT COUNT(*) as count
		FROM delay_snapshots
		WHERE operating_date = ? AND recorded_at > datetime('now', '-10 minutes')
	`).bind(today).first();

	const recentCount = (recentSnapshots?.count as number) || 0;
	if (recentCount < 5) {
		issues.push({
			type: 'low_data_volume',
			severity: recentCount === 0 ? 'critical' : 'warning',
			message: `Only ${recentCount} snapshots in last 10 minutes (expected >10)`,
			count: recentCount,
			timestamp: now,
		});
	}

	// 4. Check KV cache health
	try {
		const kvStats = await env.DELAYS_KV.get('stats:today');
		if (!kvStats) {
			issues.push({
				type: 'kv_cache_empty',
				severity: 'warning',
				message: 'KV cache for stats:today is empty',
				timestamp: now,
			});
		} else {
			const statsData = JSON.parse(kvStats);
			const statsAge = new Date(statsData.timestamp);
			const statsAgeMinutes = (Date.now() - statsAge.getTime()) / (1000 * 60);

			if (statsAgeMinutes > 10) {
				issues.push({
					type: 'kv_cache_stale',
					severity: 'warning',
					message: `KV cache stats are ${Math.round(statsAgeMinutes)} minutes old`,
					timestamp: now,
				});
			}
		}
	} catch (err) {
		issues.push({
			type: 'kv_cache_error',
			severity: 'error',
			message: `Failed to check KV cache: ${err}`,
			timestamp: now,
		});
	}

	// 5. Check for completeness - trains should have metadata
	const trainsWithoutMetadata = await env.DB.prepare(`
		SELECT COUNT(DISTINCT ds.schedule_id || '-' || ds.order_id) as count
		FROM delay_snapshots ds
		LEFT JOIN trains t ON t.schedule_id = ds.schedule_id AND t.order_id = ds.order_id
		WHERE ds.operating_date = ? AND t.schedule_id IS NULL
	`).bind(today).first();

	const missingMetadataCount = (trainsWithoutMetadata?.count as number) || 0;
	if (missingMetadataCount > 0) {
		issues.push({
			type: 'missing_train_metadata',
			severity: 'warning',
			message: `${missingMetadataCount} trains missing metadata in trains table`,
			count: missingMetadataCount,
			timestamp: now,
		});
	}

	return issues;
}

async function reportDataQualityIssues(env: Env): Promise<void> {
	console.log('[dataQualityCheck] Starting data quality assessment');

	const issues = await dataQualityCheck(env);

	if (issues.length === 0) {
		console.log('[dataQualityCheck] No data quality issues found');
		return;
	}

	// Log all issues
	console.log(`[dataQualityCheck] Found ${issues.length} data quality issues:`);
	for (const issue of issues) {
		const severity = issue.severity.toUpperCase();
		console.log(`[dataQualityCheck] ${severity}: ${issue.type} - ${issue.message}`);
	}

	// Store issues in KV for monitoring dashboard
	await env.DELAYS_KV.put(
		'quality:issues',
		JSON.stringify({
			timestamp: new Date().toISOString(),
			issueCount: issues.length,
			issues,
		}),
		{ expirationTtl: 3600 }, // 1 hour
	);

	// For critical issues, we could add webhook notifications here
	const criticalIssues = issues.filter(i => i.severity === 'critical');
	if (criticalIssues.length > 0) {
		console.error(`[dataQualityCheck] ${criticalIssues.length} CRITICAL issues requiring immediate attention`);
		// TODO: Add Slack/email webhook notification here
	}
}

// ---------------------------------------------------------------------------
// checkMonitoringSessions — runs after each pollOperations
// ---------------------------------------------------------------------------

async function checkMonitoringSessions(
	env: Env,
	trains: TrainOperationDto[],
	stationDict: Record<string, string>,
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
	const trainMap = new Map<string, TrainOperationDto>();
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
	trainMap: Map<string, TrainOperationDto>,
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

	// Handle both time formats: HH:MM:SS (planned) and ISO datetime (actual)
	const arrivalTime = trainAArrival.includes('T')
		? new Date(trainAArrival).getTime()
		: new Date(`${session.operating_date}T${trainAArrival}`).getTime();
	const departureTime = trainBDeparture.includes('T')
		? new Date(trainBDeparture).getTime()
		: new Date(`${session.operating_date}T${trainBDeparture}`).getTime();
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

/**
 * Send a Web Push notification with VAPID authentication.
 * Uses Web Crypto API for JWT signing (no npm dependencies).
 */
async function sendPushNotification(
	subscriptionJson: string,
	payload: PushPayload,
	env?: { VAPID_PRIVATE_KEY?: string; VAPID_PUBLIC_KEY?: string },
): Promise<void> {
	try {
		const subscription = JSON.parse(subscriptionJson);
		if (!subscription.endpoint) {
			console.warn('[sendPushNotification] No endpoint in subscription');
			return;
		}

		const vapidPrivate = env?.VAPID_PRIVATE_KEY;
		const vapidPublic = env?.VAPID_PUBLIC_KEY;

		const headers: Record<string, string> = {
			'Content-Type': 'application/octet-stream',
			'Content-Length': '0',
			'TTL': '86400',
			'Urgency': 'high',
		};

		// Add VAPID auth if keys available
		if (vapidPrivate && vapidPublic) {
			const audience = new URL(subscription.endpoint).origin;
			const jwt = await createVapidJwt(vapidPrivate, audience);
			headers['Authorization'] = `vapid t=${jwt}, k=${vapidPublic}`;
		}

		// Send empty push (no payload encryption for MVP)
		// Service worker will fetch details from API when it wakes
		const res = await fetch(subscription.endpoint, {
			method: 'POST',
			headers,
		});

		if (!res.ok) {
			console.error(`[sendPushNotification] Failed: ${res.status} ${res.statusText}`);
			if (res.status === 410) {
				console.log('[sendPushNotification] Subscription expired (410 Gone)');
			}
		} else {
			console.log('[sendPushNotification] Push sent successfully');
		}
	} catch (err) {
		console.error(`[sendPushNotification] Error: ${err}`);
	}
}

/**
 * Create a VAPID JWT signed with ECDSA P-256 (ES256) per RFC 8292.
 */
async function createVapidJwt(privateKeyBase64url: string, audience: string): Promise<string> {
	// Import the 32-byte private key as ECDSA P-256
	const rawKey = base64urlToBuffer(privateKeyBase64url);

	const key = await crypto.subtle.importKey(
		'pkcs8',
		buildPkcs8FromRaw(new Uint8Array(rawKey)),
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign'],
	);

	// JWT header (ES256 = ECDSA P-256 + SHA-256)
	const header = base64urlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
	const now = Math.floor(Date.now() / 1000);
	const jwtPayload = base64urlEncode(JSON.stringify({
		aud: audience,
		exp: now + 43200,
		sub: 'mailto:admin@niejedzie.pl',
	}));

	const signingInput = `${header}.${jwtPayload}`;
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(signingInput),
	);

	// Convert DER signature to raw r||s format for JWT
	const rawSig = derToRaw(new Uint8Array(signature));
	return `${signingInput}.${base64urlEncode(rawSig)}`;
}

/** Wrap a 32-byte raw EC private key in PKCS#8 DER for Web Crypto import */
function buildPkcs8FromRaw(rawKey: Uint8Array): ArrayBuffer {
	// PKCS#8 prefix for EC P-256 private key (RFC 5958 + RFC 5480)
	const prefix = new Uint8Array([
		0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
		0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
		0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
	]);
	const result = new Uint8Array(prefix.length + rawKey.length);
	result.set(prefix);
	result.set(rawKey, prefix.length);
	return result.buffer;
}

/** Convert DER-encoded ECDSA signature to raw r||s (64 bytes) for JWT */
function derToRaw(der: Uint8Array): Uint8Array {
	// DER: 0x30 [len] 0x02 [rLen] [r] 0x02 [sLen] [s]
	const raw = new Uint8Array(64);
	let offset = 2; // skip 0x30 + length
	// r
	const rLen = der[offset + 1];
	offset += 2;
	const rStart = rLen > 32 ? offset + (rLen - 32) : offset;
	const rDest = rLen < 32 ? 32 - rLen : 0;
	raw.set(der.slice(rStart, rStart + Math.min(rLen, 32)), rDest);
	offset += rLen;
	// s
	const sLen = der[offset + 1];
	offset += 2;
	const sStart = sLen > 32 ? offset + (sLen - 32) : offset;
	const sDest = sLen < 32 ? 64 - sLen : 32;
	raw.set(der.slice(sStart, sStart + Math.min(sLen, 32)), sDest);
	return raw;
}

function base64urlEncode(input: string | Uint8Array): string {
	let bytes: Uint8Array;
	if (typeof input === 'string') {
		bytes = new TextEncoder().encode(input);
	} else {
		bytes = input;
	}
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(base64url: string): ArrayBuffer {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
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
		// Hybrid: CF Worker cron fires HTTP POSTs to Modal web endpoints which
		// spawn the actual work on Modal compute. The TS pollOperations /
		// pollDisruptions / syncDaily functions below are kept for manual
		// /__trigger/* debugging only — they are NOT called on the scheduled
		// path anymore. Rollback: revert this scheduled() body.
		switch (controller.cron) {
			case "*/5 * * * *":
				ctx.waitUntil(
					Promise.all([
						fireModalTrigger(MODAL_POLL_OPERATIONS_URL, env.TRIGGER_TOKEN),
						fireModalTrigger(MODAL_POLL_DISRUPTIONS_URL, env.TRIGGER_TOKEN),
					]),
				);
				break;

			case "0 2 * * *":
				ctx.waitUntil(fireModalTrigger(MODAL_SYNC_DAILY_URL, env.TRIGGER_TOKEN));
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
			return Response.json({ status: "ok", worker: "niejedzie-cron", api: PKP_API_BASE });
		}

		// Manual trigger endpoints (for testing / debugging)
		if (url.pathname === "/__trigger/operations-sync") {
			try {
				await pollOperations(env);
				return Response.json({ status: "ok", ran: "pollOperations" });
			} catch (err) {
				return Response.json({ error: String(err), stack: (err as Error).stack }, { status: 500 });
			}
		}

		if (url.pathname === "/__trigger/operations") {
			ctx.waitUntil(pollOperations(env));
			return Response.json({ triggered: "pollOperations" });
		}

		// Synchronous debug — single page test
		if (url.pathname === "/__trigger/debug-poll") {
			try {
				const size = url.searchParams.get('size') || '5';
				const apiUrl = `${PKP_API_BASE}/api/v1/operations?pageSize=${size}&page=1&fullRoutes=true&withPlanned=true`;
				const apiRes = await fetch(apiUrl, {
					headers: { "X-API-Key": env.PKP_API_KEY, "Accept": "application/json" },
				});
				if (!apiRes.ok) {
					return Response.json({ error: `HTTP ${apiRes.status}`, body: (await apiRes.text()).slice(0, 500) });
				}
				const result = await apiRes.json() as any;
				return Response.json({
					trainCount: result.trains?.length ?? 0,
					pagination: result.pagination,
					stationDictSize: result.stations ? Object.keys(result.stations).length : 0,
					sampleTrainKeys: result.trains?.[0] ? Object.keys(result.trains[0]) : [],
					topLevelKeys: Object.keys(result),
				});
			} catch (err) {
				return Response.json({ error: String(err), stack: (err as Error).stack }, { status: 500 });
			}
		}

		if (url.pathname === "/__trigger/disruptions") {
			ctx.waitUntil(pollDisruptions(env));
			return Response.json({ triggered: "pollDisruptions" });
		}

		if (url.pathname === "/__trigger/sync-daily") {
			ctx.waitUntil(syncDaily(env));
			return Response.json({ triggered: "syncDaily" });
		}

		if (url.pathname === "/__trigger/aggregate") {
			ctx.waitUntil(aggregateDaily(env));
			return Response.json({ triggered: "aggregateDaily" });
		}

		if (url.pathname === "/__trigger/backfill-city") {
			ctx.waitUntil(backfillCityDaily(env));
			return Response.json({ triggered: "backfillCityDaily" });
		}

		if (url.pathname === "/__trigger/data-quality") {
			ctx.waitUntil(reportDataQualityIssues(env));
			return Response.json({ triggered: "dataQualityCheck" });
		}

		return new Response("niejedzie-cron worker", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
