import * as fs from 'fs/promises';
import * as path from 'path';
import type { RequestHandler } from './$types';
import {
	getKoboDownloadFormat,
	resolveKoboBookAbsolutePath,
	resolveKoboBookOrThrow
} from '$lib/server/kobo-library.js';
import { logKoboError, logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';
import {
	createKoboBookNotFoundTextResponse,
	createKoboShelfNotFoundTextResponse,
	isKoboBookError,
	isKoboShelfError
} from '$lib/server/kobo-routes.js';

function getContentType(extension: string): string {
	const ext = extension.toLowerCase();
	if (ext === 'epub' || ext === 'kepub' || ext === 'kepub.epub') return 'application/epub+zip';
	if (ext === 'pdf') return 'application/pdf';
	if (ext === 'cbz') return 'application/x-cbz';
	if (ext === 'cbr') return 'application/x-cbr';
	if (ext === 'txt') return 'text/plain; charset=utf-8';
	return 'application/octet-stream';
}

export const GET: RequestHandler = async ({ params }) => {
	try {
		const book = await resolveKoboBookOrThrow(params.shelf, params.id);
		logKoboRequest('download', {
			shelf: params.shelf,
			bookId: book.id,
			format: params.format
		});
		const requestedFormat = params.format.toLowerCase();
		const bookFormat = getKoboDownloadFormat(book).toLowerCase();
		if (requestedFormat !== bookFormat) {
			logKoboWarn('download format mismatch', {
				shelf: params.shelf,
				bookId: book.id,
				requestedFormat,
				availableFormat: bookFormat
			});
			return new Response('Format not available for this book', { status: 404 });
		}

		const absolutePath = resolveKoboBookAbsolutePath(book);
		const fileData = await fs.readFile(absolutePath);
		const filename = path.basename(absolutePath);

		logKoboRequest('download response', {
			shelf: params.shelf,
			bookId: book.id,
			format: params.format,
			filename,
			sizeBytes: fileData.byteLength
		});

		return new Response(new Uint8Array(fileData), {
			headers: {
				'Content-Type': getContentType(book.extension),
				'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
				'Content-Length': String(fileData.byteLength),
				'Cache-Control': 'no-cache'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('download shelf not found', { shelf: params.shelf, bookId: params.id });
			return createKoboShelfNotFoundTextResponse();
		}
		if (isKoboBookError(error)) {
			logKoboWarn('download book not found', { shelf: params.shelf, bookId: params.id });
			return createKoboBookNotFoundTextResponse();
		}

		logKoboError('download failed', error, {
			shelf: params.shelf,
			bookId: params.id,
			format: params.format
		});
		return new Response('Failed to download book', { status: 500 });
	}
};
