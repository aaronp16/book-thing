/**
 * Debug endpoint: returns the exact JSON that the Kobo sync endpoint would
 * send to the device for a given shelf. Use this to inspect the response
 * structure field-by-field and compare against calibre-web's format.
 *
 * GET /api/dev/kobo-sync-debug?shelf=aaron
 * GET /api/dev/kobo-sync-debug?shelf=aaron&limit=1   (single book for focused inspection)
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists, listKoboBooksForShelf } from '$lib/server/kobo-library.js';
import { createKoboBookEntitlement, createKoboBookMetadata } from '$lib/server/kobo-metadata.js';
import { buildKoboRouteUrls, toKoboTimestamp } from '$lib/server/kobo-routes.js';
import { getKoboReadingState } from '$lib/server/kobo-state.js';

export const GET: RequestHandler = async ({ url }) => {
	const shelfName = url.searchParams.get('shelf') ?? 'aaron';
	const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);

	try {
		const shelf = await assertKoboShelfExists(shelfName);
		const allBooks = await listKoboBooksForShelf(shelfName);
		const books = allBooks.slice(0, limit);

		const syncResults = [];

		for (const book of books) {
			// Use a fixed origin matching what the device sees
			const origin = url.origin;
			const { downloadUrl, koboId } = buildKoboRouteUrls(origin, shelf, book);
			const metadata = await createKoboBookMetadata(book, shelf, downloadUrl, koboId);
			const entitlement: Record<string, unknown> = {
				BookEntitlement: createKoboBookEntitlement(book),
				BookMetadata: metadata
			};

			const readingState = await getKoboReadingState(book.id);
			const timestamp = readingState?.updatedAt ?? book.modifiedAt;
			entitlement.ReadingState = {
				EntitlementId: koboId,
				Created: toKoboTimestamp(book.modifiedAt),
				LastModified: toKoboTimestamp(timestamp),
				PriorityTimestamp: toKoboTimestamp(timestamp),
				StatusInfo: {
					LastModified: toKoboTimestamp(timestamp),
					Status: readingState?.status ?? 'ReadyToRead',
					TimesStartedReading: readingState?.timesStartedReading ?? 0
				},
				Statistics: {
					LastModified: toKoboTimestamp(timestamp)
				},
				CurrentBookmark: {
					LastModified: toKoboTimestamp(timestamp)
				}
			};

			syncResults.push({ NewEntitlement: entitlement });
		}

		return json(
			{
				_debug: {
					totalBooks: allBooks.length,
					returnedBooks: books.length,
					shelf: shelf.name,
					note: 'This is the exact array the device receives from /v1/library/sync'
				},
				syncResponse: syncResults
			},
			{
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-cache'
				}
			}
		);
	} catch (error) {
		return json({ error: String(error) }, { status: 500 });
	}
};
