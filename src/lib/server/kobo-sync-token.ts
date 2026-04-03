/**
 * SyncToken implementation for the Kobo sync protocol.
 *
 * The Kobo device persists sync state via the `x-kobo-synctoken` response header
 * and sends it back on subsequent requests. This is a base64-encoded JSON blob
 * containing timestamp data used to detect changes since the last sync.
 *
 * Based on calibre-web's SyncToken implementation.
 */

const SYNC_TOKEN_HEADER = 'x-kobo-synctoken';
/**
 * Token version history:
 *   1-0-0: initial
 *   1-1-0: calibre-web compatible format
 *   1-2-0: switched book IDs from base64url paths to UUID v5 format;
 *           old tokens must be invalidated to force a full re-sync
 *   1-3-0: added EPUB3+EPUB dual format DownloadUrls;
 *           force re-sync so device gets updated entitlements
 *   1-4-0: fix cover URLs and download handling
 */
const TOKEN_VERSION = '1-4-0';
const MIN_VERSION = '1-4-0';

/** Epoch timestamp for datetime.min equivalent */
const EPOCH_MIN = 0;

export interface SyncTokenData {
	rawKoboStoreToken: string;
	booksLastModified: Date;
	booksLastCreated: Date;
	archiveLastModified: Date;
	readingStateLastModified: Date;
	tagsLastModified: Date;
}

function toEpochTimestamp(date: Date): number {
	return date.getTime() / 1000;
}

function fromEpochTimestamp(epoch: number): Date {
	if (epoch <= 0 || !Number.isFinite(epoch)) {
		return new Date(0);
	}
	return new Date(epoch * 1000);
}

function createEmptySyncToken(): SyncTokenData {
	return {
		rawKoboStoreToken: '',
		booksLastModified: new Date(0),
		booksLastCreated: new Date(0),
		archiveLastModified: new Date(0),
		readingStateLastModified: new Date(0),
		tagsLastModified: new Date(0)
	};
}

/**
 * Parse the x-kobo-synctoken header from a request.
 * Returns default/empty token if header is missing or malformed.
 */
export function parseSyncToken(headers: Headers): SyncTokenData {
	const headerValue = headers.get(SYNC_TOKEN_HEADER) ?? '';
	if (!headerValue) {
		return createEmptySyncToken();
	}

	// On first sync from a Kobo device, we may receive the SyncToken from the
	// official Kobo store. That token is of the form [b64blob].[b64blob].
	if (headerValue.includes('.')) {
		return {
			...createEmptySyncToken(),
			rawKoboStoreToken: headerValue
		};
	}

	try {
		// Add padding if needed
		const padded = headerValue + '='.repeat((4 - (headerValue.length % 4)) % 4);
		const decoded = Buffer.from(padded, 'base64').toString('utf-8');
		const json = JSON.parse(decoded);

		if (!json || typeof json !== 'object' || !json.version || !json.data) {
			return createEmptySyncToken();
		}

		if (json.version < MIN_VERSION) {
			return createEmptySyncToken();
		}

		const data = json.data;
		return {
			rawKoboStoreToken: data.raw_kobo_store_token ?? '',
			booksLastModified: fromEpochTimestamp(data.books_last_modified ?? EPOCH_MIN),
			booksLastCreated: fromEpochTimestamp(data.books_last_created ?? EPOCH_MIN),
			archiveLastModified: fromEpochTimestamp(data.archive_last_modified ?? EPOCH_MIN),
			readingStateLastModified: fromEpochTimestamp(data.reading_state_last_modified ?? EPOCH_MIN),
			tagsLastModified: fromEpochTimestamp(data.tags_last_modified ?? EPOCH_MIN)
		};
	} catch {
		return createEmptySyncToken();
	}
}

/**
 * Build the x-kobo-synctoken header value from sync token data.
 */
export function buildSyncTokenHeader(token: SyncTokenData): string {
	const payload = {
		version: TOKEN_VERSION,
		data: {
			raw_kobo_store_token: token.rawKoboStoreToken,
			books_last_modified: toEpochTimestamp(token.booksLastModified),
			books_last_created: toEpochTimestamp(token.booksLastCreated),
			archive_last_modified: toEpochTimestamp(token.archiveLastModified),
			reading_state_last_modified: toEpochTimestamp(token.readingStateLastModified),
			tags_last_modified: toEpochTimestamp(token.tagsLastModified)
		}
	};
	return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export { SYNC_TOKEN_HEADER };
