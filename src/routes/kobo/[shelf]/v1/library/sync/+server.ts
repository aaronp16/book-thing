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
	isKoboShelfError
} from '$lib/server/kobo-routes.js';

const SYNC_ITEM_LIMIT = 100;

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
			const { downloadUrl } = buildKoboRouteUrls(url.origin, shelf, book);
			const coverImageId = book.id;
			const metadata = await createKoboBookMetadata(book, shelf, downloadUrl, coverImageId);
			const entitlement = {
				BookEntitlement: createKoboBookEntitlement(book),
				BookMetadata: metadata
			};

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
			'x-kobo-sync': hasMore ? 'continue' : 'done',
			[SYNC_TOKEN_HEADER]: buildSyncTokenHeader(updatedToken)
		};

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
			}
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
