/**
 * POST /api/library/[id]
 *
 * Update an existing Calibre library book: sync shelves and/or save a cover.
 *
 * DELETE /api/library/[id]
 *
 * Permanently delete a book: removes all Calibre DB entries, shelf links, and files.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	addBookToShelf,
	removeBookFromShelf,
	removeAllShelvesForBook
} from '$lib/server/shelf-client.js';
import {
	saveCoverFromUrl,
	saveCoverFromBytes,
	deleteBookFromCalibre
} from '$lib/server/calibre-client.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const bookId = parseInt(params.id);
	if (isNaN(bookId)) {
		return json({ error: 'Invalid book ID' }, { status: 400 });
	}

	try {
		const body = await request.json();
		const { shelfIds, previousShelfIds, coverUrl, coverData } = body;

		if (!shelfIds || !Array.isArray(shelfIds)) {
			return json({ error: 'shelfIds must be an array' }, { status: 400 });
		}
		if (!previousShelfIds || !Array.isArray(previousShelfIds)) {
			return json({ error: 'previousShelfIds must be an array' }, { status: 400 });
		}

		// Sync shelves: add newly checked, remove newly unchecked
		const desired = new Set<number>(shelfIds);
		const previous = new Set<number>(previousShelfIds);

		for (const id of desired) {
			if (!previous.has(id)) await addBookToShelf(bookId, id);
		}
		for (const id of previous) {
			if (!desired.has(id)) await removeBookFromShelf(bookId, id);
		}

		// Save cover if provided
		const hasCoverUrl = coverUrl && typeof coverUrl === 'string' && coverUrl.startsWith('http');
		const hasCoverData = coverData && typeof coverData === 'string';

		let coverSaved = false;
		if (hasCoverData) {
			const imageBytes = Buffer.from(coverData, 'base64');
			coverSaved = await saveCoverFromBytes(bookId, imageBytes);
		} else if (hasCoverUrl) {
			coverSaved = await saveCoverFromUrl(bookId, coverUrl);
		}

		return json({ ok: true, coverSaved });
	} catch (err) {
		console.error(`[api/library/${bookId}] Error:`, err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to update book' },
			{ status: 500 }
		);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	const bookId = parseInt(params.id);
	if (isNaN(bookId)) {
		return json({ error: 'Invalid book ID' }, { status: 400 });
	}

	try {
		// Remove from all shelves in app.db first
		await removeAllShelvesForBook(bookId);

		// Delete from Calibre metadata.db and filesystem
		const ok = await deleteBookFromCalibre(bookId);
		if (!ok) {
			return json({ error: 'Book not found or could not be deleted' }, { status: 404 });
		}

		return json({ ok: true });
	} catch (err) {
		console.error(`[api/library/${bookId}] DELETE error:`, err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to delete book' },
			{ status: 500 }
		);
	}
};
