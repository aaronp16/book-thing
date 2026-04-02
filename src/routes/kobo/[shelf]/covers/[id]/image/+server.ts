import * as fs from 'fs/promises';
import type { RequestHandler } from './$types';
import {
	createBookCoverPlaceholderSvg,
	detectImageContentType,
	extractEmbeddedCoverBytes,
	findSidecarCover
} from '$lib/server/book-covers.js';
import { resolveKoboBookAbsolutePath, resolveKoboBookOrThrow } from '$lib/server/kobo-library.js';
import {
	createKoboBookNotFoundTextResponse,
	createKoboShelfNotFoundTextResponse,
	isKoboBookError,
	isKoboShelfError
} from '$lib/server/kobo-routes.js';
import { logKoboError, logKoboRequest } from '$lib/server/kobo-logging.js';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const book = await resolveKoboBookOrThrow(params.shelf, params.id);
		logKoboRequest('cover', {
			shelf: params.shelf,
			bookId: book.id,
			width: url.searchParams.get('width') ?? url.searchParams.get('Width'),
			height: url.searchParams.get('height') ?? url.searchParams.get('Height'),
			quality: url.searchParams.get('quality') ?? url.searchParams.get('Quality'),
			isGreyscale: url.searchParams.get('isGreyscale') ?? url.searchParams.get('IsGreyscale')
		});
		const absolutePath = resolveKoboBookAbsolutePath(book);

		const sidecarPath = await findSidecarCover(absolutePath);
		if (sidecarPath) {
			const stat = await fs.stat(sidecarPath);
			const coverData = await fs.readFile(sidecarPath);
			return new Response(new Uint8Array(coverData), {
				headers: {
					'Content-Type': 'image/jpeg',
					'Cache-Control': 'no-cache',
					ETag: `"${stat.mtimeMs.toString(36)}"`
				}
			});
		}

		const embeddedCover = await extractEmbeddedCoverBytes(absolutePath);
		if (embeddedCover) {
			const stat = await fs.stat(absolutePath);
			return new Response(new Uint8Array(embeddedCover), {
				headers: {
					'Content-Type': detectImageContentType(embeddedCover),
					'Cache-Control': 'no-cache',
					ETag: `"${stat.mtimeMs.toString(36)}"`
				}
			});
		}

		const placeholderSvg = createBookCoverPlaceholderSvg(book.title);
		return new Response(placeholderSvg, {
			headers: {
				'Content-Type': 'image/svg+xml; charset=utf-8',
				'Cache-Control': 'no-cache'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			return createKoboShelfNotFoundTextResponse();
		}
		if (isKoboBookError(error)) {
			return createKoboBookNotFoundTextResponse();
		}

		logKoboError('cover failed', error, { shelf: params.shelf, bookId: params.id });
		return new Response('Failed to load cover', { status: 500 });
	}
};
