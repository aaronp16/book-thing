import { json } from '@sveltejs/kit';
import { listShelfDirectories } from '$lib/server/fs-shelves.js';
import type { RequestHandler } from './$types';

/**
 * GET /api/shelves
 * Returns top-level shelf directories from BOOKS_DIR.
 */
export const GET: RequestHandler = async () => {
	try {
		const shelves = await listShelfDirectories();
		return json({ shelves });
	} catch (error) {
		console.error('Failed to load shelves:', error);
		return json({ error: 'Failed to load shelves', shelves: [] }, { status: 500 });
	}
};
