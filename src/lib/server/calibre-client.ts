/**
 * Calibre library integration — writes directly to Calibre's metadata.db
 *
 * Calibre's library structure:
 *   /books/
 *     Author Name/
 *       Title (book_id)/
 *         Title - Author Name.epub   ← the actual file
 *     metadata.db                    ← SQLite database
 *
 * We insert rows into books, authors, books_authors_link, and data,
 * then move the already-copied flat file into the correct subdirectory.
 *
 * Uses node:sqlite (Node 22 built-in, experimental) — no extra dependencies.
 */

import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { env } from './env.js';
import { extractEmbeddedCoverBytes, extractEmbeddedCoverDataUrl } from './book-covers.js';
import { readBookMetadata } from './book-metadata.js';
import {
	searchGoogleBooksCovers as searchGoogleBooksCoversForBook,
	searchOpenLibraryCovers as searchOpenLibraryCoversForBook
} from './book-covers.js';

// node:sqlite is experimental in Node 22 — lazy-init so the warning fires once at startup
let _db: any = null;
let _booksUid: number | null = null;
let _booksGid: number | null = null;

async function getDb() {
	if (_db) return _db;
	const dbPath = path.join(env.BOOKS_DIR, 'metadata.db');
	const { DatabaseSync } = await import('node:sqlite');
	_db = new DatabaseSync(dbPath);

	// Cache the UID/GID of BOOKS_DIR so new subdirectories can be chowned to
	// match — the container runs as root but the volume is owned by the host user.
	try {
		const stat = await fs.stat(env.BOOKS_DIR);
		_booksUid = stat.uid;
		_booksGid = stat.gid;
	} catch {
		// Non-fatal — chown will just be skipped
	}

	// Calibre registers title_sort() and uuid4() as custom SQLite functions at
	// runtime. The books_insert_trg and series_insert_trg triggers call them,
	// so we must register equivalent functions on our connection or every INSERT
	// into books/series will fail with "no such function".
	_db.function('title_sort', (title: string) => titleSort(title ?? ''));
	_db.function('uuid4', () => randomUUID());

	return _db;
}

/**
 * Derive a safe directory/filename component from a string.
 * Replaces characters illegal on most filesystems, collapses whitespace.
 */
function sanitize(str: string): string {
	return str
		.replace(/[\\/:*?"<>|]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

/**
 * Create a directory (recursive) and chown it to match BOOKS_DIR's owner so
 * that Calibre-Web (running as UID 1000) can rename/delete it even when
 * book-thing runs as root inside Docker.
 */
async function mkdirOwned(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
	if (_booksUid !== null && _booksGid !== null) {
		try {
			await fs.chown(dirPath, _booksUid, _booksGid);
		} catch {
			// chown fails if not running as root — not fatal, ownership stays as-is
		}
	}
}

/** "Roald Dahl" → "Dahl, Roald" */
function authorSort(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length === 1) return name;
	const last = parts[parts.length - 1];
	const rest = parts.slice(0, -1).join(' ');
	return `${last}, ${rest}`;
}

/** "The BFG" → "BFG, The" */
function titleSort(title: string): string {
	const m = title.match(/^(The|A|An)\s+/i);
	if (!m) return title;
	return title.slice(m[0].length) + ', ' + m[1];
}

/**
 * Add a book file to Calibre's library:
 *  1. Parse title/author from file metadata
 *  2. Insert into metadata.db (books, authors, books_authors_link, data)
 *  3. Create the Author/Title (id)/ directory structure
 *  4. Move the flat file into it with the canonical Calibre filename
 *
 * @param flatFilePath - Absolute path to the already-copied flat file in BOOKS_DIR
 * @returns The new book_id, or null on failure (never throws)
 */
export async function addBookToCalibre(flatFilePath: string): Promise<number | null> {
	try {
		const filename = path.basename(flatFilePath);
		const ext = path.extname(filename).toLowerCase().slice(1); // "epub"
		const meta = await readBookMetadata(flatFilePath);

		const { title, author } = meta;

		console.log(`[calibre-db] Adding "${title}" by "${author}" (${ext})`);

		const db = await getDb();
		const now = new Date()
			.toISOString()
			.replace('T', ' ')
			.replace(/\.\d+Z$/, '+00:00');
		const uuid = randomUUID();

		// Insert or reuse author
		const existingAuthor = db.prepare('SELECT id FROM authors WHERE name = ?').get(author);
		let authorId: number;
		if (existingAuthor) {
			authorId = existingAuthor.id;
			console.log(`[calibre-db] Reusing author id=${authorId}`);
		} else {
			const r = db
				.prepare('INSERT INTO authors (name, sort, link) VALUES (?, ?, ?)')
				.run(author, authorSort(author), '');
			authorId = Number(r.lastInsertRowid);
			console.log(`[calibre-db] Inserted author id=${authorId}`);
		}

		// Insert book with empty path first (we need the id to build the path)
		const bookId = Number(
			db
				.prepare(
					`
				INSERT INTO books (title, sort, timestamp, pubdate, series_index, author_sort, uuid, path, has_cover, last_modified)
				VALUES (?, ?, ?, ?, 1.0, ?, ?, '', 0, ?)
			`
				)
				.run(title, titleSort(title), now, now, authorSort(author), uuid, now).lastInsertRowid
		);
		console.log(`[calibre-db] Inserted book id=${bookId}`);

		// Link book ↔ author
		db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)').run(bookId, authorId);

		// Build Calibre path: "Author Name/Title (book_id)"
		const relPath = `${sanitize(author)}/${sanitize(title)} (${bookId})`;
		const absDir = path.join(env.BOOKS_DIR, relPath);
		await mkdirOwned(absDir);

		// Canonical Calibre filename: "Title - Author" (no extension)
		const canonicalName = sanitize(`${title} - ${author}`);
		const destFile = path.join(absDir, `${canonicalName}.${ext}`);

		// Move flat file into structured directory
		await fs.rename(flatFilePath, destFile);
		console.log(`[calibre-db] Moved to: ${destFile}`);

		// Update books.path
		db.prepare('UPDATE books SET path = ? WHERE id = ?').run(relPath, bookId);

		// Insert data row
		const stat = await fs.stat(destFile);
		db.prepare('INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)').run(
			bookId,
			ext.toUpperCase(),
			stat.size,
			canonicalName
		);

		// Extract and save embedded cover (EPUB only) — best-effort, non-fatal
		if (ext === 'epub') {
			try {
				const coverBytes = await extractEmbeddedCoverBytes(destFile);
				if (coverBytes) {
					const coverPath = path.join(absDir, 'cover.jpg');
					await fs.writeFile(coverPath, coverBytes);
					if (_booksUid !== null && _booksGid !== null) {
						await fs.chown(coverPath, _booksUid, _booksGid).catch(() => {});
					}
					db.prepare('UPDATE books SET has_cover = 1, last_modified = ? WHERE id = ?').run(
						now,
						bookId
					);
					console.log(`[calibre-db] Saved embedded cover for book id=${bookId}`);
				}
			} catch (err) {
				console.warn(`[calibre-db] Cover extraction failed for book id=${bookId}: ${err}`);
			}
		}

		console.log(`[calibre-db] Done — book id=${bookId} registered in Calibre library`);
		return bookId;
	} catch (err) {
		console.error(`[calibre-db] Failed to add "${flatFilePath}" to Calibre:`, err);
		return null;
	}
}

/**
 * Delete a book from the Calibre library entirely:
 *  1. Remove all DB rows referencing the book (data, books_authors_link, books)
 *  2. Clean up orphaned author rows (authors with no remaining books)
 *  3. Delete the book's directory from the filesystem
 *
 * @param bookId - Calibre book ID
 * @returns true on success, false if the book wasn't found or an error occurred
 */
export async function deleteBookFromCalibre(bookId: number): Promise<boolean> {
	try {
		const db = await getDb();

		// Look up the book path before deleting
		const row = db.prepare('SELECT path FROM books WHERE id = ?').get(bookId) as
			| { path: string }
			| undefined;
		if (!row) {
			console.warn(`[calibre-db] deleteBookFromCalibre: book id=${bookId} not found`);
			return false;
		}

		// Collect author IDs linked to this book (to check for orphans after delete)
		const authorIds = (
			db.prepare('SELECT author FROM books_authors_link WHERE book = ?').all(bookId) as {
				author: number;
			}[]
		).map((r) => r.author);

		// Delete DB rows in dependency order
		db.prepare('DELETE FROM data WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books_authors_link WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books_tags_link WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books_series_link WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books_ratings_link WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books_publishers_link WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books_languages_link WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM comments WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM identifiers WHERE book = ?').run(bookId);
		db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
		console.log(`[calibre-db] Deleted book id=${bookId} from metadata.db`);

		// Remove orphaned authors (authors with no remaining books)
		for (const authorId of authorIds) {
			const remaining = db
				.prepare('SELECT COUNT(*) as cnt FROM books_authors_link WHERE author = ?')
				.get(authorId) as { cnt: number };
			if (remaining.cnt === 0) {
				db.prepare('DELETE FROM authors WHERE id = ?').run(authorId);
				console.log(`[calibre-db] Removed orphaned author id=${authorId}`);
			}
		}

		// Delete book directory from filesystem
		const bookDir = path.join(env.BOOKS_DIR, row.path);
		try {
			await fs.rm(bookDir, { recursive: true, force: true });
			console.log(`[calibre-db] Deleted directory: ${bookDir}`);
		} catch (err) {
			console.warn(`[calibre-db] Could not delete directory "${bookDir}": ${err}`);
			// Non-fatal — DB is already cleaned up
		}

		// If the author directory is now empty, remove it too
		const authorDir = path.join(env.BOOKS_DIR, row.path.split('/')[0]);
		try {
			const entries = await fs.readdir(authorDir);
			if (entries.length === 0) {
				await fs.rmdir(authorDir);
				console.log(`[calibre-db] Removed empty author directory: ${authorDir}`);
			}
		} catch {
			// Non-fatal
		}

		return true;
	} catch (err) {
		console.error(`[calibre-db] deleteBookFromCalibre(${bookId}) failed:`, err);
		return false;
	}
}

function fetchUrl(url: string, timeoutMs = 10000): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const client = url.startsWith('https') ? https : http;
		const req = client.get(url, { timeout: timeoutMs }, (res) => {
			if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
				fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
				res.resume();
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode}`));
				res.resume();
				return;
			}
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy();
			reject(new Error('timeout'));
		});
	});
}

/**
 * Extract the embedded cover image from a registered Calibre book's EPUB file.
 * Returns the image as a base64 data URL (for use as a cover search result),
 * or null if the book isn't an EPUB or has no embedded cover.
 */
export async function extractCoverForBook(bookId: number): Promise<string | null> {
	try {
		const db = await getDb();
		const row = db
			.prepare(
				`
			SELECT b.path, d.name, d.format
			FROM books b
			JOIN data d ON d.book = b.id
			WHERE b.id = ?
			ORDER BY CASE d.format WHEN 'EPUB' THEN 0 ELSE 1 END
			LIMIT 1
		`
			)
			.get(bookId) as { path: string; name: string; format: string } | undefined;

		if (!row) return null;

		// If cover.jpg already exists on disk, return that — it's what's currently set
		const existingCoverPath = path.join(env.BOOKS_DIR, row.path, 'cover.jpg');
		try {
			const coverBytes = await fs.readFile(existingCoverPath);
			if (coverBytes.length > 100) {
				return `data:image/jpeg;base64,${coverBytes.toString('base64')}`;
			}
		} catch {
			// No cover.jpg — fall through to EPUB extraction
		}

		if (row.format !== 'EPUB') return null;

		const epubPath = path.join(env.BOOKS_DIR, row.path, `${row.name}.epub`);
		return await extractEmbeddedCoverDataUrl(epubPath);
	} catch (err) {
		console.warn(`[calibre-db] extractCoverForBook(${bookId}) failed: ${err}`);
		return null;
	}
}

/**
 * Save raw image bytes as cover.jpg for a Calibre book.
 * Also sets has_cover = 1 in metadata.db.
 *
 * @param bookId  - Calibre book ID
 * @param imageBytes - Raw image data (JPEG, PNG, etc.)
 * @returns true on success, false on failure (never throws)
 */
export async function saveCoverFromBytes(bookId: number, imageBytes: Buffer): Promise<boolean> {
	try {
		const db = await getDb();

		const row = db.prepare('SELECT path FROM books WHERE id = ?').get(bookId) as
			| { path: string }
			| undefined;
		if (!row) {
			console.error(`[calibre-db] saveCoverFromBytes: book id=${bookId} not found`);
			return false;
		}

		if (imageBytes.length < 100) {
			console.warn(
				`[calibre-db] saveCoverFromBytes: image too small (${imageBytes.length} bytes), skipping`
			);
			return false;
		}

		const absDir = path.join(env.BOOKS_DIR, row.path);
		const coverPath = path.join(absDir, 'cover.jpg');

		await fs.writeFile(coverPath, imageBytes);

		if (_booksUid !== null && _booksGid !== null) {
			try {
				await fs.chown(coverPath, _booksUid, _booksGid);
			} catch {
				/* non-fatal */
			}
		}

		const now = new Date()
			.toISOString()
			.replace('T', ' ')
			.replace(/\.\d+Z$/, '+00:00');
		db.prepare('UPDATE books SET has_cover = 1, last_modified = ? WHERE id = ?').run(now, bookId);

		console.log(
			`[calibre-db] Saved uploaded cover for book id=${bookId} (${imageBytes.length} bytes)`
		);
		return true;
	} catch (err) {
		console.error(`[calibre-db] saveCoverFromBytes failed for book id=${bookId}:`, err);
		return false;
	}
}

/**
 * Download a cover image from a URL and save it as cover.jpg for a Calibre book.
 * Also sets has_cover = 1 in metadata.db.
 *
 * @param bookId  - Calibre book ID
 * @param coverUrl - Public URL of the cover image to download
 * @returns true on success, false on failure (never throws)
 */
export async function saveCoverFromUrl(bookId: number, coverUrl: string): Promise<boolean> {
	try {
		const db = await getDb();

		// Get the book's path from metadata.db
		const row = db.prepare('SELECT path FROM books WHERE id = ?').get(bookId) as
			| { path: string }
			| undefined;
		if (!row) {
			console.error(`[calibre-db] saveCoverFromUrl: book id=${bookId} not found`);
			return false;
		}

		const absDir = path.join(env.BOOKS_DIR, row.path);
		const coverPath = path.join(absDir, 'cover.jpg');

		// Download the image
		const imageBytes = await fetchUrl(coverUrl);
		if (imageBytes.length < 1000) {
			console.warn(
				`[calibre-db] saveCoverFromUrl: image too small (${imageBytes.length} bytes), skipping`
			);
			return false;
		}

		// Write cover.jpg
		await fs.writeFile(coverPath, imageBytes);

		// Chown to match BOOKS_DIR ownership
		if (_booksUid !== null && _booksGid !== null) {
			try {
				await fs.chown(coverPath, _booksUid, _booksGid);
			} catch {
				/* non-fatal */
			}
		}

		// Mark as having a cover and bump last_modified so Calibre-Web invalidates its cache
		const now = new Date()
			.toISOString()
			.replace('T', ' ')
			.replace(/\.\d+Z$/, '+00:00');
		db.prepare('UPDATE books SET has_cover = 1, last_modified = ? WHERE id = ?').run(now, bookId);

		console.log(
			`[calibre-db] Saved cover for book id=${bookId} (${imageBytes.length} bytes) → ${coverPath}`
		);
		return true;
	} catch (err) {
		console.error(`[calibre-db] saveCoverFromUrl failed for book id=${bookId}:`, err);
		return false;
	}
}

/**
 * Search Open Library for cover image URLs matching title + author.
 * Uses separate title/author fields for precision; falls back to title-only.
 * Returns an array of direct image URLs (does not download them).
 */
export async function searchOpenLibraryCovers(title: string, author: string): Promise<string[]> {
	return await searchOpenLibraryCoversForBook(title, author);
}

/**
 * Search Google Books for cover image URLs using the unauthenticated GData
 * Atom feed — no API key, no quota limits.
 *
 * Cover images are fetched as zoom=0 (full resolution) from the content CDN.
 */
export async function searchGoogleBooksCovers(title: string, author: string): Promise<string[]> {
	return await searchGoogleBooksCoversForBook(title, author);
}
