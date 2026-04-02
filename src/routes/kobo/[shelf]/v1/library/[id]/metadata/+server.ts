import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists, resolveKoboBookOrThrow } from '$lib/server/kobo-library.js';
import { logKoboError, logKoboRequest } from '$lib/server/kobo-logging.js';
import { createKoboBookMetadata } from '$lib/server/kobo-metadata.js';
import {
	buildKoboRouteUrls,
	createKoboBookNotFoundJsonResponse,
	createKoboShelfNotFoundJsonResponse,
	isKoboBookError,
	isKoboShelfError
} from '$lib/server/kobo-routes.js';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const shelf = await assertKoboShelfExists(params.shelf);
		const book = await resolveKoboBookOrThrow(params.shelf, params.id);
		logKoboRequest('library/metadata', {
			shelf: shelf.name,
			bookId: book.id,
			path: url.pathname
		});
		const { downloadUrl, coverUrl } = buildKoboRouteUrls(url.origin, shelf, book);
		const metadata = await createKoboBookMetadata(book, shelf, downloadUrl, coverUrl);

		return json([metadata], {
			headers: {
				'Content-Type': 'application/json; charset=utf-8'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			return createKoboShelfNotFoundJsonResponse();
		}
		if (isKoboBookError(error)) {
			return createKoboBookNotFoundJsonResponse();
		}

		logKoboError('library/metadata failed', error, {
			shelf: params.shelf,
			bookId: params.id,
			path: url.pathname
		});
		return json({ error: 'Failed to load Kobo metadata' }, { status: 500 });
	}
};
