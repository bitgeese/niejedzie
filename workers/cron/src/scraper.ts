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
	// Carrier: text after "Przewoźnik</span>" or carrier indicator
	// Common carriers: IC, TLK, EIC, EIP, KML, KW, REG
	const carrierMatch = row.match(/Przewo[zź]nik<\/span>\s*(?:<[^>]*>)*\s*([A-ZŁ]{2,4})/i)
		?? row.match(/class="[^"]*carrier[^"]*"[^>]*>\s*([A-ZŁ]{2,4})/i)
		?? row.match(/<strong[^>]*>\s*(EIC|EIP|IC|TLK|KML|KW|REG|IR)\s*<\/strong>/i);
	const carrier = carrierMatch ? carrierMatch[1].trim() : '';

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
 * Since Portal Pasażera's list view only gives us summary delay info (not
 * per-station breakdowns), we create a simplified ApiTrain with a single
 * station entry representing the last known delay.
 */
function transformToApiFormat(scraped: ScrapedTrain[]): ApiTrain[] {
	const today = new Date().toISOString().split('T')[0];
	const now = new Date().toISOString();

	return scraped.map((train): ApiTrain => {
		const fullTrainNumber = train.carrier
			? `${train.carrier} ${train.trainNumber}`
			: train.trainNumber;

		// Create a stable schedule ID from the train identity + date
		const scheduleId = hashCode(`${fullTrainNumber}-${today}`);

		// Build a single station entry representing the current delay state.
		// We use the destination as the station since the delay is the overall delay.
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

		return {
			scheduleId,
			orderId: 0,
			trainNumber: fullTrainNumber,
			carrier: train.carrier || undefined,
			category: train.carrier || undefined,
			routeStartStation: train.routeFrom || undefined,
			routeEndStation: train.routeTo || undefined,
			stations: [station],
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
 * Main entry point — fetch delay data from Portal Pasażera scraper.
 *
 * Handles the full flow: session management, scraping, and transformation.
 * Returns ApiTrain[] compatible with the existing pipeline, or null on failure.
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

		const trains = transformToApiFormat(scraped);
		console.log(`[scraper] Transformed ${trains.length} trains to API format`);

		return trains;
	} catch (err) {
		console.error(`[scraper] Fatal error: ${err}`);
		return null;
	}
}
