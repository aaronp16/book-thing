/**
 * GET /api/shelves/book/[id]
 *
 * Returns the shelf IDs that the given Calibre book is currently on.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getShelvesForBook } from '$lib/server/shelf-client.js';

export const GET: RequestHandler = async ({ params }) => {
	const bookId = parseInt(params.id);
	if (isNaN(bookId)) {
		return json({ error: 'Invalid book ID' }, { status: 400 });
	}

	try {
		const shelfIds = await getShelvesForBook(bookId);
		return json({ shelfIds });
	} catch (err) {
		console.error(`[api/shelves/book/${bookId}] Error:`, err);
		return json({ error: 'Failed to get shelves for book' }, { status: 500 });
	}
};
