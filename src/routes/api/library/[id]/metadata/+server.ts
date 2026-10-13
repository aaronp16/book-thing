/**
 * GET /api/library/[id]/metadata
 *
 * Metadata embedded in a library book file. Returns { metadata: null } for
 * formats we can't read (e.g. MOBI).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	decodeLibraryItemId,
	resolveLibraryItemAbsolutePath
} from '$lib/server/fs-library.js';
import { readBookMetadata } from '$lib/server/book-metadata.js';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const absolutePath = resolveLibraryItemAbsolutePath(decodeLibraryItemId(params.id));
		return json({ metadata: await readBookMetadata(absolutePath) });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to read metadata';
		return json({ error: message }, { status: 500 });
	}
};
