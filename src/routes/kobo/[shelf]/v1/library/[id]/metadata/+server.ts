import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists, resolveKoboBookOrThrow } from '$lib/server/kobo-library.js';
import { logKoboError, logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';
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
		const { downloadUrl, koboId } = buildKoboRouteUrls(url.origin, shelf, book);
		const metadata = await createKoboBookMetadata(book, shelf, downloadUrl, koboId);

		logKoboRequest('library/metadata response', {
			shelf: shelf.name,
			bookId: book.id,
			koboId: book.koboId,
			title: book.title,
			metadata
		});

		return json([metadata], {
			headers: {
				'Content-Type': 'application/json; charset=utf-8'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('library/metadata shelf not found', { shelf: params.shelf, bookId: params.id });
			return createKoboShelfNotFoundJsonResponse();
		}
		if (isKoboBookError(error)) {
			logKoboWarn('library/metadata book not found', { shelf: params.shelf, bookId: params.id });
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
