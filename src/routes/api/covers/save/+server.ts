/**
 * POST /api/covers/save
 *
 * Downloads a cover image from a URL and saves it as cover.jpg for a Calibre book.
 *
 * Request body: { bookId: number, coverUrl: string }
 * Response:     { ok: true } | { error: string }
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { saveCoverFromUrl } from '$lib/server/calibre-client.js';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { bookId, coverUrl } = body;

		if (typeof bookId !== 'number' || !bookId) {
			return json({ error: 'bookId must be a number' }, { status: 400 });
		}
		if (typeof coverUrl !== 'string' || !coverUrl.startsWith('http')) {
			return json({ error: 'coverUrl must be a valid URL' }, { status: 400 });
		}

		const ok = await saveCoverFromUrl(bookId, coverUrl);
		if (!ok) {
			return json({ error: 'Failed to save cover' }, { status: 500 });
		}

		return json({ ok: true });
	} catch (err) {
		console.error('[api/covers/save] Error:', err);
		return json({ error: 'Failed to save cover' }, { status: 500 });
	}
};
