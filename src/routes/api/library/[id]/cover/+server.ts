/**
 * GET /api/library/[id]/cover
 *
 * The cover image embedded in a library book file. 404 when it has none.
 * Clients add ?v={version} so the image can be cached long-term and still
 * refresh when the file changes.
 *
 * PUT /api/library/[id]/cover  (body: image/jpeg)
 *
 * Embed a new cover in every EPUB/KEPUB copy of this book (all shelves, both
 * formats). Files keep their original modification time.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	decodeLibraryItemId,
	getEpubFilesForLibraryItem,
	resolveLibraryItemAbsolutePath
} from '$lib/server/fs-library.js';
import { readBookCover, writeBookCover } from '$lib/server/book-metadata.js';
import { _invalidateLibraryResponseCache } from '../../+server.js';

const MAX_COVER_BYTES = 10 * 1024 * 1024;

export const GET: RequestHandler = async ({ params, url }) => {
	let cover: Awaited<ReturnType<typeof readBookCover>>;
	try {
		cover = await readBookCover(resolveLibraryItemAbsolutePath(decodeLibraryItemId(params.id)));
	} catch {
		error(404, 'Book not found');
	}
	if (!cover) error(404, 'No embedded cover');

	return new Response(Buffer.from(cover.data), {
		headers: {
			'Content-Type': cover.contentType,
			'Cache-Control': url.searchParams.has('v')
				? 'private, max-age=31536000, immutable'
				: 'private, no-cache'
		}
	});
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const jpeg = new Uint8Array(await request.arrayBuffer());
	if (jpeg.length === 0 || jpeg.length > MAX_COVER_BYTES) {
		return json({ error: 'Cover must be between 1 byte and 10 MB' }, { status: 400 });
	}
	if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff)) {
		return json({ error: 'Cover must be a JPEG image' }, { status: 400 });
	}

	let files: string[];
	try {
		files = await getEpubFilesForLibraryItem(params.id);
	} catch {
		return json({ error: 'Book not found' }, { status: 404 });
	}
	if (files.length === 0) {
		return json({ error: 'Only EPUB/KEPUB books can have their cover replaced' }, { status: 400 });
	}

	const updated: string[] = [];
	const failed: { file: string; error: string }[] = [];
	for (const file of files) {
		try {
			await writeBookCover(file, jpeg);
			updated.push(file);
		} catch (err) {
			failed.push({ file, error: err instanceof Error ? err.message : String(err) });
		}
	}
	_invalidateLibraryResponseCache();

	if (failed.length) console.error('[api/library/cover] Failed to update:', failed);
	return json(
		{ updated: updated.length, failed: failed.length, errors: failed.map((f) => f.error) },
		{ status: updated.length ? 200 : 500 }
	);
};
