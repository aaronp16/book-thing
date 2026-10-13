/**
 * MyAnonamouse API client
 *
 * Handles search queries and .torrent file downloads using cookie-based auth.
 * MAM may rotate the mam_id cookie in responses, so we track the latest value.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import type { MamEntry, BookResult, PersonInfo, SearchField } from '$lib/types.js';

const SEARCH_URL = 'https://www.myanonamouse.net/tor/js/loadSearchJSONbasic.php';
const TORRENT_URL = 'https://www.myanonamouse.net/tor/download.php';
const BROWSE_URL = 'https://www.myanonamouse.net/tor/browse.php';
const SEEDBOX_URL = 'https://t.myanonamouse.net/json/dynamicSeedbox.php';
const USER_URL = 'https://www.myanonamouse.net/jsonLoad.php';
const PAGE_SIZE = 20;

/** MAM allows one seedbox IP change per hour; check slightly less often than that */
const SEEDBOX_INTERVAL_MS = 61 * 60 * 1000;

/**
 * E-book category IDs on MAM
 */
const EBOOK_CATEGORIES = [
	'60',
	'61',
	'62',
	'63',
	'64',
	'65',
	'66',
	'67',
	'68',
	'69',
	'70', // EB fiction
	'71',
	'72',
	'73',
	'74',
	'75',
	'76',
	'77',
	'78',
	'79',
	'80',
	'81',
	'82', // EB non-fiction
	'90',
	'91',
	'92',
	'94',
	'95',
	'96', // EB more non-fiction
	'101',
	'102',
	'103',
	'104', // EB crafts/historical/humor/true crime
	'107',
	'109',
	'112',
	'115',
	'118',
	'120' // EB food/urban fantasy/YA/illusion/mixed/nature
];

/**
 * Persisted session file. MAM rotates mam_id via Set-Cookie and the old value
 * stops working, so the latest one must survive restarts. Override with
 * MAM_SESSION_FILE when dev and prod share a BOOKS_DIR.
 */
const SESSION_FILE = env.MAM_SESSION_FILE || path.join(env.BOOKS_DIR, '.mam_session.json');

interface PersistedSession {
	/** Latest mam_id seen from MAM */
	mamId: string;
	/** The env MAM_ID this session descends from; if env changes, env wins */
	envMamId: string;
	updatedAt: string;
}

/** Current mam_id (may be rotated by MAM) */
let currentMamId: string = loadPersistedMamId();

/**
 * Load the last rotated mam_id from disk, unless MAM_ID in env has been
 * changed since (meaning the user pasted a fresh session).
 */
function loadPersistedMamId(): string {
	try {
		const session: PersistedSession = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
		if (session.mamId && session.envMamId === env.MAM_ID) {
			console.log(`[mam-client] Using persisted mam_id from ${session.updatedAt}`);
			return session.mamId;
		}
	} catch {
		// No session file yet
	}
	return '';
}

function persistMamId(mamId: string): void {
	const session: PersistedSession = {
		mamId,
		envMamId: env.MAM_ID,
		updatedAt: new Date().toISOString()
	};
	try {
		mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
		writeFileSync(SESSION_FILE, JSON.stringify(session, null, '\t'), { mode: 0o600 });
	} catch (err) {
		console.error('[mam-client] Failed to persist rotated mam_id:', err);
	}
}

/**
 * Get the current MAM ID, falling back to env if not yet set
 */
function getMamId(): string {
	return currentMamId || env.MAM_ID;
}

/**
 * Build request headers for MAM API calls
 */
function buildHeaders(referer?: string): HeadersInit {
	return {
		Cookie: `mam_id=${getMamId()}; uid=${env.MAM_UID}`,
		'User-Agent':
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.10 Safari/605.1.15',
		...(referer ? { Referer: referer } : {})
	};
}

/**
 * Track cookie rotation from MAM responses
 */
function trackCookieRotation(response: Response): void {
	for (const cookie of response.headers.getSetCookie()) {
		const mamIdMatch = cookie.match(/^\s*mam_id=([^;]+)/);
		if (!mamIdMatch) continue;

		const newId = mamIdMatch[1];
		if (newId && newId !== 'deleted' && newId !== getMamId()) {
			currentMamId = newId;
			persistMamId(newId);
		}
	}
}

/**
 * Throw a clear error for a failed MAM response. 403 means the session was
 * rejected (expired, invalidated, or used from a different IP/ASN than it's locked to).
 */
function throwMamError(response: Response, context: string): never {
	if (response.status === 403) {
		throw new Error(
			`${context}: MAM rejected the session (403). Create a new session in MAM ` +
				`Preferences → Security, set MAM_ID to it, and restart.`
		);
	}
	throw new Error(`${context}: ${response.status} ${response.statusText}`);
}

interface MamSearchResponse {
	data: MamEntry[];
	total: number;
	found: number;
	perpage: number;
	start: number;
}

interface MamErrorResponse {
	error: string;
}

type MamApiResponse = MamSearchResponse | MamErrorResponse;

function isErrorResponse(res: MamApiResponse): res is MamErrorResponse {
	return 'error' in res;
}

/**
 * Search MyAnonamouse for ebooks
 *
 * @param query - Search query string
 * @param field - Search in 'title' or 'author' field
 * @param page - Page number (0-based)
 * @returns Parsed search results
 */
export async function searchBooks(
	query: string,
	field: SearchField = 'title',
	page: number = 0
): Promise<{ results: BookResult[]; total: number; page: number; perPage: number }> {
	if (!getMamId() || !env.MAM_UID) {
		throw new Error('MAM_ID and MAM_UID environment variables are required');
	}

	const url = new URL(SEARCH_URL);

	// Search query
	if (query) {
		url.searchParams.set('tor[text]', query);
	}

	// Search in selected field only
	if (field === 'title') {
		url.searchParams.set('tor[srchIn][title]', 'true');
	} else if (field === 'author') {
		url.searchParams.set('tor[srchIn][author]', 'true');
	} else if (field === 'torrent') {
		url.searchParams.set('tor[srchIn][torrent]', 'true');
	}

	// Search type - all torrents
	url.searchParams.set('tor[searchType]', 'all');

	// Location - all torrents
	url.searchParams.set('tor[searchIn]', 'torrents');

	// Category filtering - ebooks only
	for (const cat of EBOOK_CATEGORIES) {
		url.searchParams.append('tor[cat][]', cat);
	}
	// Always include the "all" category marker
	url.searchParams.append('tor[cat][]', '0');

	// Pagination
	const offset = page * PAGE_SIZE;
	url.searchParams.set('tor[startNumber]', offset.toString());

	// Sort by default relevance
	url.searchParams.set('tor[sortType]', 'default');

	const response = await fetch(url.toString(), {
		headers: buildHeaders(BROWSE_URL)
	});

	trackCookieRotation(response);

	if (!response.ok) {
		throwMamError(response, 'MAM API error');
	}

	const data: MamApiResponse = await response.json();

	if (isErrorResponse(data)) {
		// "Nothing returned" means no results, not an error
		if (data.error.includes('Nothing returned')) {
			return { results: [], total: 0, page, perPage: PAGE_SIZE };
		}
		throw new Error(`MAM search error: ${data.error}`);
	}

	const results = data.data.map(parseMamEntry);

	return {
		results,
		total: data.found || data.total || 0,
		page,
		perPage: PAGE_SIZE
	};
}

/**
 * Download a .torrent file from MAM
 *
 * @param torrentId - MAM torrent ID
 * @returns Buffer containing the .torrent file
 */
export async function downloadTorrentFile(torrentId: number): Promise<Buffer> {
	if (!getMamId() || !env.MAM_UID) {
		throw new Error('MAM_ID and MAM_UID environment variables are required');
	}

	const url = `${TORRENT_URL}?tid=${torrentId}`;

	const response = await fetch(url, {
		headers: buildHeaders(`https://www.myanonamouse.net/t/${torrentId}`)
	});

	trackCookieRotation(response);

	if (!response.ok) {
		throwMamError(response, `Failed to download torrent ${torrentId}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

export interface MamAccount {
	/** User class, e.g. "VIP", "Power User" */
	classname: string;
	/** VIP expiry as an ISO timestamp, or null when not VIP */
	vipUntil: string | null;
}

const ACCOUNT_CACHE_MS = 60 * 60 * 1000;
let accountCache: { account: MamAccount; fetchedAt: number } | null = null;

/**
 * Fetch the user's class and VIP expiry from MAM. Cached for an hour since
 * it only changes when VIP is bought or runs out.
 */
export async function getAccount(): Promise<MamAccount> {
	if (accountCache && Date.now() - accountCache.fetchedAt < ACCOUNT_CACHE_MS) {
		return accountCache.account;
	}
	if (!getMamId() || !env.MAM_UID) {
		throw new Error('MAM_ID and MAM_UID environment variables are required');
	}

	const response = await fetch(USER_URL, { headers: buildHeaders() });
	trackCookieRotation(response);

	if (!response.ok) {
		throwMamError(response, 'Failed to load MAM account');
	}

	const data: { classname?: string; vip_until?: string | null } = await response.json();
	// MAM returns "YYYY-MM-DD HH:MM:SS" in UTC
	const vipUntil = data.vip_until ? new Date(data.vip_until.replace(' ', 'T') + 'Z') : null;

	const account: MamAccount = {
		classname: data.classname ?? '',
		vipUntil: vipUntil && !isNaN(vipUntil.getTime()) ? vipUntil.toISOString() : null
	};
	accountCache = { account, fetchedAt: Date.now() };
	return account;
}

interface SeedboxResponse {
	Success: boolean;
	msg: string;
	ip?: string;
	ASN?: number;
	AS?: string;
}

/**
 * Tell MAM's tracker our current public IP (dynamic seedbox API), so seeding
 * keeps counting after the ISP changes our IP. Requires the session to have
 * "Allow Session to set Dynamic Seedbox" enabled. MAM answers "No change" when
 * the IP is already current, so it's safe to call on a timer.
 */
export async function updateSeedboxIp(): Promise<void> {
	if (!getMamId()) return;

	try {
		const response = await fetch(SEEDBOX_URL, { headers: buildHeaders() });
		trackCookieRotation(response);

		const data = (await response.json().catch(() => null)) as SeedboxResponse | null;
		const msg = data?.msg ?? `${response.status} ${response.statusText}`;

		if (data?.Success) {
			const where = data.ip ? ` (${data.ip}${data.AS ? `, ${data.AS}` : ''})` : '';
			console.log(`[mam-client] Seedbox IP: ${msg}${where}`);
		} else if (response.status === 429) {
			// Changed within the last hour; the next run will pick it up
			console.log(`[mam-client] Seedbox IP: ${msg}`);
		} else {
			console.error(
				`[mam-client] Seedbox IP update failed: ${msg}. Check the MAM session has ` +
					`"Allow Session to set Dynamic Seedbox" enabled.`
			);
		}
	} catch (err) {
		console.error('[mam-client] Seedbox IP update failed:', err);
	}
}

let seedboxTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Update the seedbox IP now and then periodically
 */
export function startSeedboxUpdates(): void {
	if (seedboxTimer) return;
	void updateSeedboxIp();
	seedboxTimer = setInterval(updateSeedboxIp, SEEDBOX_INTERVAL_MS);
	seedboxTimer.unref();
}

/**
 * Parse a raw MAM entry into a structured BookResult
 */
function parseMamEntry(entry: MamEntry): BookResult {
	const authors = parsePersonInfo(entry.author_info);
	const narrators = parsePersonInfo(entry.narrator_info);
	const series = parseSeriesInfo(entry.series_info);

	// All results are ebooks now (we only search ebook categories)
	const isAudiobook = false;
	const isEbook = true;

	// Size comes pre-formatted from MAM (e.g., "7.9 GiB")
	const sizeFormatted = entry.size || '0 B';
	const sizeBytes = parseSizeToBytes(sizeFormatted);

	return {
		id: entry.id,
		title: entry.title,
		authors,
		narrators,
		series,
		category: entry.catname || entry.categories || 'Unknown',
		isAudiobook,
		isEbook,
		size: sizeBytes,
		sizeFormatted,
		numFiles: entry.numfiles,
		fileType: entry.filetype || '',
		seeders: entry.seeders,
		leechers: entry.leechers,
		snatched: entry.times_completed,
		freeleech: entry.free === 1,
		vip: entry.vip === 1,
		language: entry.lang_code || 'en',
		added: entry.added
	};
}

/**
 * Parse author_info or narrator_info JSON string
 *
 * Format: '{"123": "Author Name", "456": "Another Author"}'
 * Can also be empty string, "0", or a number
 */
function parsePersonInfo(info: string | number): PersonInfo[] {
	if (!info || info === '0' || info === 0) return [];

	try {
		const str = typeof info === 'number' ? String(info) : info;
		const parsed = JSON.parse(str);

		if (typeof parsed !== 'object' || parsed === null) return [];

		return Object.entries(parsed).map(([id, name]) => ({
			id: parseInt(id, 10),
			name: String(name)
		}));
	} catch {
		return [];
	}
}

/**
 * Parse series_info JSON string
 *
 * Can be two formats:
 * - Object: '{"5678": {"series_name": "Harry Potter", "series_number": "1"}}'
 * - Array: '{"5678": ["Harry Potter", "1-7", 1.000000]}'
 * Can also be empty string or "0"
 */
function parseSeriesInfo(info: string | number): { id: number; name: string; number?: string }[] {
	if (!info || info === '0' || info === 0) return [];

	try {
		const str = typeof info === 'number' ? String(info) : info;
		const parsed = JSON.parse(str);

		if (typeof parsed !== 'object' || parsed === null) return [];

		return Object.entries(parsed).map(([id, data]) => {
			// Handle array format: ["Series Name", "1-7", 1.0]
			if (Array.isArray(data)) {
				return {
					id: parseInt(id, 10),
					name: String(data[0]) || 'Unknown Series',
					...(data[1] ? { number: String(data[1]) } : {})
				};
			}
			// Handle object format: { series_name: "...", series_number: "..." }
			const seriesData = data as { series_name?: string; series_number?: string };
			return {
				id: parseInt(id, 10),
				name: seriesData.series_name || 'Unknown Series',
				...(seriesData.series_number ? { number: seriesData.series_number } : {})
			};
		});
	} catch {
		return [];
	}
}

/**
 * Parse a formatted size string back to bytes (approximate)
 * e.g., "7.9 GiB" -> 8482248704
 */
function parseSizeToBytes(sizeStr: string): number {
	const match = sizeStr.match(/^([\d.]+)\s*(\w+)$/);
	if (!match) return 0;

	const value = parseFloat(match[1]);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		b: 1,
		kb: 1024,
		kib: 1024,
		mb: 1024 * 1024,
		mib: 1024 * 1024,
		gb: 1024 * 1024 * 1024,
		gib: 1024 * 1024 * 1024,
		tb: 1024 * 1024 * 1024 * 1024,
		tib: 1024 * 1024 * 1024 * 1024
	};

	return Math.round(value * (multipliers[unit] || 1));
}
