// scraper.ts — Portal Pasażera (portalpasazera.pl) web scraper
//
// Alternative data source for niejedzie.pl when the PKP PLK API is unavailable.
// Scrapes the public delays page at portalpasazera.pl/Opoznienia to extract
// currently delayed trains and transforms them into the ApiTrain format used
// by the rest of the pipeline.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScrapingSession {
	sessionId: string;
	verificationCookie: string;
	csrfToken: string;
	ajaxHeaders: Record<string, string>;
	createdAt: number;
}

interface ScrapedTrain {
	carrier: string;
	trainName: string;
	trainNumber: string;
	routeFrom: string;
	routeTo: string;
	delayMinutes: number;
	detailUrl: string | null;
}

/** Re-declare the types we need from index.ts to avoid circular imports */
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

interface Env {
	DB: D1Database;
	DELAYS_KV: KVNamespace;
	PKP_API_KEY: string;
	DATA_SOURCE?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORTAL_BASE = 'https://portalpasazera.pl';
const DELAYS_URL = `${PORTAL_BASE}/Opoznienia`;
const DELAYS_TAB_URL = `${PORTAL_BASE}/Opoznienia/Index`;
const SESSION_KV_KEY = 'scraper:session';
const SESSION_TTL = 600; // 10 minutes
const PAGE_FETCH_DELAY_MS = 500;
const DETAIL_FETCH_DELAY_MS = 500;
const MAX_DETAIL_PAGES_PER_CYCLE = 10;
const USER_AGENT = 'niejedzie.pl/1.0 (train delay tracker; contact@niejedzie.pl)';

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Initialize a new scraping session by fetching the delays page and extracting
 * cookies, CSRF tokens, and custom AJAX headers.
 */
async function initSession(kv: KVNamespace): Promise<ScrapingSession> {
	console.log('[scraper] Initializing new session');

	const res = await fetch(DELAYS_URL, {
		headers: {
			'User-Agent': USER_AGENT,
			'Accept': 'text/html,application/xhtml+xml',
			'Accept-Language': 'pl-PL,pl;q=0.9',
		},
		redirect: 'follow',
	});

	if (!res.ok) {
		throw new Error(`[scraper] Session init failed: ${res.status} ${res.statusText}`);
	}

	const html = await res.text();

	// Extract Set-Cookie headers
	// Workers runtime supports getAll on Headers via raw header access
	const setCookieHeaders: string[] = [];
	res.headers.forEach((value, key) => {
		if (key.toLowerCase() === 'set-cookie') {
			setCookieHeaders.push(value);
		}
	});
	const cookieStr = setCookieHeaders.join('; ');

	// Extract ASP.NET_SessionId
	const sessionIdMatch = cookieStr.match(/ASP\.NET_SessionId=([^;]+)/);
	if (!sessionIdMatch) {
		throw new Error('[scraper] Could not extract ASP.NET_SessionId from cookies');
	}
	const sessionId = sessionIdMatch[1];

	// Extract __RequestVerificationToken cookie
	const verificationCookieMatch = cookieStr.match(/__RequestVerificationToken=([^;]+)/);
	const verificationCookie = verificationCookieMatch ? verificationCookieMatch[1] : '';

	// Extract CSRF form token from HTML
	const csrfMatch = html.match(/__RequestVerificationToken.*?value="([^"]+)"/);
	const csrfToken = csrfMatch ? csrfMatch[1] : '';

	// Extract custom AJAX headers from inline script
	// Pattern: $.ajaxSetup({ headers: { 'KEY1': 'VAL1' } });
	const ajaxHeaders: Record<string, string> = {};
	const ajaxRegex = /ajaxSetup\s*\(\s*\{\s*headers\s*:\s*\{\s*'([^']+)'\s*:\s*'([^']+)'/g;
	let ajaxMatch: RegExpExecArray | null;
	while ((ajaxMatch = ajaxRegex.exec(html)) !== null) {
		ajaxHeaders[ajaxMatch[1]] = ajaxMatch[2];
	}

	const session: ScrapingSession = {
		sessionId,
		verificationCookie,
		csrfToken,
		ajaxHeaders,
		createdAt: Date.now(),
	};

	// Cache in KV
	await kv.put(SESSION_KV_KEY, JSON.stringify(session), { expirationTtl: SESSION_TTL });

	console.log(`[scraper] Session initialized — id=${sessionId.substring(0, 8)}..., ajaxHeaders=${Object.keys(ajaxHeaders).length}`);
	return session;
}

/**
 * Get an existing session from KV or create a new one if missing/expired.
 */
async function getOrRefreshSession(kv: KVNamespace): Promise<ScrapingSession> {
	const cached = await kv.get(SESSION_KV_KEY);
	if (cached) {
		try {
			const session: ScrapingSession = JSON.parse(cached);
			// Extra safety: reject sessions older than 10 minutes even if KV TTL hasn't kicked in
			if (Date.now() - session.createdAt < SESSION_TTL * 1000) {
				console.log('[scraper] Using cached session');
				return session;
			}
		} catch {
			// Corrupted cache — fall through to create new session
		}
	}
	return initSession(kv);
}

// ---------------------------------------------------------------------------
// Cookie builder
// ---------------------------------------------------------------------------

function buildCookieHeader(session: ScrapingSession): string {
	const parts = [`ASP.NET_SessionId=${session.sessionId}`];
	if (session.verificationCookie) {
		parts.push(`__RequestVerificationToken=${session.verificationCookie}`);
	}
	return parts.join('; ');
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single page of delay results from Portal Pasażera HTML.
 * Returns an array of ScrapedTrain objects extracted from the delays table.
 */
function parseDelaysPage(html: string): ScrapedTrain[] {
	const trains: ScrapedTrain[] = [];

	// Split HTML into individual delay rows
	const rowRegex = /delays-table__row[\s\S]*?(?=delays-table__row|delays-table__pagination|$)/g;
	const rows = html.match(rowRegex);

	if (!rows || rows.length === 0) {
		console.log('[scraper] No delay rows found on page');
		return trains;
	}

	for (const row of rows) {
		try {
			const train = parseDelayRow(row);
			if (train) {
				trains.push(train);
			}
		} catch (err) {
			console.warn(`[scraper] Failed to parse row: ${err}`);
		}
	}

	return trains;
}

/**
 * Parse a single delay row HTML fragment into a ScrapedTrain.
 */
function parseDelayRow(row: string): ScrapedTrain | null {
	// Carrier: bare text between spans, e.g. "</span> IC <span"
	// The HTML structure is: <span>Przewoźnik</span> IC <span lang="pl-PL">PKP Intercity S.A.</span>
	const carrierMatch = row.match(/Przewo[zź]nik<\/span>\s*(?:<[^>]*>\s*)*\s*(EIC|EIP|IC|TLK|KML|KW|KS|KD|REG|IR|PolRegio|SKM)\s/i)
		?? row.match(/<\/span>\s+(EIC|EIP|IC|TLK|KML|KW|KS|KD|REG|IR|PolRegio|SKM)\s+<span/i);
	const carrier = carrierMatch ? carrierMatch[1].trim().toUpperCase() : '';

	// Train name: <strong class="item-value" lang="pl-PL">TRAIN_NAME</strong>
	const nameMatch = row.match(/<strong[^>]*class="item-value"[^>]*lang="pl-PL"[^>]*>\s*([^<]+)\s*<\/strong>/);
	const trainName = nameMatch ? nameMatch[1].trim() : '';

	// Train number: digit-only value after "Nr pociągu" or "Nr poci"
	const numberMatch = row.match(/Nr\s+poci[aą]gu[\s\S]*?<strong[^>]*class="item-value"[^>]*>\s*(\d+)\s*<\/strong>/)
		?? row.match(/<strong[^>]*class="item-value"[^>]*>\s*(\d+)\s*<\/strong>/);
	const trainNumber = numberMatch ? numberMatch[1].trim() : '';

	// Route: two <span lang="pl-PL"> entries after "Relacja"
	const routeMatch = row.match(/Relacja[\s\S]*?<span[^>]*lang="pl-PL"[^>]*>\s*([^<]+)<\/span>[\s\S]*?<span[^>]*lang="pl-PL"[^>]*>\s*([^<]+)<\/span>/);
	const routeFrom = routeMatch ? routeMatch[1].trim() : '';
	const routeTo = routeMatch ? routeMatch[2].trim() : '';

	// Delay: number followed by "Min" after "Czas opóźnienia" or "czas op"
	const delayMatch = row.match(/[Cc]zas\s+op[oó][zź]nienia[\s\S]*?<strong[^>]*>\s*(\d+)\s*Min/i)
		?? row.match(/<strong[^>]*>\s*(\d+)\s*Min\s*<\/strong>/i);
	const delayMinutes = delayMatch ? parseInt(delayMatch[1], 10) : 0;

	// Detail URL: link to connection detail page
	const urlMatch = row.match(/href="([^"]*SzczegolyPolaczenia[^"]*)"/);
	const detailUrl = urlMatch ? urlMatch[1] : null;

	// Require at minimum a train number to consider this a valid row
	if (!trainNumber) {
		return null;
	}

	return {
		carrier,
		trainName,
		trainNumber,
		routeFrom,
		routeTo,
		delayMinutes,
		detailUrl,
	};
}

/**
 * Check if there is a next page link in the pagination HTML.
 * Returns the page number of the next page, or null if on the last page.
 */
function getNextPageNumber(html: string): number | null {
	// Look for pagination links — typically "next" arrow or numbered links
	// The current page is usually marked with an active/selected class
	const paginationMatch = html.match(/delays-table__pagination[\s\S]*?<\/div>/);
	if (!paginationMatch) return null;

	const pagination = paginationMatch[0];

	// Find the current active page number
	const activeMatch = pagination.match(/class="[^"]*active[^"]*"[^>]*>\s*(\d+)/);
	if (!activeMatch) return null;

	const currentPage = parseInt(activeMatch[1], 10);

	// Check if there's a link to currentPage + 1
	const nextPageStr = String(currentPage + 1);
	const nextLinkRegex = new RegExp(`href="[^"]*[?&]p=${nextPageStr}[^"]*"|>\\s*${nextPageStr}\\s*<`);
	if (nextLinkRegex.test(pagination)) {
		return currentPage + 1;
	}

	// Also check for a "next" arrow link
	const nextArrow = pagination.match(/class="[^"]*next[^"]*"[^>]*href="[^"]*[?&]p=(\d+)/);
	if (nextArrow) {
		return parseInt(nextArrow[1], 10);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Detail page parsing
// ---------------------------------------------------------------------------

/**
 * Decode HTML entities (&#x27;, &amp;, etc.) commonly found in station names.
 */
function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&#x([0-9A-Fa-f]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)))
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/**
 * Parse an HH:MM time string into total minutes since midnight.
 * Returns null if the string is not a valid time.
 */
function parseTimeToMinutes(timeStr: string): number | null {
	const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;
	const hours = parseInt(match[1], 10);
	const minutes = parseInt(match[2], 10);
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/**
 * Calculate delay in minutes between an actual and planned time.
 * Handles midnight crossing (e.g., planned 23:50, actual 00:10 = 20 min delay).
 * Returns null if either time is null.
 */
function calculateDelayMinutes(actualMinutes: number | null, plannedMinutes: number | null): number | null {
	if (actualMinutes === null || plannedMinutes === null) return null;
	let diff = actualMinutes - plannedMinutes;
	// Handle midnight crossing: if diff is very negative, the train crossed midnight
	if (diff < -720) {
		diff += 1440; // 24 * 60
	}
	// If diff is very positive (> 12 hours), it's likely the planned time was after midnight
	if (diff > 720) {
		diff -= 1440;
	}
	return diff;
}

/**
 * Convert an HH:MM time string into a full ISO datetime string for today.
 * Returns null if the input is not a valid time.
 */
function timeToIsoString(timeStr: string): string | null {
	const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;
	const today = new Date().toISOString().split('T')[0];
	const hours = match[1].padStart(2, '0');
	const minutes = match[2];
	return `${today}T${hours}:${minutes}:00`;
}

/**
 * Fetch and parse a train detail page to extract per-station timing data.
 *
 * The detail page contains a timeline with each station along the route,
 * including planned/actual arrival and departure times.
 *
 * Returns an array of ApiStation objects, or null if parsing fails.
 */
async function scrapeTrainDetail(session: ScrapingSession, detailUrl: string): Promise<ApiStation[] | null> {
	const fullUrl = `${PORTAL_BASE}${detailUrl}`;

	const res = await fetch(fullUrl, {
		headers: {
			'User-Agent': USER_AGENT,
			'Accept': 'text/html,application/xhtml+xml',
			'Accept-Language': 'pl-PL,pl;q=0.9',
			'Cookie': buildCookieHeader(session),
		},
		redirect: 'follow',
	});

	if (!res.ok) {
		console.warn(`[scraper:detail] Fetch failed: ${res.status} for ${detailUrl.substring(0, 80)}`);
		return null;
	}

	const html = await res.text();
	return parseTrainDetailPage(html);
}

/**
 * Parse the detail page HTML into an array of ApiStation objects.
 *
 * HTML structure:
 * - Each station is in a `timeline__content-station` block
 * - Station name is inside <h3>, after "Stacja N:" prefix
 * - Times are in `timeline__numbers-time__stop` blocks with HH:MM values
 * - Each station has up to 4 time slots: planned_arr, planned_dep, actual_arr, actual_dep
 * - First station (origin): departure only
 * - Last station (terminus): arrival only
 * - Intermediate stations: both arrival and departure
 */
function parseTrainDetailPage(html: string): ApiStation[] | null {
	const stations: ApiStation[] = [];

	// Extract station blocks — split by timeline station markers
	// Each station section contains the station name and its time data
	const stationBlockRegex = /timeline__content-station[\s\S]*?(?=timeline__content-station|timeline__footer|$)/g;
	const stationBlocks = html.match(stationBlockRegex);

	if (!stationBlocks || stationBlocks.length === 0) {
		console.warn('[scraper:detail] No station blocks found on detail page');
		return null;
	}

	for (let i = 0; i < stationBlocks.length; i++) {
		const block = stationBlocks[i];

		// Extract station name from <h3> tag, after "Stacja N:" prefix
		const nameMatch = block.match(/<h3[^>]*>[\s\S]*?Stacja\s+\d+:\s*([^<]+)<\/h3>/i)
			?? block.match(/<h3[^>]*>\s*([^<]+)<\/h3>/i);

		if (!nameMatch) continue;

		const stationName = decodeHtmlEntities(nameMatch[1].trim());

		// Extract all HH:MM time values from this block
		const timeRegex = /(\d{1,2}:\d{2})/g;
		const times: string[] = [];
		let timeMatch: RegExpExecArray | null;
		while ((timeMatch = timeRegex.exec(block)) !== null) {
			times.push(timeMatch[1]);
		}

		const isFirst = i === 0;
		const isLast = i === stationBlocks.length - 1;

		let plannedArrival: string | null = null;
		let plannedDeparture: string | null = null;
		let actualArrival: string | null = null;
		let actualDeparture: string | null = null;
		let arrivalDelayMinutes: number | null = null;
		let departureDelayMinutes: number | null = null;

		if (isFirst && times.length >= 2) {
			// Origin station: departure only
			// times[0] = planned departure, times[1] = actual departure
			plannedDeparture = timeToIsoString(times[0]);
			actualDeparture = timeToIsoString(times[1]);
			departureDelayMinutes = calculateDelayMinutes(
				parseTimeToMinutes(times[1]),
				parseTimeToMinutes(times[0]),
			);
		} else if (isLast && times.length >= 2) {
			// Terminus: arrival only
			// times[0] = planned arrival, times[1] = actual arrival
			plannedArrival = timeToIsoString(times[0]);
			actualArrival = timeToIsoString(times[1]);
			arrivalDelayMinutes = calculateDelayMinutes(
				parseTimeToMinutes(times[1]),
				parseTimeToMinutes(times[0]),
			);
		} else if (times.length >= 4) {
			// Intermediate station: arrival + departure
			// times[0] = planned arrival, times[1] = planned departure
			// times[2] = actual arrival, times[3] = actual departure
			plannedArrival = timeToIsoString(times[0]);
			plannedDeparture = timeToIsoString(times[1]);
			actualArrival = timeToIsoString(times[2]);
			actualDeparture = timeToIsoString(times[3]);
			arrivalDelayMinutes = calculateDelayMinutes(
				parseTimeToMinutes(times[2]),
				parseTimeToMinutes(times[0]),
			);
			departureDelayMinutes = calculateDelayMinutes(
				parseTimeToMinutes(times[3]),
				parseTimeToMinutes(times[1]),
			);
		} else if (times.length >= 2) {
			// Fallback: treat as arrival only if we can't determine position
			plannedArrival = timeToIsoString(times[0]);
			actualArrival = timeToIsoString(times[1]);
			arrivalDelayMinutes = calculateDelayMinutes(
				parseTimeToMinutes(times[1]),
				parseTimeToMinutes(times[0]),
			);
		}

		// Detect delay/cancellation status from CSS classes
		const hasAlert = /color--alert/i.test(block);
		const hasWarn = /color--warn/i.test(block);
		const isCancelled = /odwo[lł]an/i.test(block);

		stations.push({
			stationId: hashCode(stationName),
			stationName,
			sequenceNumber: i + 1,
			plannedArrival,
			plannedDeparture,
			actualArrival,
			actualDeparture,
			arrivalDelayMinutes,
			departureDelayMinutes,
			isConfirmed: hasAlert || hasWarn || (actualArrival !== null || actualDeparture !== null),
			isCancelled,
		});
	}

	if (stations.length === 0) {
		console.warn('[scraper:detail] Parsed 0 stations from detail page');
		return null;
	}

	return stations;
}

// ---------------------------------------------------------------------------
// Scraping orchestration
// ---------------------------------------------------------------------------

/**
 * Fetch all currently delayed trains from Portal Pasażera.
 * Handles pagination by fetching subsequent pages until exhausted.
 */
async function scrapeCurrentDelays(session: ScrapingSession): Promise<ScrapedTrain[]> {
	const allTrains: ScrapedTrain[] = [];
	const seenTrainNumbers = new Set<string>();
	let page = 1;
	const maxPages = 20; // Safety limit

	while (page <= maxPages) {
		console.log(`[scraper] Fetching delays page ${page}`);

		const url = new URL(DELAYS_TAB_URL);
		url.searchParams.set('s', '4'); // Current delays tab
		if (page > 1) {
			url.searchParams.set('p', String(page));
		}

		const res = await fetch(url.toString(), {
			headers: {
				'User-Agent': USER_AGENT,
				'Accept': 'text/html,application/xhtml+xml',
				'Accept-Language': 'pl-PL,pl;q=0.9',
				'Cookie': buildCookieHeader(session),
			},
			redirect: 'follow',
		});

		if (!res.ok) {
			console.warn(`[scraper] Page ${page} fetch failed: ${res.status}`);
			break;
		}

		const html = await res.text();
		const trains = parseDelaysPage(html);

		if (trains.length === 0) {
			console.log(`[scraper] No trains found on page ${page}, stopping`);
			break;
		}

		// Deduplicate by train number (in case of overlap between pages)
		for (const train of trains) {
			const key = `${train.carrier}-${train.trainNumber}`;
			if (!seenTrainNumbers.has(key)) {
				seenTrainNumbers.add(key);
				allTrains.push(train);
			}
		}

		// Check for next page
		const nextPage = getNextPageNumber(html);
		if (nextPage === null || nextPage <= page) {
			break;
		}

		page = nextPage;

		// Be respectful — delay between page fetches
		await sleep(PAGE_FETCH_DELAY_MS);
	}

	console.log(`[scraper] Scraped ${allTrains.length} delayed trains across ${page} page(s)`);
	return allTrains;
}

// ---------------------------------------------------------------------------
// Transform to API format
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic numeric hash from a string.
 * Used to create stable scheduleId values from train identifiers.
 */
function hashCode(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0; // Force 32-bit integer
	}
	return Math.abs(hash);
}

/**
 * Transform scraped trains into the ApiTrain[] format expected by the pipeline.
 *
 * When a detail map is provided, trains with per-station data from the detail
 * page will have full station arrays. Trains without detail data fall back to
 * a single summary station entry from the list view.
 */
function transformToApiFormat(
	scraped: ScrapedTrain[],
	detailMap: Map<string, ApiStation[]> = new Map(),
): ApiTrain[] {
	const today = new Date().toISOString().split('T')[0];
	const now = new Date().toISOString();

	return scraped.map((train): ApiTrain => {
		const fullTrainNumber = train.carrier
			? `${train.carrier} ${train.trainNumber}`
			: train.trainNumber;

		// Create a stable schedule ID from the train identity + date
		const scheduleId = hashCode(`${fullTrainNumber}-${today}`);

		// Check if we have detailed per-station data for this train
		const trainKey = `${train.carrier}-${train.trainNumber}`;
		const detailStations = detailMap.get(trainKey);

		let stations: ApiStation[];

		if (detailStations && detailStations.length > 0) {
			// Use the full per-station data from the detail page
			stations = detailStations;
		} else {
			// Fall back to a single station entry from the list view summary
			const station: ApiStation = {
				stationId: hashCode(train.routeTo || 'unknown'),
				stationName: train.routeTo || 'Nieznana',
				sequenceNumber: 1,
				plannedArrival: now,
				plannedDeparture: null,
				actualArrival: null,
				actualDeparture: null,
				arrivalDelayMinutes: train.delayMinutes,
				departureDelayMinutes: null,
				isConfirmed: true,
				isCancelled: false,
			};
			stations = [station];
		}

		return {
			scheduleId,
			orderId: 0,
			trainNumber: fullTrainNumber,
			carrier: train.carrier || undefined,
			category: train.carrier || undefined,
			routeStartStation: train.routeFrom || undefined,
			routeEndStation: train.routeTo || undefined,
			stations,
		};
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch detail pages for the top N scraped trains and enrich them with
 * per-station timing data. Respects rate limits with delays between requests.
 *
 * Returns a Map of train key → ApiStation[] for trains that were successfully
 * enriched with detail data.
 */
async function fetchTrainDetails(
	session: ScrapingSession,
	scraped: ScrapedTrain[],
): Promise<Map<string, ApiStation[]>> {
	const detailMap = new Map<string, ApiStation[]>();

	// Only fetch details for trains that have a detail URL
	const trainsWithDetails = scraped.filter((t) => t.detailUrl !== null);

	// Sort by delay descending — prioritize the most delayed trains
	trainsWithDetails.sort((a, b) => b.delayMinutes - a.delayMinutes);

	// Limit to MAX_DETAIL_PAGES_PER_CYCLE per cycle
	const toFetch = trainsWithDetails.slice(0, MAX_DETAIL_PAGES_PER_CYCLE);

	if (toFetch.length === 0) {
		console.log('[scraper:detail] No trains have detail URLs');
		return detailMap;
	}

	console.log(`[scraper:detail] Fetching ${toFetch.length} detail pages (of ${trainsWithDetails.length} available)`);

	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < toFetch.length; i++) {
		const train = toFetch[i];
		const trainKey = `${train.carrier}-${train.trainNumber}`;

		try {
			const stations = await scrapeTrainDetail(session, train.detailUrl!);
			if (stations && stations.length > 0) {
				detailMap.set(trainKey, stations);
				successCount++;
			} else {
				failCount++;
			}
		} catch (err) {
			console.warn(`[scraper:detail] Failed for ${trainKey}: ${err}`);
			failCount++;
		}

		// Delay between requests (skip after the last one)
		if (i < toFetch.length - 1) {
			await sleep(DETAIL_FETCH_DELAY_MS);
		}
	}

	console.log(`[scraper:detail] Fetched ${successCount} detail pages (${failCount} failed)`);
	return detailMap;
}

/**
 * Main entry point — fetch delay data from Portal Pasażera scraper.
 *
 * Handles the full flow: session management, scraping, detail page enrichment,
 * and transformation. Returns ApiTrain[] compatible with the existing pipeline,
 * or null on failure.
 */
export async function fetchFromScraper(env: Env): Promise<ApiTrain[] | null> {
	try {
		console.log('[scraper] Starting Portal Pasażera scrape');

		const session = await getOrRefreshSession(env.DELAYS_KV);
		const scraped = await scrapeCurrentDelays(session);

		if (scraped.length === 0) {
			console.warn('[scraper] No delayed trains found');
			return [];
		}

		// Fetch per-station detail pages for top trains
		const detailMap = await fetchTrainDetails(session, scraped);

		const trains = transformToApiFormat(scraped, detailMap);
		console.log(`[scraper] Transformed ${trains.length} trains to API format (${detailMap.size} with station details)`);

		return trains;
	} catch (err) {
		console.error(`[scraper] Fatal error: ${err}`);
		return null;
	}
}
