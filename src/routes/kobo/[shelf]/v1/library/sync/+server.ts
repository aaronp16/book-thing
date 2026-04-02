import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists, listKoboBooksForShelf } from '$lib/server/kobo-library.js';
import { createKoboBookEntitlement, createKoboBookMetadata } from '$lib/server/kobo-metadata.js';
import { logKoboError, logKoboRequest } from '$lib/server/kobo-logging.js';
import { getKoboSyncCursor, updateKoboSyncCursor } from '$lib/server/kobo-state.js';
import {
	buildKoboRouteUrls,
	createKoboShelfNotFoundJsonResponse,
	isKoboShelfError,
	toKoboTimestamp
} from '$lib/server/kobo-routes.js';

const SYNC_ITEM_LIMIT = 100;

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const shelf = await assertKoboShelfExists(params.shelf);
		const books = await listKoboBooksForShelf(params.shelf);
		const cursor = await getKoboSyncCursor(shelf.name);
		const forceFullSync = ['1', 'true', 'yes'].includes(
			(url.searchParams.get('full') ?? '').toLowerCase()
		);
		const booksLastModifiedAt = cursor.booksLastModified
			? new Date(cursor.booksLastModified)
			: null;

		logKoboRequest('library/sync', {
			shelf: shelf.name,
			path: url.pathname,
			full: forceFullSync,
			bookCount: books.length,
			cursor
		});

		const changedBooks = books
			.filter((book) => {
				if (forceFullSync) return true;
				if (!booksLastModifiedAt) return true;
				return new Date(book.modifiedAt).getTime() > booksLastModifiedAt.getTime();
			})
			.slice(0, SYNC_ITEM_LIMIT);

		const syncResults = [];
		let newestBookTimestamp = booksLastModifiedAt;

		for (const book of changedBooks) {
			const { downloadUrl, coverUrl } = buildKoboRouteUrls(url.origin, shelf, book);
			const metadata = await createKoboBookMetadata(book, shelf, downloadUrl, coverUrl);
			syncResults.push({
				NewEntitlement: {
					BookEntitlement: createKoboBookEntitlement(book),
					BookMetadata: metadata
				}
			});

			const modifiedAt = new Date(book.modifiedAt);
			if (!newestBookTimestamp || modifiedAt.getTime() > newestBookTimestamp.getTime()) {
				newestBookTimestamp = modifiedAt;
			}
		}

		const hasMore = books.length > changedBooks.length;
		await updateKoboSyncCursor(shelf.name, {
			booksLastModified: newestBookTimestamp?.toISOString() ?? cursor.booksLastModified,
			booksLastCreated: newestBookTimestamp?.toISOString() ?? cursor.booksLastCreated
		});

		return json(syncResults, {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'x-kobo-sync': hasMore ? 'continue' : 'done',
				'x-kobo-books-lastmodified': toKoboTimestamp(
					newestBookTimestamp?.toISOString() ?? cursor.booksLastModified
				),
				'x-kobo-books-lastcreated': toKoboTimestamp(
					newestBookTimestamp?.toISOString() ?? cursor.booksLastCreated
				)
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			return createKoboShelfNotFoundJsonResponse();
		}

		logKoboError('library/sync failed', error, { shelf: params.shelf, path: url.pathname });
		return json({ error: 'Failed to sync Kobo library' }, { status: 500 });
	}
};
