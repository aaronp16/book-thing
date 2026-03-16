/**
 * GET /api/library/cover/[id]
 *
 * Serve the cover.jpg for a book by its Calibre book ID.
 * Reads the book's path from metadata.db and serves the cover.jpg file.
 */

import type { RequestHandler } from './$types';
import { env } from '$lib/server/env';
import * as path from 'path';
import * as fs from 'fs/promises';

let _db: any = null;

async function getDb() {
	if (_db) return _db;
	const dbPath = path.join(env.BOOKS_DIR, 'metadata.db');
	const { DatabaseSync } = await import('node:sqlite');
	_db = new DatabaseSync(dbPath);

	const { randomUUID } = await import('crypto');
	_db.function('title_sort', (title: string) => {
		const m = (title ?? '').match(/^(The|A|An)\s+/i);
		if (!m) return title ?? '';
		return (title ?? '').slice(m[0].length) + ', ' + m[1];
	});
	_db.function('uuid4', () => randomUUID());

	return _db;
}

export const GET: RequestHandler = async ({ params }) => {
	try {
		const bookId = parseInt(params.id, 10);
		if (isNaN(bookId)) {
			return new Response('Invalid book ID', { status: 400 });
		}

		const db = await getDb();
		const row = db.prepare('SELECT path FROM books WHERE id = ?').get(bookId) as
			| { path: string }
			| undefined;

		if (!row) {
			return new Response('Book not found', { status: 404 });
		}

		const coverPath = path.join(env.BOOKS_DIR, row.path, 'cover.jpg');

		try {
			const stat = await fs.stat(coverPath);
			const etag = `"${stat.mtimeMs.toString(36)}"`;
			const coverData = await fs.readFile(coverPath);
			return new Response(coverData, {
				headers: {
					'Content-Type': 'image/jpeg',
					'Cache-Control': 'no-cache',
					ETag: etag
				}
			});
		} catch {
			return new Response('Cover not found', { status: 404 });
		}
	} catch (err) {
		console.error('[api/library/cover] Error:', err);
		return new Response('Internal server error', { status: 500 });
	}
};
