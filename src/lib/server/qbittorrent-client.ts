/**
 * qBittorrent WebUI API client
 *
 * Handles authentication and torrent management via qBittorrent's Web API.
 */

import { createHash } from 'crypto';
import { env } from './env.js';

/**
 * Compute the info hash from a .torrent file buffer.
 *
 * The info hash is the SHA-1 of the raw bencoded `info` dictionary.
 * We locate it by scanning for the key `4:info` in the bencode stream,
 * then read the exact byte range of the value that follows.
 */
export function computeInfoHash(torrentBuffer: Buffer): string {
	const marker = Buffer.from('4:info');
	const markerPos = torrentBuffer.indexOf(marker);
	if (markerPos === -1) {
		throw new Error('Invalid .torrent file: missing info key');
	}

	// Value starts immediately after the marker
	const valueStart = markerPos + marker.length;

	// Walk the bencode value to find where it ends
	const valueEnd = bencodeEnd(torrentBuffer, valueStart);

	const infoBytes = torrentBuffer.slice(valueStart, valueEnd);
	return createHash('sha1').update(infoBytes).digest('hex');
}

/**
 * Return the index one past the end of a bencoded value starting at `pos`.
 */
function bencodeEnd(buf: Buffer, pos: number): number {
	const ch = buf[pos];

	if (ch === 0x64) {
		// 'd' — dictionary
		pos += 1;
		while (buf[pos] !== 0x65) {
			// 'e'
			pos = bencodeEnd(buf, pos); // key
			pos = bencodeEnd(buf, pos); // value
		}
		return pos + 1; // consume 'e'
	}

	if (ch === 0x6c) {
		// 'l' — list
		pos += 1;
		while (buf[pos] !== 0x65) {
			// 'e'
			pos = bencodeEnd(buf, pos);
		}
		return pos + 1;
	}

	if (ch === 0x69) {
		// 'i' — integer: i<digits>e
		const end = buf.indexOf(0x65, pos + 1); // 'e'
		return end + 1;
	}

	// byte string: <length>:<data>
	const colon = buf.indexOf(0x3a, pos); // ':'
	const len = parseInt(buf.slice(pos, colon).toString(), 10);
	return colon + 1 + len;
}

/** Session ID cookie from qBittorrent */
let sessionCookie: string | null = null;

/** Base URL for API calls */
function getBaseUrl(): string {
	return env.QB_URL.replace(/\/$/, '');
}

/**
 * Login to qBittorrent and get session cookie
 */
async function login(): Promise<void> {
	const url = `${getBaseUrl()}/api/v2/auth/login`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			username: env.QB_USERNAME,
			password: env.QB_PASSWORD
		})
	});

	if (!response.ok) {
		throw new Error(`qBittorrent login failed: ${response.status} ${response.statusText}`);
	}

	const text = await response.text();
	if (text !== 'Ok.') {
		throw new Error(`qBittorrent login failed: ${text}`);
	}

	// Extract SID cookie
	const setCookie = response.headers.get('set-cookie');
	if (setCookie) {
		const match = setCookie.match(/SID=([^;]+)/);
		if (match) {
			sessionCookie = match[1];
			console.log('[qbittorrent] Logged in successfully');
		}
	}

	if (!sessionCookie) {
		throw new Error('qBittorrent login succeeded but no session cookie received');
	}
}

/**
 * Make an authenticated API request
 */
async function apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
	// Login if we don't have a session
	if (!sessionCookie) {
		await login();
	}

	const url = `${getBaseUrl()}${endpoint}`;

	// Build headers carefully: don't set Content-Type when body is FormData,
	// as fetch must set it automatically (with the multipart boundary).
	const extraHeaders: Record<string, string> = { Cookie: `SID=${sessionCookie}` };
	if (options.headers) {
		const incoming = new Headers(options.headers);
		incoming.forEach((value, key) => {
			extraHeaders[key] = value;
		});
	}

	const response = await fetch(url, {
		...options,
		headers: extraHeaders
	});

	// If unauthorized, try logging in again
	if (response.status === 403) {
		sessionCookie = null;
		await login();
		extraHeaders['Cookie'] = `SID=${sessionCookie}`;
		return fetch(url, { ...options, headers: extraHeaders });
	}

	return response;
}

/**
 * Torrent info from qBittorrent
 */
export interface QBTorrent {
	hash: string;
	name: string;
	size: number;
	progress: number;
	dlspeed: number;
	upspeed: number;
	num_seeds: number;
	num_leechs: number;
	state: string;
	category: string;
	tags: string;
	added_on: number;
	completion_on: number;
	ratio: number;
	downloaded: number;
	uploaded: number;
	save_path: string;
	content_path: string;
}

/**
 * Add a torrent from a .torrent file buffer
 *
 * @param torrentBuffer - The .torrent file contents
 * @param options - Additional options
 * @returns The torrent hash (lowercase)
 */
export async function addTorrent(
	torrentBuffer: Buffer,
	options: {
		category?: string;
		savePath?: string;
		paused?: boolean;
	} = {}
): Promise<string> {
	// Build the multipart body manually to avoid Node.js FormData/undici issues
	// with binary data that can corrupt field values.
	const boundary = `----book-thing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const CRLF = '\r\n';

	const parts: Buffer[] = [];

	// Part 1: the .torrent file
	parts.push(
		Buffer.from(
			`--${boundary}${CRLF}` +
				`Content-Disposition: form-data; name="torrents"; filename="torrent.torrent"${CRLF}` +
				`Content-Type: application/x-bittorrent${CRLF}` +
				CRLF
		)
	);
	parts.push(torrentBuffer);
	parts.push(Buffer.from(CRLF));

	// Part 2: category
	const category = options.category || env.QB_CATEGORY;
	if (category) {
		parts.push(
			Buffer.from(
				`--${boundary}${CRLF}` +
					`Content-Disposition: form-data; name="category"${CRLF}` +
					CRLF +
					category +
					CRLF
			)
		);
	}

	// Part 3: save path
	const savePath = options.savePath || env.QB_SAVE_PATH;
	if (savePath) {
		parts.push(
			Buffer.from(
				`--${boundary}${CRLF}` +
					`Content-Disposition: form-data; name="savepath"${CRLF}` +
					CRLF +
					savePath +
					CRLF
			)
		);
	}

	// Part 4: paused
	if (options.paused) {
		parts.push(
			Buffer.from(
				`--${boundary}${CRLF}` +
					`Content-Disposition: form-data; name="paused"${CRLF}` +
					CRLF +
					'true' +
					CRLF
			)
		);
	}

	// Closing boundary
	parts.push(Buffer.from(`--${boundary}--${CRLF}`));

	const body = Buffer.concat(parts);

	const response = await apiRequest('/api/v2/torrents/add', {
		method: 'POST',
		headers: {
			'Content-Type': `multipart/form-data; boundary=${boundary}`
		},
		body
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to add torrent: ${response.status} ${text}`);
	}

	const result = await response.text();
	if (result !== 'Ok.') {
		throw new Error(`Failed to add torrent: ${result}`);
	}

	// Compute the hash directly from the .torrent file — no need to query the list
	const hash = computeInfoHash(torrentBuffer);
	console.log(`[qbittorrent] Added torrent with hash: ${hash}`);
	return hash;
}

/**
 * Get list of torrents
 */
export async function getTorrents(
	options: {
		category?: string;
		hashes?: string[];
	} = {}
): Promise<QBTorrent[]> {
	const params = new URLSearchParams();

	if (options.category) {
		params.set('category', options.category);
	}
	if (options.hashes && options.hashes.length > 0) {
		params.set('hashes', options.hashes.join('|'));
	}

	const response = await apiRequest(`/api/v2/torrents/info?${params}`);

	if (!response.ok) {
		throw new Error(`Failed to get torrents: ${response.status}`);
	}

	return response.json();
}

/**
 * Get a specific torrent by hash
 */
export async function getTorrent(hash: string): Promise<QBTorrent | null> {
	const torrents = await getTorrents({ hashes: [hash] });
	return torrents.length > 0 ? torrents[0] : null;
}

/**
 * Delete a torrent
 *
 * @param hash - Torrent hash
 * @param deleteFiles - Whether to also delete downloaded files
 */
export async function deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<void> {
	const response = await apiRequest('/api/v2/torrents/delete', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			hashes: hash,
			deleteFiles: deleteFiles ? 'true' : 'false'
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to delete torrent: ${response.status}`);
	}

	console.log(`[qbittorrent] Deleted torrent: ${hash}`);
}

/**
 * Pause a torrent
 */
export async function pauseTorrent(hash: string): Promise<void> {
	const response = await apiRequest('/api/v2/torrents/pause', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({ hashes: hash })
	});

	if (!response.ok) {
		throw new Error(`Failed to pause torrent: ${response.status}`);
	}
}

/**
 * Resume a torrent
 */
export async function resumeTorrent(hash: string): Promise<void> {
	const response = await apiRequest('/api/v2/torrents/resume', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({ hashes: hash })
	});

	if (!response.ok) {
		throw new Error(`Failed to resume torrent: ${response.status}`);
	}
}

/**
 * Get global transfer info
 */
export async function getTransferInfo(): Promise<{
	dl_info_speed: number;
	up_info_speed: number;
	dl_info_data: number;
	up_info_data: number;
}> {
	const response = await apiRequest('/api/v2/transfer/info');

	if (!response.ok) {
		throw new Error(`Failed to get transfer info: ${response.status}`);
	}

	return response.json();
}

/**
 * Ensure category exists in qBittorrent
 */
export async function ensureCategory(name: string, savePath?: string): Promise<void> {
	const response = await apiRequest('/api/v2/torrents/createCategory', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			category: name,
			savePath: savePath || ''
		})
	});

	// 409 means category already exists, which is fine
	if (!response.ok && response.status !== 409) {
		throw new Error(`Failed to create category: ${response.status}`);
	}
}

/**
 * Map qBittorrent state to our status
 */
export function mapState(state: string): 'downloading' | 'seeding' | 'paused' | 'error' {
	switch (state) {
		case 'downloading':
		case 'stalledDL':
		case 'metaDL':
		case 'queuedDL':
		case 'forcedDL':
		case 'allocating':
			return 'downloading';
		case 'uploading':
		case 'stalledUP':
		case 'queuedUP':
		case 'forcedUP':
			return 'seeding';
		case 'pausedDL':
		case 'pausedUP':
			return 'paused';
		case 'error':
		case 'missingFiles':
		case 'unknown':
		default:
			return 'error';
	}
}

/**
 * Initialize qBittorrent client (login and ensure category exists)
 */
export async function initQBittorrent(): Promise<void> {
	try {
		await login();
		if (env.QB_CATEGORY) {
			await ensureCategory(env.QB_CATEGORY, env.QB_SAVE_PATH || undefined);
		}
		console.log('[qbittorrent] Client initialized');
	} catch (err) {
		console.error('[qbittorrent] Failed to initialize:', err);
		throw err;
	}
}
