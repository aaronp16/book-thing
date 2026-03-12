/**
 * POST /api/download
 *
 * Start a download for a book from MAM.
 *
 * Request body:
 * {
 *   mamId: number;      // MAM torrent ID
 *   title: string;      // Book title (for display)
 *   shelfIds: number[]; // Shelf IDs to add book to after download
 * }
 *
 * Response:
 * {
 *   jobId: string;    // Use with /api/progress/[id] for SSE updates
 * }
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startDownload } from '$lib/server/downloader';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { mamId, title, shelfIds } = body;

		if (!mamId || typeof mamId !== 'number') {
			return json({ error: 'mamId is required and must be a number' }, { status: 400 });
		}

		if (!title || typeof title !== 'string') {
			return json({ error: 'title is required and must be a string' }, { status: 400 });
		}

		if (!shelfIds || !Array.isArray(shelfIds) || shelfIds.length === 0) {
			return json({ error: 'shelfIds is required and must be a non-empty array' }, { status: 400 });
		}

		if (!shelfIds.every((id) => typeof id === 'number')) {
			return json({ error: 'All shelfIds must be numbers' }, { status: 400 });
		}

		const jobId = await startDownload(mamId, title, shelfIds);

		return json({ jobId });
	} catch (err) {
		console.error('[api/download] Error:', err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start download' },
			{ status: 500 }
		);
	}
};
