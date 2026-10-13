/**
 * GET /api/library/[id]/cover/candidates
 *
 * Cover images found online for this book, using its embedded ISBN, title and
 * author (falling back to what we parsed from the filename).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	decodeLibraryItemId,
	parseBookFilename,
	resolveLibraryItemAbsolutePath
} from '$lib/server/fs-library.js';
import { readBookMetadata } from '$lib/server/book-metadata.js';
import { findCoverCandidates } from '$lib/server/cover-search.js';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const absolutePath = resolveLibraryItemAbsolutePath(decodeLibraryItemId(params.id));
		const metadata = await readBookMetadata(absolutePath).catch(() => null);
		const fromFilename = parseBookFilename(absolutePath);

		const candidates = await findCoverCandidates({
			isbn: metadata?.isbn,
			title: metadata?.title || fromFilename.title,
			authors: metadata?.authors.length
				? metadata.authors
				: fromFilename.author && fromFilename.author !== 'Unknown'
					? [fromFilename.author]
					: []
		});
		return json({ candidates });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Cover search failed';
		return json({ error: message }, { status: 500 });
	}
};
