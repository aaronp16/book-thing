/**
 * GET /api/library
 *
 * Read books directly from the filesystem, sorted by most recently modified.
 * Returns one entry per physical file.
 *
 * Query params:
 *   ?shelf={shelfName} - Filter to only books in this shelf
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { scanFilesystemLibrary } from '$lib/server/fs-library.js';

interface GroupedLibraryBook {
	id: string;
	bookKey: string;
	title: string;
	author: string;
	hasCover: boolean;
	path: string;
	addedAt: string;
	lastModified: string;
	shelf: string;
	relativePath: string;
	extension: string;
	size: number;
	shelfNames: string[];
	copyCount: number;
}

const LIBRARY_RESPONSE_TTL_MS = 3000;
const libraryResponseCache = new Map<
	string,
	{ expiresAt: number; payload: { books: GroupedLibraryBook[]; totalBooks: number } }
>();

export function _invalidateLibraryResponseCache(): void {
	libraryResponseCache.clear();
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const shelfName = url.searchParams.get('shelf')?.trim() || undefined;
		const cacheKey = shelfName ?? '__all__';
		const cached = libraryResponseCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return json(cached.payload);
		}

		const books = await scanFilesystemLibrary();
		const grouped = new Map<string, GroupedLibraryBook>();

		for (const book of books) {
			const existing = grouped.get(book.bookKey);
			if (!existing) {
				grouped.set(book.bookKey, {
					id: book.id,
					bookKey: book.bookKey,
					title: book.title,
					author: book.author,
					hasCover: book.hasCover,
					path: book.relativePath,
					addedAt: book.modifiedAt,
					lastModified: book.modifiedAt,
					shelf: book.shelf,
					relativePath: book.relativePath,
					extension: book.extension,
					size: book.size,
					shelfNames: [book.shelf],
					copyCount: 1
				});
				continue;
			}

			existing.copyCount += 1;
			if (!existing.shelfNames.includes(book.shelf)) {
				existing.shelfNames.push(book.shelf);
				existing.shelfNames.sort((a, b) => a.localeCompare(b));
			}
			if (new Date(book.modifiedAt).getTime() > new Date(existing.lastModified).getTime()) {
				existing.id = book.id;
				existing.hasCover = book.hasCover;
				existing.path = book.relativePath;
				existing.addedAt = book.modifiedAt;
				existing.lastModified = book.modifiedAt;
				existing.shelf = book.shelf;
				existing.relativePath = book.relativePath;
				existing.extension = book.extension;
				existing.size = book.size;
			}
		}

		const groupedBooks = Array.from(grouped.values()).sort(
			(a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
		);
		const filteredBooks = shelfName
			? groupedBooks.filter((book) => book.shelfNames.includes(shelfName))
			: groupedBooks;
		const payload = {
			books: filteredBooks,
			totalBooks: filteredBooks.length
		};
		libraryResponseCache.set(cacheKey, {
			expiresAt: Date.now() + LIBRARY_RESPONSE_TTL_MS,
			payload
		});

		return json(payload);
	} catch (err) {
		console.error('[api/library] Error:', err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to read library' },
			{ status: 500 }
		);
	}
};
