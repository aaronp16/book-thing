/**
 * GET /api/library
 *
 * Read books from Calibre's metadata.db, sorted by most recently added.
 * Returns book id, title, author, has_cover, path, and timestamp.
 *
 * Query params:
 *   ?shelf={shelfId} - Filter to only books on this shelf
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$lib/server/env';
import { getBooksOnShelf } from '$lib/server/shelf-client';
import * as path from 'path';

let _db: any = null;

async function getDb() {
	if (_db) return _db;
	const dbPath = path.join(env.BOOKS_DIR, 'metadata.db');
	const { DatabaseSync } = await import('node:sqlite');
	_db = new DatabaseSync(dbPath);

	// Calibre triggers need these functions
	const { randomUUID } = await import('crypto');
	_db.function('title_sort', (title: string) => {
		const m = (title ?? '').match(/^(The|A|An)\s+/i);
		if (!m) return title ?? '';
		return (title ?? '').slice(m[0].length) + ', ' + m[1];
	});
	_db.function('uuid4', () => randomUUID());

	return _db;
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const db = await getDb();
		const shelfIdParam = url.searchParams.get('shelf');

		let bookIds: number[] | null = null;

		// If shelf filter requested, get book IDs on that shelf
		if (shelfIdParam) {
			const shelfId = parseInt(shelfIdParam, 10);
			if (isNaN(shelfId)) {
				return json({ error: 'Invalid shelf ID' }, { status: 400 });
			}

			try {
				bookIds = await getBooksOnShelf(shelfId);
				if (bookIds.length === 0) {
					// No books on this shelf
					return json({ books: [], totalBooks: 0 });
				}
			} catch (err) {
				console.error('[api/library] Failed to get books on shelf:', err);
				return json({ error: 'Failed to filter by shelf' }, { status: 500 });
			}
		}

		// Build query with optional shelf filter
		let query = `
			SELECT b.id, b.title, b.has_cover, b.path, b.timestamp, b.last_modified,
			       (SELECT GROUP_CONCAT(a.name, ', ')
			        FROM books_authors_link bal
			        JOIN authors a ON a.id = bal.author
			        WHERE bal.book = b.id) AS authors
			FROM   books b
		`;

		if (bookIds !== null) {
			query += ` WHERE b.id IN (${bookIds.join(',')})`;
		}

		query += ` ORDER BY b.timestamp DESC`;

		const books = db.prepare(query).all() as Array<{
			id: number;
			title: string;
			has_cover: number;
			path: string;
			timestamp: string;
			last_modified: string;
			authors: string | null;
		}>;

		// Deduplicate by title, keeping the highest ID (most recently added copy)
		const seen = new Set<string>();
		const deduped = books.filter((b) => {
			const key = b.title.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		return json({
			books: deduped.map((b) => ({
				id: b.id,
				title: b.title,
				author: b.authors ?? 'Unknown',
				hasCover: b.has_cover === 1,
				path: b.path,
				addedAt: b.timestamp,
				lastModified: b.last_modified
			})),
			totalBooks: deduped.length
		});
	} catch (err) {
		console.error('[api/library] Error:', err);
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to read library' },
			{ status: 500 }
		);
	}
};
