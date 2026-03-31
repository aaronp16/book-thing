/**
 * POST /api/library/[id]
 *
 * Update a filesystem-native library item: copy it to additional shelves
 * and/or save a cover.
 *
 * DELETE /api/library/[id]
 *
 * Permanently delete one physical shelf-local book file and its sidecars.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { _invalidateLibraryResponseCache } from '../+server.js';
import {
	copyFilesystemLibraryItemToShelf,
	decodeLibraryItemId,
	deleteFilesystemLibraryItem,
	getFilesystemLibraryItemsForBookKey,
	resolveLibraryItemAbsolutePath
} from '$lib/server/fs-library.js';
import { encodeBookKey } from '$lib/server/fs-library.js';
import { saveCoverForBook, saveCoverFromUrlForBookWithFallback } from '$lib/server/book-covers.js';

function parseShelfNames(value: unknown, fieldName: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${fieldName} must be an array`);
	}
	const shelfNames = value
		.filter((item): item is string => typeof item === 'string')
		.map((s) => s.trim());
	if (shelfNames.length !== value.length) {
		throw new Error(`${fieldName} must contain only strings`);
	}
	return Array.from(new Set(shelfNames.filter(Boolean)));
}

export const POST: RequestHandler = async ({ params, request }) => {
	const encodedId = params.id;
	if (!encodedId) {
		return json({ error: 'Invalid book ID' }, { status: 400 });
	}

	try {
		const body = await request.json();
		const shelfNames = parseShelfNames(body.shelfNames ?? body.shelfIds ?? [], 'shelfNames');
		const coverUrl = typeof body.coverUrl === 'string' ? body.coverUrl : null;
		const coverData = typeof body.coverData === 'string' ? body.coverData : null;
		const normalizedCoverUrl = coverUrl?.startsWith('/api/covers/proxy?url=')
			? new URLSearchParams(coverUrl.slice('/api/covers/proxy?'.length)).get('url')
			: coverUrl;
		const isRemoteCoverUrl =
			normalizedCoverUrl !== null &&
			(normalizedCoverUrl.startsWith('http://') || normalizedCoverUrl.startsWith('https://'));

		const sourceRelativePath = decodeLibraryItemId(encodedId);
		const sourceAbsolutePath = resolveLibraryItemAbsolutePath(sourceRelativePath);
		const bookKey = encodeBookKey(sourceRelativePath);
		const existingCopies = await getFilesystemLibraryItemsForBookKey(bookKey);
		const existingShelves = new Set(existingCopies.map((copy) => copy.shelf));
		const desiredShelves = new Set(shelfNames);

		for (const shelfName of desiredShelves) {
			if (!existingShelves.has(shelfName)) {
				await copyFilesystemLibraryItemToShelf(encodedId, shelfName);
			}
		}

		for (const copy of existingCopies) {
			if (!desiredShelves.has(copy.shelf)) {
				await deleteFilesystemLibraryItem(copy.id);
			}
		}

		let coverSaved = false;
		let coverStorage: 'embedded' | 'sidecar' | null = null;
		if (coverData) {
			const imageBytes = Buffer.from(coverData, 'base64');
			const copies = await getFilesystemLibraryItemsForBookKey(bookKey);
			for (const copy of copies) {
				const result = await saveCoverForBook(copy.path, imageBytes);
				if (!coverStorage && result) {
					coverStorage = result;
				}
			}
			coverSaved = coverStorage !== null;
		} else if (isRemoteCoverUrl && normalizedCoverUrl) {
			const copies = await getFilesystemLibraryItemsForBookKey(bookKey);
			for (const copy of copies) {
				const result = await saveCoverFromUrlForBookWithFallback(copy.path, normalizedCoverUrl);
				if (!coverStorage && result) {
					coverStorage = result;
				}
			}
			coverSaved = coverStorage !== null;
		}

		_invalidateLibraryResponseCache();

		return json({ ok: true, coverSaved, coverStorage });
	} catch (err) {
		console.error(`[api/library/${encodedId}] Error:`, err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to update book' },
			{ status: 500 }
		);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	const encodedId = params.id;
	if (!encodedId) {
		return json({ error: 'Invalid book ID' }, { status: 400 });
	}

	try {
		await deleteFilesystemLibraryItem(encodedId);
		_invalidateLibraryResponseCache();
		return json({ ok: true });
	} catch (err) {
		console.error(`[api/library/${encodedId}] DELETE error:`, err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to delete book' },
			{ status: 500 }
		);
	}
};
