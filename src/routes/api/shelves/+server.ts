import { json } from '@sveltejs/kit';
import { listShelves } from '$lib/server/shelf-client.js';
import type { RequestHandler } from './$types';

/**
 * GET /api/shelves
 * Returns all shelves for the admin user (user_id=1)
 */
export const GET: RequestHandler = async () => {
	try {
		const shelves = await listShelves();
		return json({ shelves });
	} catch (error) {
		console.error('Failed to load shelves:', error);
		return json({ error: 'Failed to load shelves', shelves: [] }, { status: 500 });
	}
};
