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
import { logKoboError, logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';

/**
 * Cover image route matching Kobo's path-based URL template:
 *   /kobo/{shelf}/covers/{ImageId}/{Width}/{Height}/false/image.jpg
 *   /kobo/{shelf}/covers/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg
 *
 * The [...rest] param captures the remaining path segments after height:
 *   "false/image.jpg" or "{Quality}/{IsGreyscale}/image.jpg"
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const book = await resolveKoboBookOrThrow(params.shelf, params.id);
		logKoboRequest('cover', {
			shelf: params.shelf,
			bookId: book.id,
			width: params.width,
			height: params.height,
			rest: params.rest
		});
		const absolutePath = resolveKoboBookAbsolutePath(book);

		const sidecarPath = await findSidecarCover(absolutePath);
		if (sidecarPath) {
			const stat = await fs.stat(sidecarPath);
			const coverData = await fs.readFile(sidecarPath);
			logKoboRequest('cover response', {
				shelf: params.shelf,
				bookId: book.id,
				source: 'sidecar',
				sizeBytes: coverData.byteLength
			});
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
			logKoboRequest('cover response', {
				shelf: params.shelf,
				bookId: book.id,
				source: 'embedded',
				sizeBytes: embeddedCover.byteLength
			});
			return new Response(new Uint8Array(embeddedCover), {
				headers: {
					'Content-Type': detectImageContentType(embeddedCover),
					'Cache-Control': 'no-cache',
					ETag: `"${stat.mtimeMs.toString(36)}"`
				}
			});
		}

		const placeholderSvg = createBookCoverPlaceholderSvg(book.title);
		logKoboRequest('cover response', {
			shelf: params.shelf,
			bookId: book.id,
			source: 'placeholder'
		});
		return new Response(placeholderSvg, {
			headers: {
				'Content-Type': 'image/svg+xml; charset=utf-8',
				'Cache-Control': 'no-cache'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('cover shelf not found', { shelf: params.shelf, bookId: params.id });
			return createKoboShelfNotFoundTextResponse();
		}
		if (isKoboBookError(error)) {
			logKoboWarn('cover book not found', { shelf: params.shelf, bookId: params.id });
			return createKoboBookNotFoundTextResponse();
		}

		logKoboError('cover failed', error, { shelf: params.shelf, bookId: params.id });
		return new Response('Failed to load cover', { status: 500 });
	}
};
