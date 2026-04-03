import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists, listKoboBooksForShelf } from '$lib/server/kobo-library.js';
import { createKoboBookEntitlement, createKoboBookMetadata } from '$lib/server/kobo-metadata.js';
import { logKoboError, logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';
import {
	parseSyncToken,
	buildSyncTokenHeader,
	SYNC_TOKEN_HEADER,
	type SyncTokenData
} from '$lib/server/kobo-sync-token.js';
import {
	buildKoboRouteUrls,
	createKoboShelfNotFoundJsonResponse,
	isKoboShelfError,
	toKoboTimestamp
} from '$lib/server/kobo-routes.js';
import { getKoboReadingState } from '$lib/server/kobo-state.js';

const SYNC_ITEM_LIMIT = 100;

function createReadingStateForSync(
	koboId: string,
	modifiedAt: string,
	state: Awaited<ReturnType<typeof getKoboReadingState>>
) {
	const timestamp = state?.updatedAt ?? modifiedAt;
	return {
		EntitlementId: koboId,
		Created: toKoboTimestamp(modifiedAt),
		LastModified: toKoboTimestamp(timestamp),
		PriorityTimestamp: toKoboTimestamp(timestamp),
		StatusInfo: {
			LastModified: toKoboTimestamp(timestamp),
			Status:
				state?.status === 'Finished'
					? 'Finished'
					: state?.status === 'Reading'
						? 'Reading'
						: 'ReadyToRead',
			TimesStartedReading: state?.timesStartedReading ?? 0
		},
		Statistics: {
			LastModified: toKoboTimestamp(timestamp)
		},
		CurrentBookmark: {
			LastModified: toKoboTimestamp(timestamp)
		}
	};
}

export const GET: RequestHandler = async ({ params, url, request }) => {
	try {
		const shelf = await assertKoboShelfExists(params.shelf);
		const books = await listKoboBooksForShelf(params.shelf);
		const syncToken = parseSyncToken(request.headers);

		const forceFullSync = ['1', 'true', 'yes'].includes(
			(url.searchParams.get('full') ?? '').toLowerCase()
		);

		logKoboRequest('library/sync', {
			shelf: shelf.name,
			path: url.pathname,
			full: forceFullSync,
			bookCount: books.length,
			syncToken: {
				booksLastModified: syncToken.booksLastModified.toISOString(),
				booksLastCreated: syncToken.booksLastCreated.toISOString(),
				readingStateLastModified: syncToken.readingStateLastModified.toISOString()
			}
		});

		// Determine if this is effectively a first sync
		const isFirstSync = syncToken.booksLastModified.getTime() === 0;

		const booksLastModifiedAt = syncToken.booksLastModified;

		const changedBooks = books
			.filter((book) => {
				if (forceFullSync || isFirstSync) return true;
				return new Date(book.modifiedAt).getTime() > booksLastModifiedAt.getTime();
			})
			.slice(0, SYNC_ITEM_LIMIT);

		const syncResults = [];
		let newestBookTimestamp = booksLastModifiedAt;
		let newestBookCreatedTimestamp = syncToken.booksLastCreated;

		for (const book of changedBooks) {
			const { downloadUrl, koboId } = buildKoboRouteUrls(url.origin, shelf, book);
			const metadata = await createKoboBookMetadata(book, shelf, downloadUrl, koboId);
			const entitlement: Record<string, unknown> = {
				BookEntitlement: createKoboBookEntitlement(book),
				BookMetadata: metadata
			};

			// Include ReadingState in entitlement (matches calibre-web behavior)
			// Use koboId (UUID) for reading state lookup — this is what the device uses
			const readingState = await getKoboReadingState(book.koboId);
			entitlement.ReadingState = createReadingStateForSync(
				book.koboId,
				book.modifiedAt,
				readingState
			);

			const bookModifiedAt = new Date(book.modifiedAt);

			// Calibre-web distinguishes between NewEntitlement and ChangedEntitlement
			// based on whether the book was created after the last sync
			if (bookModifiedAt.getTime() > syncToken.booksLastCreated.getTime()) {
				syncResults.push({ NewEntitlement: entitlement });
			} else {
				syncResults.push({ ChangedEntitlement: entitlement });
			}

			if (bookModifiedAt.getTime() > newestBookTimestamp.getTime()) {
				newestBookTimestamp = bookModifiedAt;
			}
			if (bookModifiedAt.getTime() > newestBookCreatedTimestamp.getTime()) {
				newestBookCreatedTimestamp = bookModifiedAt;
			}
		}

		const hasMore = books.length > changedBooks.length && changedBooks.length === SYNC_ITEM_LIMIT;

		// Build updated sync token
		const updatedToken: SyncTokenData = {
			...syncToken,
			booksLastModified: newestBookTimestamp,
			booksLastCreated: hasMore ? syncToken.booksLastCreated : newestBookCreatedTimestamp
		};

		const responseHeaders: Record<string, string> = {
			'Content-Type': 'application/json; charset=utf-8',
			[SYNC_TOKEN_HEADER]: buildSyncTokenHeader(updatedToken)
		};
		if (hasMore) {
			responseHeaders['x-kobo-sync'] = 'continue';
		}

		logKoboRequest('library/sync response', {
			shelf: shelf.name,
			totalBooks: books.length,
			changedBooks: changedBooks.length,
			syncResultCount: syncResults.length,
			hasMore,
			isFirstSync,
			entitlementTypes: syncResults.map((r) => ('NewEntitlement' in r ? 'new' : 'changed')),
			updatedToken: {
				booksLastModified: updatedToken.booksLastModified.toISOString(),
				booksLastCreated: updatedToken.booksLastCreated.toISOString()
			},
			// Log first two entitlements for debugging Kobo protocol issues
			sampleEntitlements: syncResults.slice(0, 2)
		});

		return json(syncResults, { headers: responseHeaders });
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('library/sync shelf not found', { shelf: params.shelf });
			return createKoboShelfNotFoundJsonResponse();
		}

		logKoboError('library/sync failed', error, { shelf: params.shelf, path: url.pathname });
		return json({ error: 'Failed to sync Kobo library' }, { status: 500 });
	}
};
