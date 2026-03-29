// scraper.ts — Portal Pasażera (portalpasazera.pl) web scraper
//
// Alternative data source for niejedzie.pl when the PKP PLK API is unavailable.
// Scrapes the public delays page at portalpasazera.pl/Opoznienia to extract
// currently delayed trains and transforms them into the ApiTrain format used
// by the rest of the pipeline.
//
// Enhanced with Claude AI for intelligent station name cleaning and validation.

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
	ANTHROPIC_API_KEY?: string;
}

/** Real-time punctuality stats from Portal Pasażera s=1 page */
export interface PortalStats {
	onRoute: number | null;      // % of trains on route that are on time
	departed: number | null;     // % of trains that departed on time
	completed: number | null;    // % of completed trains that were on time
	startedPct: number | null;   // % of scheduled trains that have actually started
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
const DETAIL_FETCH_DELAY_MS = 400;  // Slightly faster for more coverage
const MAX_DETAIL_PAGES_PER_CYCLE = 15;  // Increased from 10 to 15 for better coverage
const USER_AGENT = 'niejedzie.pl/1.0 (train delay tracker; contact@niejedzie.pl)';

// ---------------------------------------------------------------------------
// Claude AI Station Name Cleaning
// ---------------------------------------------------------------------------

interface CleanStationResult {
	cleanName: string;
	confidence: 'high' | 'medium' | 'low';
	originalName: string;
}

/**
 * Clean and standardize Polish station names using Claude AI
 */
async function cleanStationName(rawName: string, env: Env): Promise<CleanStationResult> {
	// Skip if no API key available
	if (!env.ANTHROPIC_API_KEY || !rawName || rawName.trim() === '') {
		return {
			cleanName: rawName || 'Nieznana',
			confidence: 'low',
			originalName: rawName || ''
		};
	}

	// Cache cleaned names to avoid redundant API calls
	const cacheKey = `station:clean:${rawName}`;
	try {
		const cached = await env.DELAYS_KV.get(cacheKey);
		if (cached) {
			const result = JSON.parse(cached) as CleanStationResult;
			return result;
		}
	} catch (err) {
		console.warn(`[scraper] Station cache read failed: ${err}`);
	}

	try {
		const prompt = `Clean and standardize this Polish railway station name: "${rawName}"

Rules:
1. Fix encoding issues (ą, ć, ę, ł, ń, ó, ś, ź, ż)
2. Use official PKP station naming format
3. Remove HTML artifacts or extra whitespace
4. Keep original if already correct
5. If unclear/ambiguous, return original name (don't guess)

Return ONLY the cleaned station name, no explanation.`;

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-API-Key': env.ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: 'claude-3-haiku-20240307',
				max_tokens: 50,
				messages: [{
					role: 'user',
					content: prompt
				}]
			}),
		});

		if (!response.ok) {
			throw new Error(`Claude API error: ${response.status}`);
		}

		const data = await response.json() as { content: { text: string }[] };
		const cleanName = data.content[0]?.text?.trim() || rawName;

		const result: CleanStationResult = {
			cleanName,
			confidence: cleanName === rawName ? 'high' : 'medium',
			originalName: rawName
		};

		// Cache for 24 hours
		await env.DELAYS_KV.put(cacheKey, JSON.stringify(result), {
			expirationTtl: 86400
		});

		console.log(`[scraper] Cleaned station: "${rawName}" → "${cleanName}"`);
		return result;

	} catch (err) {
		console.error(`[scraper] Station cleaning failed for "${rawName}": ${err}`);
		return {
			cleanName: rawName,
			confidence: 'low',
			originalName: rawName
		};
	}
}

/**
 * Batch clean multiple station names efficiently
 */
async function batchCleanStationNames(
	stationNames: string[],
	env: Env
): Promise<Map<string, CleanStationResult>> {
	const results = new Map<string, CleanStationResult>();
	const uniqueNames = [...new Set(stationNames.filter(name => name && name.trim()))];

	if (uniqueNames.length === 0) return results;

	console.log(`[scraper] Batch cleaning ${uniqueNames.length} unique station names`);

	// Process in batches to avoid overwhelming the API
	const BATCH_SIZE = 5;
	for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
		const batch = uniqueNames.slice(i, i + BATCH_SIZE);

		const promises = batch.map(async (name) => {
			const result = await cleanStationName(name, env);
			results.set(name, result);
			return result;
		});

		await Promise.all(promises);

		// Rate limiting - pause between batches
		if (i + BATCH_SIZE < uniqueNames.length) {
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}

	return results;
}

/**
 * Clean station names in the detail map using Claude AI
 */
async function cleanStationNamesInDetailMap(
	detailMap: Map<string, ApiStation[]>,
	env: Env
): Promise<Map<string, ApiStation[]>> {
	const cleanedDetailMap = new Map<string, ApiStation[]>();

	if (detailMap.size === 0) {
		return cleanedDetailMap;
	}

	// Collect all unique station names from detail map
	const allStationNames: string[] = [];
	for (const stations of detailMap.values()) {
		for (const station of stations) {
			allStationNames.push(station.stationName);
		}
	}

	// Batch clean all unique station names
	const cleaningResults = await batchCleanStationNames(allStationNames, env);

	// Apply cleaning results to detail map
	for (const [trainKey, stations] of detailMap) {
		const cleanedStations: ApiStation[] = stations.map(station => {
			const cleanResult = cleaningResults.get(station.stationName);
			if (cleanResult && cleanResult.confidence !== 'low') {
				return {
					...station,
					stationName: cleanResult.cleanName
				};
			}
			return station;
		});

		cleanedDetailMap.set(trainKey, cleanedStations);
	}

	const totalCleaned = Array.from(cleaningResults.values())
		.filter(result => result.cleanName !== result.originalName).length;

	console.log(`[scraper] Cleaned ${totalCleaned} station names out of ${cleaningResults.size} unique names`);

	return cleanedDetailMap;
}

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
// Enhanced Session Management with Circuit Breaker
// ---------------------------------------------------------------------------

interface SessionPool {
	sessions: ScrapingSession[];
	failures: number;
	lastFailure: number;
	circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

const SESSION_POOL_KEY = 'scraper:session:pool';
const MAX_POOL_SIZE = 3;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_TIMEOUT_MS = 300000; // 5 minutes
const BACKOFF_BASE_DELAY_MS = 1000;
const MAX_BACKOFF_DELAY_MS = 30000;

/**
 * Enhanced session manager with circuit breaker pattern
 */
class RobustSessionManager {
	private env: Env;
	private kv: KVNamespace;

	constructor(env: Env) {
		this.env = env;
		this.kv = env.DELAYS_KV;
	}

	async getWorkingSession(): Promise<ScrapingSession | null> {
		const pool = await this.getSessionPool();

		// Check circuit breaker state
		if (pool.circuitState === 'OPEN') {
			if (Date.now() - pool.lastFailure > CIRCUIT_TIMEOUT_MS) {
				pool.circuitState = 'HALF_OPEN';
				console.log('[scraper] Circuit breaker: transitioning to HALF_OPEN');
			} else {
				console.error('[scraper] Circuit breaker: OPEN - session creation blocked');
				return null;
			}
		}

		// Try existing sessions from pool first
		for (const session of pool.sessions) {
			if (this.isSessionValid(session)) {
				console.log('[scraper] Using pooled session');
				return session;
			}
		}

		// Try to create new session with circuit breaker protection
		try {
			const newSession = await this.createSessionWithRetry();
			if (newSession) {
				await this.addSessionToPool(newSession, pool);
				this.onSessionSuccess(pool);
				return newSession;
			}
		} catch (err) {
			console.error(`[scraper] Session creation failed: ${err}`);
			this.onSessionFailure(pool, err);
		}

		return null;
	}

	private async createSessionWithRetry(): Promise<ScrapingSession | null> {
		let attempt = 0;
		const maxAttempts = 3;

		while (attempt < maxAttempts) {
			try {
				const delay = Math.min(
					BACKOFF_BASE_DELAY_MS * Math.pow(2, attempt),
					MAX_BACKOFF_DELAY_MS
				);

				if (attempt > 0) {
					console.log(`[scraper] Retrying session creation (attempt ${attempt + 1}/${maxAttempts}) after ${delay}ms`);
					await this.sleep(delay);
				}

				return await initSession(this.kv);
			} catch (err) {
				attempt++;
				console.warn(`[scraper] Session creation attempt ${attempt} failed: ${err}`);

				if (attempt >= maxAttempts) {
					throw err;
				}
			}
		}

		return null;
	}

	private async getSessionPool(): Promise<SessionPool> {
		try {
			const cached = await this.kv.get(SESSION_POOL_KEY);
			if (cached) {
				return JSON.parse(cached) as SessionPool;
			}
		} catch (err) {
			console.warn(`[scraper] Failed to read session pool: ${err}`);
		}

		return {
			sessions: [],
			failures: 0,
			lastFailure: 0,
			circuitState: 'CLOSED'
		};
	}

	private async saveSessionPool(pool: SessionPool): Promise<void> {
		try {
			await this.kv.put(SESSION_POOL_KEY, JSON.stringify(pool), {
				expirationTtl: SESSION_TTL
			});
		} catch (err) {
			console.warn(`[scraper] Failed to save session pool: ${err}`);
		}
	}

	private async addSessionToPool(session: ScrapingSession, pool: SessionPool): Promise<void> {
		// Remove expired sessions and limit pool size
		pool.sessions = pool.sessions
			.filter(s => this.isSessionValid(s))
			.slice(0, MAX_POOL_SIZE - 1);

		pool.sessions.unshift(session);
		await this.saveSessionPool(pool);
	}

	private isSessionValid(session: ScrapingSession): boolean {
		const ageMs = Date.now() - session.createdAt;
		return ageMs < (SESSION_TTL * 1000);
	}

	private async onSessionSuccess(pool: SessionPool): Promise<void> {
		// Reset circuit breaker on success
		if (pool.circuitState !== 'CLOSED') {
			pool.circuitState = 'CLOSED';
			pool.failures = 0;
			console.log('[scraper] Circuit breaker: reset to CLOSED after successful session');
			await this.saveSessionPool(pool);
		}
	}

	private async onSessionFailure(pool: SessionPool, error: any): Promise<void> {
		pool.failures++;
		pool.lastFailure = Date.now();

		if (pool.failures >= CIRCUIT_FAILURE_THRESHOLD) {
			pool.circuitState = 'OPEN';
			console.error(`[scraper] Circuit breaker: OPEN after ${pool.failures} failures`);
		}

		await this.saveSessionPool(pool);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

/**
 * Get a working session using the robust session manager
 */
async function getEnhancedSession(env: Env): Promise<ScrapingSession | null> {
	const manager = new RobustSessionManager(env);
	return await manager.getWorkingSession();
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
 * Validate and normalize an HH:MM time string. Pads hours to 2 digits.
 * Returns "HH:MM" or null if invalid.
 */
function normalizeTime(timeStr: string): string | null {
	const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;
	return `${match[1].padStart(2, '0')}:${match[2]}`;
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
	// Handle both absolute and relative detail URLs from the list page HTML
	const fullUrl = detailUrl.startsWith('http')
		? detailUrl
		: `${PORTAL_BASE}${detailUrl.startsWith('/') ? '' : '/'}${detailUrl}`;

	// NEW: Session state validation logging
	const sessionAge = Date.now() - session.createdAt;
	const sessionAgeMinutes = Math.floor(sessionAge / 60000);
	console.log(`[DEBUG] scrapeTrainDetail: Session age=${sessionAgeMinutes}min, URL=${fullUrl.slice(0, 80)}...`);

	// NEW: Check if URL contains pid token (session-specific)
	const hasPidToken = detailUrl.includes('pid=');
	console.log(`[DEBUG] scrapeTrainDetail: Has PID token=${hasPidToken}, Cookies available=${!!session.verificationCookie}`);

	let res: Response;
	try {
		// Add timeout to detail page fetches
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

		res = await fetch(fullUrl, {
			headers: {
				'User-Agent': USER_AGENT,
				'Accept': 'text/html,application/xhtml+xml',
				'Accept-Language': 'pl-PL,pl;q=0.9',
				'Cookie': buildCookieHeader(session),
			},
			redirect: 'manual',
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
	} catch (err) {
		if (err.name === 'AbortError') {
			console.warn(`[scraper:detail] Request timeout for ${fullUrl}`);
		} else {
			console.warn(`[scraper:detail] Fetch error for ${fullUrl}: ${err}`);
		}
		return null;
	}

	// Detect redirects — a 302 typically means the pid is invalid
	// (session mismatch or expired page context)
	if (res.status >= 300 && res.status < 400) {
		const location = res.headers.get('location') || '';
		console.warn(`[scraper:detail] Redirect ${res.status} → ${location} for ${detailUrl.substring(0, 80)} (likely stale pid/session)`);
		return null;
	}

	if (!res.ok) {
		console.warn(`[scraper:detail] Fetch failed: ${res.status} for ${detailUrl.substring(0, 80)}`);
		return null;
	}

	const html = await res.text();

	// Sanity check: if the response is a homepage or non-detail page,
	// it won't contain timeline station blocks. Log the page size for debugging.
	if (!html.includes('timeline__content-station') && !html.includes('SzczegolyPolaczenia')) {
		console.warn(`[scraper:detail] Response doesn't look like a detail page (${html.length} bytes) for ${detailUrl.substring(0, 80)}`);
		return null;
	}

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
		console.warn('[scraper:detail] No station blocks found in HTML');
		return null;
	}

	for (let i = 0; i < stationBlocks.length; i++) {
		const block = stationBlocks[i];

		// Extract station name from various HTML structures
		const stationNameRegex = [
			// NEW: Current Portal Pasażera structure with visuallyhidden span
			/<span class="visuallyhidden">Stacja\s+\d+:\s*<\/span>([^<\n]+)/i,
			// NEW: Alternative span pattern
			/<span[^>]*>Stacja\s+\d+:\s*<\/span>\s*([^<\n]+)/i,
			// Original patterns (keep as fallbacks)
			/<h3[^>]*>[\s\S]*?Stacja\s+\d+:\s*([^<]+)<\/h3>/i,
			/<h3[^>]*>\s*([^<]+)<\/h3>/i,
			/<h[2-4][^>]*>([^<]+)<\/h[2-4]>/i,
			/class="station[^"]*"[^>]*>([^<]+)</i,
			/data-station[^>]*>([^<]+)</i,
		];

		let nameMatch = null;
		for (const regex of stationNameRegex) {
			nameMatch = block.match(regex);
			if (nameMatch) break;
		}

		if (!nameMatch) {
			continue;
		}

		// Filter out non-station messages (redirects, errors, etc.)
		const rawStationName = nameMatch[1].trim();
		const isRedirectMessage = rawStationName.toLowerCase().includes('przekierowywanie') ||
			rawStationName.toLowerCase().includes('redirect') ||
			rawStationName.toLowerCase().includes('sprzedaż') ||
			rawStationName.toLowerCase().includes('biletów') ||
			rawStationName.toLowerCase().includes('system') ||
			rawStationName.toLowerCase().includes('trwa') ||
			rawStationName.startsWith('Trwa ');
		const isTooLong = rawStationName.length > 50; // Real station names are typically shorter

		if (isRedirectMessage || isTooLong) {
			continue;
		}

		const stationName = decodeHtmlEntities(rawStationName);

		// Extract all HH:MM time values from this block
		// NEW: More robust time extraction with context validation
		const timeContainers = block.match(/<div[^>]*time[^>]*>[\s\S]*?<\/div>/gi) || [];
		const timeRegex = /(\d{1,2}:\d{2})/g;
		let times: string[] = [];

		// Try to extract times from time-specific containers first
		if (timeContainers.length > 0) {
			for (const container of timeContainers) {
				let timeMatch: RegExpExecArray | null;
				while ((timeMatch = timeRegex.exec(container)) !== null) {
					times.push(timeMatch[1]);
				}
			}
		}

		// Fallback to extracting all times from the block if no time containers found
		if (times.length === 0) {
			let timeMatch: RegExpExecArray | null;
			timeRegex.lastIndex = 0; // Reset regex
			while ((timeMatch = timeRegex.exec(block)) !== null) {
				times.push(timeMatch[1]);
			}
		}

		// PHASE 1 FIX: Add time extraction validation
		if (times.length === 0) {
			console.warn(`[scraper:detail] Station ${i + 1}: No times extracted from HTML block`);
			console.warn(`[DEBUG] Block sample: ${block.slice(0, 200)}`);
			continue;
		}

		// Validate time format immediately
		const validTimes = times.filter(time => /^(\d{1,2}):(\d{2})$/.test(time));
		if (validTimes.length !== times.length) {
			console.warn(`[scraper:detail] Station ${i + 1}: Filtered invalid times from ${times.length} to ${validTimes.length}`);
			times = validTimes;
		}

		const isFirst = i === 0;
		const isLast = i === stationBlocks.length - 1;
		const isIntermediate = !isFirst && !isLast;

		let plannedArrival: string | null = null;
		let plannedDeparture: string | null = null;
		let actualArrival: string | null = null;
		let actualDeparture: string | null = null;
		let arrivalDelayMinutes: number | null = null;
		let departureDelayMinutes: number | null = null;

		if (isFirst && times.length >= 2) {
			// Origin station: departure only
			// times[0] = planned departure, times[1] = actual departure
			plannedDeparture = normalizeTime(times[0]);
			actualDeparture = normalizeTime(times[1]);
			departureDelayMinutes = calculateDelayMinutes(
				parseTimeToMinutes(times[1]),
				parseTimeToMinutes(times[0]),
			);
		} else if (isLast && times.length >= 2) {
			// Terminus: arrival only
			// times[0] = planned arrival, times[1] = actual arrival
			plannedArrival = normalizeTime(times[0]);

			// CRITICAL FIX: Validate actual time to detect 00:00:00 artifacts
			const actualTime = times[1];
			const plannedTime = times[0];
			if (actualTime === '00:00' && plannedTime !== '00:00') {
				// Likely data artifact - actual 00:00 when planned is not 00:00
				const plannedMinutes = parseTimeToMinutes(plannedTime);
				if (plannedMinutes > 12 * 60) { // Planned after noon, actual 00:00 is suspicious
					console.warn(`[scraper:validation] Rejecting suspicious 00:00 actual time for planned ${plannedTime} at station ${stationName}`);
					actualArrival = null;
					arrivalDelayMinutes = null;
				} else {
					actualArrival = normalizeTime(actualTime);
					arrivalDelayMinutes = calculateDelayMinutes(
						parseTimeToMinutes(actualTime),
						parseTimeToMinutes(plannedTime),
					);
				}
			} else {
				actualArrival = normalizeTime(actualTime);
				arrivalDelayMinutes = calculateDelayMinutes(
					parseTimeToMinutes(actualTime),
					parseTimeToMinutes(plannedTime),
				);
			}
		} else if (times.length >= 4) {
			// Intermediate station: arrival + departure
			// times[0] = planned arrival, times[1] = planned departure
			// times[2] = actual arrival, times[3] = actual departure
			plannedArrival = normalizeTime(times[0]);
			plannedDeparture = normalizeTime(times[1]);

			// CRITICAL FIX: Validate actual times to detect 00:00:00 artifacts
			const actualArrTime = times[2];
			const plannedArrTime = times[0];
			const actualDepTime = times[3];
			const plannedDepTime = times[1];

			// Validate actual arrival time
			if (actualArrTime === '00:00' && plannedArrTime !== '00:00') {
				const plannedMinutes = parseTimeToMinutes(plannedArrTime);
				if (plannedMinutes > 12 * 60) { // Planned after noon, actual 00:00 is suspicious
					console.warn(`[scraper:validation] Rejecting suspicious 00:00 actual arrival for planned ${plannedArrTime} at station ${stationName}`);
					actualArrival = null;
					arrivalDelayMinutes = null;
				} else {
					actualArrival = normalizeTime(actualArrTime);
					arrivalDelayMinutes = calculateDelayMinutes(
						parseTimeToMinutes(actualArrTime),
						parseTimeToMinutes(plannedArrTime),
					);
				}
			} else {
				actualArrival = normalizeTime(actualArrTime);
				arrivalDelayMinutes = calculateDelayMinutes(
					parseTimeToMinutes(actualArrTime),
					parseTimeToMinutes(plannedArrTime),
				);
			}

			// Validate actual departure time
			if (actualDepTime === '00:00' && plannedDepTime !== '00:00') {
				const plannedMinutes = parseTimeToMinutes(plannedDepTime);
				if (plannedMinutes > 12 * 60) { // Planned after noon, actual 00:00 is suspicious
					console.warn(`[scraper:validation] Rejecting suspicious 00:00 actual departure for planned ${plannedDepTime} at station ${stationName}`);
					actualDeparture = null;
					departureDelayMinutes = null;
				} else {
					actualDeparture = normalizeTime(actualDepTime);
					departureDelayMinutes = calculateDelayMinutes(
						parseTimeToMinutes(actualDepTime),
						parseTimeToMinutes(plannedDepTime),
					);
				}
			} else {
				actualDeparture = normalizeTime(actualDepTime);
				departureDelayMinutes = calculateDelayMinutes(
					parseTimeToMinutes(actualDepTime),
					parseTimeToMinutes(plannedDepTime),
				);
			}
		} else if (times.length >= 2) {
			// Fallback: treat as arrival only if we can't determine position
			plannedArrival = normalizeTime(times[0]);

			// CRITICAL FIX: Validate actual time to detect 00:00:00 artifacts
			const actualTime = times[1];
			const plannedTime = times[0];
			if (actualTime === '00:00' && plannedTime !== '00:00') {
				const plannedMinutes = parseTimeToMinutes(plannedTime);
				if (plannedMinutes > 12 * 60) { // Planned after noon, actual 00:00 is suspicious
					console.warn(`[scraper:validation] Rejecting suspicious 00:00 actual time for planned ${plannedTime} at station ${stationName}`);
					actualArrival = null;
					arrivalDelayMinutes = null;
				} else {
					actualArrival = normalizeTime(actualTime);
					arrivalDelayMinutes = calculateDelayMinutes(
						parseTimeToMinutes(actualTime),
						parseTimeToMinutes(plannedTime),
					);
				}
			} else {
				actualArrival = normalizeTime(actualTime);
				arrivalDelayMinutes = calculateDelayMinutes(
					parseTimeToMinutes(actualTime),
					parseTimeToMinutes(plannedTime),
				);
			}
		} else {
			// EXPLICIT HANDLING for times.length < 2
			console.warn(`[scraper:detail] Station ${i + 1} (${stationName}): Insufficient time data (${times.length} times found), skipping station`);
			console.warn(`[DEBUG] Times found: [${times.join(', ')}]`);
			console.warn(`[DEBUG] HTML block sample: ${block.slice(0, 300)}`);
			continue; // Skip this station entirely instead of creating null-time station
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
 * Update session cookies from a fetch response.
 * The server may rotate or add cookies on any response (especially the list page).
 * We need to capture these so that subsequent detail page fetches use the same
 * session context that generated the `pid` tokens in the detail URLs.
 */
function updateSessionFromResponse(session: ScrapingSession, res: Response): void {
	const setCookieHeaders: string[] = [];
	res.headers.forEach((value, key) => {
		if (key.toLowerCase() === 'set-cookie') {
			setCookieHeaders.push(value);
		}
	});

	if (setCookieHeaders.length === 0) return;

	const cookieStr = setCookieHeaders.join('; ');

	const sessionIdMatch = cookieStr.match(/ASP\.NET_SessionId=([^;]+)/);
	if (sessionIdMatch) {
		const oldId = session.sessionId.substring(0, 8);
		session.sessionId = sessionIdMatch[1];
		console.log(`[scraper] Session cookie rotated: ${oldId}... → ${session.sessionId.substring(0, 8)}...`);
	}

	const verificationMatch = cookieStr.match(/__RequestVerificationToken=([^;]+)/);
	if (verificationMatch) {
		session.verificationCookie = verificationMatch[1];
	}
}

/**
 * Fetch all currently delayed trains from Portal Pasażera.
 * Handles pagination by fetching subsequent pages until exhausted.
 *
 * IMPORTANT: This function mutates the session object to capture any
 * rotated cookies from the list page responses. The updated session
 * must be used for subsequent detail page fetches so that the `pid`
 * tokens in detail URLs are recognized by the server.
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

		let res: Response;
		try {
			// Add timeout to fetch requests
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

			res = await fetch(url.toString(), {
				headers: {
					'User-Agent': USER_AGENT,
					'Accept': 'text/html,application/xhtml+xml',
					'Accept-Language': 'pl-PL,pl;q=0.9',
					'Cookie': buildCookieHeader(session),
				},
				redirect: 'follow',
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				if (res.status === 503 || res.status === 502) {
					console.warn(`[scraper] Page ${page} server error: ${res.status} - retrying after delay`);
					await new Promise(resolve => setTimeout(resolve, 2000));
					continue;
				}
				console.warn(`[scraper] Page ${page} fetch failed: ${res.status}`);
				break;
			}
		} catch (err) {
			if (err.name === 'AbortError') {
				console.warn(`[scraper] Page ${page} fetch timed out`);
			} else {
				console.warn(`[scraper] Page ${page} fetch error: ${err}`);
			}

			// Exponential backoff for retries
			if (page <= 3) {
				const delay = Math.min(2000 * Math.pow(2, page - 1), 8000);
				await new Promise(resolve => setTimeout(resolve, delay));
				continue;
			}
			break;
		}

		// Capture any rotated session cookies from the response.
		// The detail URLs (pid tokens) in the HTML body are tied to the
		// server-side session state after this response — we need the
		// matching cookies for detail page fetches to work.
		updateSessionFromResponse(session, res);

		let html: string;
		let trains: ScrapedTrain[];

		try {
			html = await res.text();
			trains = parseDelaysPage(html);

			if (trains.length === 0) {
				console.log(`[scraper] No trains found on page ${page}, stopping`);
				break;
			}
		} catch (err) {
			console.warn(`[scraper] Failed to parse page ${page}: ${err}`);
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
async function transformToApiFormat(
	scraped: ScrapedTrain[],
	detailMap: Map<string, ApiStation[]> = new Map(),
	env: Env,
): Promise<ApiTrain[]> {
	const today = new Date().toISOString().split('T')[0];
	const now = new Date().toISOString();

	const transformedTrains: ApiTrain[] = [];
	let skippedCount = 0;

	for (const train of scraped) {
		const fullTrainNumber = train.carrier
			? `${train.carrier} ${train.trainNumber}`
			: train.trainNumber;

		// Create a stable schedule ID from the train identity + date
		const scheduleId = hashCode(`${fullTrainNumber}-${today}`);

		// Check if we have detailed per-station data for this train
		// Handle null/undefined carrier consistently
		const carrier = train.carrier || '';
		const trainKey = `${carrier}-${train.trainNumber}`;
		const detailStations = detailMap.get(trainKey);

		let stations: ApiStation[];

		if (detailStations && detailStations.length > 0) {
			// Use the full per-station data from the detail page
			console.log(`[transform] Using detailed data for ${trainKey}: ${detailStations.length} stations`);
			stations = detailStations;
		} else {
			console.log(`[transform] Skipping ${trainKey}: no detailed station data available`);
			// STATION NAME MAPPING BUG FIX: Don't create misleading fallback stations
			// When detail page scraping fails, skip this train entirely rather than
			// creating fake single-station entries with just the destination name
			skippedCount++;
			continue;
		}

		// NEW: Auto-populate route start/end from station data when missing
		let routeStart = train.routeFrom;
		let routeEnd = train.routeTo;

		if ((!routeStart || !routeEnd) && stations.length > 1) {
			// Use first and last station from detailed station data
			const sortedStations = [...stations].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
			if (!routeStart && sortedStations[0]?.stationName) {
				routeStart = sortedStations[0].stationName;
				console.log(`[DEBUG] Auto-populated route start: ${routeStart} for train ${fullTrainNumber}`);
			}
			if (!routeEnd && sortedStations[sortedStations.length - 1]?.stationName) {
				routeEnd = sortedStations[sortedStations.length - 1].stationName;
				console.log(`[DEBUG] Auto-populated route end: ${routeEnd} for train ${fullTrainNumber}`);
			}
		}

		const apiTrain: ApiTrain = {
			scheduleId,
			orderId: 0,
			trainNumber: fullTrainNumber,
			carrier: train.carrier || undefined,
			category: train.carrier || undefined,
			routeStartStation: routeStart || undefined,
			routeEndStation: routeEnd || undefined,
			stations,
		};

		transformedTrains.push(apiTrain);
	}

	console.log(`[transform] Processed ${scraped.length} trains: ${transformedTrains.length} with station data, ${skippedCount} skipped (no detail data)`);

	return transformedTrains;
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

	console.log(`[scraper:detail] ${trainsWithDetails.length} of ${scraped.length} trains have detail URLs`);

	// Sort by delay descending — prioritize the most delayed trains
	trainsWithDetails.sort((a, b) => b.delayMinutes - a.delayMinutes);

	// Limit to MAX_DETAIL_PAGES_PER_CYCLE per cycle
	const toFetch = trainsWithDetails.slice(0, MAX_DETAIL_PAGES_PER_CYCLE);

	if (toFetch.length === 0) {
		console.log('[scraper:detail] No trains have detail URLs — detail page enrichment skipped');
		return detailMap;
	}

	console.log(`[scraper:detail] Fetching ${toFetch.length} detail pages (of ${trainsWithDetails.length} available)`);

	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < toFetch.length; i++) {
		const train = toFetch[i];
		// Handle null/undefined carrier consistently
		const carrier = train.carrier || '';
		const trainKey = `${carrier}-${train.trainNumber}`;

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

	// NEW: Enhanced logging for detailed breakdown
	if (successCount === 0 && toFetch.length > 0) {
		console.warn('[scraper:detail] All detail page fetches failed! Likely session/HTML issue');
	}

	// NEW: Log detailed breakdown of which trains succeeded vs failed
	console.log(`[DEBUG] Detail fetch breakdown:`);
	for (let i = 0; i < toFetch.length; i++) {
		const train = toFetch[i];
		const trainKey = `${train.carrier}-${train.trainNumber}`;
		const result = detailMap.has(trainKey) ? 'SUCCESS' : 'FAILED';
		const stationCount = detailMap.get(trainKey)?.length || 0;
		console.log(`[DEBUG]   ${trainKey}: ${result} (${stationCount} stations, ${train.delayMinutes}min delay)`);
	}

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

		// Use enhanced session management with circuit breaker and retry logic
		const session = await getEnhancedSession(env);
		if (!session) {
			console.error('[scraper] Failed to get working session - circuit breaker may be open');
			return [];
		}

		// scrapeCurrentDelays mutates session in-place to capture any cookie
		// rotations from the list page response — this ensures fetchTrainDetails
		// uses cookies that match the pid tokens in the detail URLs.
		const scraped = await scrapeCurrentDelays(session);

		if (scraped.length === 0) {
			console.warn('[scraper] No delayed trains found');
			return [];
		}

		// Update KV with the (potentially rotated) session so that if
		// initSession fails on the next cycle, getOrRefreshSession has
		// a reasonably fresh fallback.
		await env.DELAYS_KV.put(SESSION_KV_KEY, JSON.stringify(session), { expirationTtl: SESSION_TTL });

		// Fetch per-station detail pages for top trains
		const detailMap = await fetchTrainDetails(session, scraped);

		let trains = await transformToApiFormat(scraped, detailMap, env);
		console.log(`[scraper] Transformed ${trains.length} trains to API format (${detailMap.size} with station details)`);

		return trains;
	} catch (err) {
		console.error(`[scraper] Fatal error: ${err}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Portal stats scraping (s=1 page — real punctuality data)
// ---------------------------------------------------------------------------

function extractStatVar(html: string, varName: string): number | null {
	const match = html.match(new RegExp(`${varName}\\s*=\\s*([0-9.]+)`));
	return match ? parseFloat(match[1]) : null;
}

/**
 * Scrape real-time punctuality statistics from Portal Pasażera.
 *
 * The s=1 page embeds these JS variables directly in the HTML:
 * - ProcPunktualnoscNaTrasie: % of trains currently on route that are on time
 * - ProcPunktualnoscUruchomien: % of trains that departed on time
 * - ProcPunktualnoscZakonczen: % of completed trains that were on time
 * - ProcUruchomien: % of scheduled trains that have actually started
 *
 * No session or CSRF tokens needed — simple GET request.
 */
export async function scrapePortalStats(): Promise<PortalStats | null> {
	try {
		const res = await fetch(`${PORTAL_BASE}/Opoznienia/Index?s=1`, {
			headers: {
				'User-Agent': USER_AGENT,
				'Accept': 'text/html',
			},
		});

		if (!res.ok) {
			console.warn(`[scraper:stats] Failed to fetch s=1: ${res.status}`);
			return null;
		}

		const html = await res.text();

		const stats: PortalStats = {
			onRoute: extractStatVar(html, 'ProcPunktualnoscNaTrasie'),
			departed: extractStatVar(html, 'ProcPunktualnoscUruchomien'),
			completed: extractStatVar(html, 'ProcPunktualnoscZakonczen'),
			startedPct: extractStatVar(html, 'ProcUruchomien'),
		};

		console.log(`[scraper:stats] Portal stats: onRoute=${stats.onRoute}%, departed=${stats.departed}%, completed=${stats.completed}%, started=${stats.startedPct}%`);

		return stats;
	} catch (err) {
		console.error(`[scraper:stats] Error: ${err}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Diagnostic Functions (for debugging detail page parsing failures)
// ---------------------------------------------------------------------------

/**
 * Diagnostic function to manually test single detail page parsing.
 * This helps identify exact failure points in the parsing logic.
 */
async function debugDetailPage(detailUrl: string, session: ScrapingSession): Promise<void> {
	console.log(`[DEBUG] === Detail Page Diagnostic Test ===`);
	console.log(`[DEBUG] URL: ${detailUrl}`);
	console.log(`[DEBUG] Session age: ${Math.floor((Date.now() - session.createdAt) / 60000)} minutes`);

	const fullUrl = detailUrl.startsWith('http')
		? detailUrl
		: `${PORTAL_BASE}${detailUrl.startsWith('/') ? '' : '/'}${detailUrl}`;

	try {
		const res = await fetch(fullUrl, {
			headers: {
				'User-Agent': USER_AGENT,
				'Accept': 'text/html,application/xhtml+xml',
				'Cookie': buildCookieHeader(session),
			},
			redirect: 'manual',
		});

		console.log(`[DEBUG] Response status: ${res.status}`);
		console.log(`[DEBUG] Response headers:`, Object.fromEntries(res.headers.entries()));

		if (!res.ok) {
			console.warn(`[DEBUG] Failed to fetch detail page: ${res.status}`);
			return;
		}

		const html = await res.text();
		console.log(`[DEBUG] HTML length: ${html.length} characters`);

		// Test regex patterns
		const timelineClass = html.match(/timeline__content-station/g)?.length || 0;
		const stationElements = html.match(/<h[2-4][^>]*>.*?[Ss]tacja/g)?.length || 0;
		const timeElements = html.match(/\d{1,2}:\d{2}/g)?.length || 0;

		console.log(`[DEBUG] HTML analysis:`);
		console.log(`[DEBUG]   - timeline__content-station occurrences: ${timelineClass}`);
		console.log(`[DEBUG]   - station heading elements: ${stationElements}`);
		console.log(`[DEBUG]   - time elements (HH:MM): ${timeElements}`);

		// Test actual parsing
		const stations = parseTrainDetailPage(html);
		console.log(`[DEBUG] Parsing result: ${stations?.length || 0} stations extracted`);

		if (stations && stations.length > 0) {
			console.log(`[DEBUG] First station:`, stations[0]);
			console.log(`[DEBUG] Last station:`, stations[stations.length - 1]);
		}

		// Log first 500 chars of HTML for manual inspection
		console.log(`[DEBUG] HTML sample (first 500 chars):`);
		console.log(html.slice(0, 500));

	} catch (err) {
		console.error(`[DEBUG] Diagnostic fetch error: ${err}`);
	}

	console.log(`[DEBUG] === End Diagnostic Test ===`);
}

// ---------------------------------------------------------------------------
// Bright Data Enhanced Scraping Functions
// ---------------------------------------------------------------------------

/**
 * Scrape train detail page using Bright Data API for enterprise reliability
 */
async function scrapeTrainDetailBrightData(detailUrl: string, env: Env): Promise<ApiStation[] | null> {
	// Handle both absolute and relative URLs
	const fullUrl = detailUrl.startsWith('http')
		? detailUrl
		: `${PORTAL_BASE}${detailUrl.startsWith('/') ? '' : '/'}${detailUrl}`;

	console.log(`[bright-data] Fetching ${fullUrl.substring(0, 80)}...`);

	const response = await fetch('https://api.brightdata.com/dca/trigger', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.BRIGHT_DATA_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			url: fullUrl,
			country: 'PL',          // Polish residential IPs
			session: 'sticky',      // Maintain cookies across requests
			format: 'html',         // Raw HTML for our existing parser
			timeout: 30000,         // 30s timeout for complex pages
			render_js: false,       // Portal Pasażera is server-rendered
			cookies: 'maintain'     // Handle cookie rotation automatically
		})
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Bright Data API failed: ${response.status} - ${errorText}`);
	}

	const html = await response.text();

	// Validate we got a proper detail page
	if (!html.includes('timeline__content-station') && !html.includes('SzczegolyPolaczenia')) {
		console.warn(`[bright-data] Response doesn't look like a detail page (${html.length} bytes)`);
		return null;
	}

	console.log(`[bright-data] Successfully retrieved HTML (${html.length} bytes)`);
	return parseTrainDetailPage(html);
}

/**
 * Enhanced train detail scraping with Bright Data fallback
 * Uses enterprise-grade scraping for maximum reliability
 */
async function scrapeTrainDetailEnhanced(session: ScrapingSession, detailUrl: string, env: Env): Promise<ApiStation[] | null> {
	// Try Bright Data first for maximum reliability
	if (env.BRIGHT_DATA_API_KEY) {
		try {
			const stations = await scrapeTrainDetailBrightData(detailUrl, env);
			if (stations && stations.length > 0) {
				console.log(`[bright-data] Success: ${stations.length} stations for ${detailUrl.substring(0, 80)}`);
				return stations;
			}
		} catch (error) {
			console.warn(`[bright-data] Failed for ${detailUrl.substring(0, 80)}: ${error.message}, falling back to traditional scraping`);
		}
	}

	// Fallback to traditional scraping
	console.log(`[traditional] Attempting traditional scraping for ${detailUrl.substring(0, 80)}`);
	return await scrapeTrainDetail(session, detailUrl);
}

