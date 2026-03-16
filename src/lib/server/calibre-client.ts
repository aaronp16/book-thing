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
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { env } from './env.js';

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

/**
 * Read title and author from an EPUB's OPF metadata.
 * Falls back to filename parsing if the EPUB can't be read or is missing metadata.
 */
async function readEpubMeta(filePath: string): Promise<{ title: string; author: string }> {
	const filename = path.basename(filePath);
	try {
		const buf = await fs.readFile(filePath);
		const zip = unzipSync(new Uint8Array(buf));

		// Step 1: parse META-INF/container.xml to find the OPF path
		const containerXml = zip['META-INF/container.xml'];
		if (!containerXml) throw new Error('No META-INF/container.xml');
		const containerStr = strFromU8(containerXml);
		const opfMatch = containerStr.match(/full-path="([^"]+\.opf)"/i);
		if (!opfMatch) throw new Error('No OPF path in container.xml');
		const opfPath = opfMatch[1];

		// Step 2: parse the OPF file for dc:title and dc:creator
		const opfData = zip[opfPath];
		if (!opfData) throw new Error(`OPF file not found in zip: ${opfPath}`);
		const opf = strFromU8(opfData);

		const titleMatch = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
		const authorMatch = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);

		const title = titleMatch?.[1]?.trim() || null;
		const author = authorMatch?.[1]?.trim() || null;

		if (title && author) {
			console.log(`[calibre-db] EPUB metadata: title="${title}" author="${author}"`);
			return { title, author };
		}
		if (title) {
			console.log(`[calibre-db] EPUB metadata: title="${title}", no author — falling back`);
			return { title, author: parseFilenameAuthor(filename) };
		}
		throw new Error('Missing dc:title in OPF');
	} catch (err) {
		console.warn(
			`[calibre-db] Could not read EPUB metadata from "${filename}": ${err} — falling back to filename`
		);
		return parseFilename(filename);
	}
}

/**
 * Parse title and author from a filename as a last resort.
 * Handles common patterns like "Title - Author.epub", "Author - Title.epub", etc.
 */
function parseFilename(filename: string): { title: string; author: string } {
	const stem = path.basename(filename, path.extname(filename));
	// Strip trailing format tags like "(EPUB)", "(Kindle)", etc.
	const cleaned = stem.replace(/\s*\([A-Za-z0-9]+\)\s*$/, '').trim();
	const dashMatch = cleaned.match(/^(.+?)\s+-\s+(.+)$/);
	if (dashMatch) {
		return { title: dashMatch[1].trim(), author: dashMatch[2].trim() };
	}
	return { title: cleaned, author: 'Unknown' };
}

/** Extract just the author from a filename, used when OPF has a title but no author. */
function parseFilenameAuthor(filename: string): string {
	return parseFilename(filename).author;
}

/**
 * Read title and author from a MOBI or AZW3 file.
 */
async function readMobiMeta(filePath: string): Promise<{ title: string; author: string }> {
	const filename = path.basename(filePath);
	try {
		const fh = await fs.open(filePath, 'r');
		const headerBuf = Buffer.alloc(16384);
		const { bytesRead } = await fh.read(headerBuf, 0, 16384, 0);
		await fh.close();
		const buf = headerBuf.subarray(0, bytesRead);

		if (buf.length < 78) throw new Error('File too small');

		const numRecords = buf.readUInt16BE(0x4c);
		if (numRecords < 1) throw new Error('No PalmDB records');

		const rec0Offset = buf.readUInt32BE(0x4e);
		if (rec0Offset + 32 > buf.length) throw new Error('Record 0 out of range');

		const mobiStart = rec0Offset + 32;
		if (mobiStart + 4 > buf.length) throw new Error('MOBI header out of range');

		const mobiMagic = buf.subarray(mobiStart, mobiStart + 4).toString('ascii');
		if (mobiMagic !== 'MOBI') throw new Error(`Expected MOBI magic, got "${mobiMagic}"`);

		const mobiHeaderLen = buf.readUInt32BE(mobiStart + 4);

		const titleOffset = buf.readUInt32BE(mobiStart + 0x14);
		const titleLength = buf.readUInt32BE(mobiStart + 0x18);
		const titleStart = rec0Offset + titleOffset;
		let title: string | null = null;
		if (titleLength > 0 && titleStart + titleLength <= buf.length) {
			title = buf
				.subarray(titleStart, titleStart + titleLength)
				.toString('utf8')
				.trim();
		}

		const exthStart = mobiStart + mobiHeaderLen;
		let author: string | null = null;
		let exthTitle: string | null = null;

		if (exthStart + 12 <= buf.length) {
			const exthMagic = buf.subarray(exthStart, exthStart + 4).toString('ascii');
			if (exthMagic === 'EXTH') {
				const exthRecordCount = buf.readUInt32BE(exthStart + 8);
				let pos = exthStart + 12;
				for (let i = 0; i < exthRecordCount && pos + 8 <= buf.length; i++) {
					const recType = buf.readUInt32BE(pos);
					const recLen = buf.readUInt32BE(pos + 4);
					if (recLen < 8) break;
					const data = buf
						.subarray(pos + 8, pos + recLen)
						.toString('utf8')
						.trim();
					if (recType === 100) author = data;
					if (recType === 503) exthTitle = data;
					pos += recLen;
				}
			}
		}

		const finalTitle = (exthTitle || title || '').trim() || null;
		const finalAuthor = (author || '').trim() || null;

		if (finalTitle && finalAuthor) {
			console.log(`[calibre-db] MOBI metadata: title="${finalTitle}" author="${finalAuthor}"`);
			return { title: finalTitle, author: finalAuthor };
		}
		if (finalTitle) {
			return { title: finalTitle, author: parseFilenameAuthor(filename) };
		}
		throw new Error('No title found in MOBI headers');
	} catch (err) {
		console.warn(
			`[calibre-db] Could not read MOBI metadata from "${filename}": ${err} — falling back to filename`
		);
		return parseFilename(filename);
	}
}

/**
 * Read title and author from a PDF's Info dictionary.
 */
async function readPdfMeta(filePath: string): Promise<{ title: string; author: string }> {
	const filename = path.basename(filePath);
	try {
		const stat = await fs.stat(filePath);
		const fh = await fs.open(filePath, 'r');

		const chunkSize = 65536;
		const buf1 = Buffer.alloc(Math.min(chunkSize, stat.size));
		await fh.read(buf1, 0, buf1.length, 0);
		const tailOffset = Math.max(0, stat.size - chunkSize);
		const buf2 = Buffer.alloc(Math.min(chunkSize, stat.size - tailOffset));
		await fh.read(buf2, 0, buf2.length, tailOffset);
		await fh.close();

		const text = buf1.toString('latin1') + buf2.toString('latin1');

		function decodePdfString(raw: string): string {
			if (raw.startsWith('<')) {
				const hex = raw.slice(1, -1).replace(/\s/g, '');
				const bytes = Buffer.from(hex, 'hex');
				if (bytes[0] === 0xfe && bytes[1] === 0xff) {
					return bytes.subarray(2).toString('utf16le');
				}
				return bytes.toString('latin1');
			}
			return raw
				.slice(1, -1)
				.replace(/\\n/g, '\n')
				.replace(/\\r/g, '\r')
				.replace(/\\t/g, '\t')
				.replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
				.replace(/\\(.)/g, '$1');
		}

		function extractField(field: string): string | null {
			const re = new RegExp(`/${field}\\s*(\\([^)]*\\)|<[^>]*>)`, 'i');
			const m = text.match(re);
			if (!m) return null;
			return decodePdfString(m[1]).trim() || null;
		}

		const title = extractField('Title');
		const author = extractField('Author');

		if (title && author) {
			console.log(`[calibre-db] PDF metadata: title="${title}" author="${author}"`);
			return { title, author };
		}
		if (title) {
			return { title, author: parseFilenameAuthor(filename) };
		}
		throw new Error('No /Title in PDF Info dictionary');
	} catch (err) {
		console.warn(
			`[calibre-db] Could not read PDF metadata from "${filename}": ${err} — falling back to filename`
		);
		return parseFilename(filename);
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
		const meta =
			ext === 'epub'
				? await readEpubMeta(flatFilePath)
				: ext === 'mobi' || ext === 'azw3' || ext === 'azw'
					? await readMobiMeta(flatFilePath)
					: ext === 'pdf'
						? await readPdfMeta(flatFilePath)
						: parseFilename(filename);

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
				const coverBytes = await extractCoverBytesFromEpub(destFile);
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

/**
 * Fetch a URL and return the response body as a Buffer.
 * Follows a single redirect.
 */
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
			res.on('data', (c: Buffer) => chunks.push(c));
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
 * Extract the cover image bytes directly from an EPUB file on disk.
 * Returns a Buffer (JPEG or PNG), or null if no cover is found.
 */
async function extractCoverBytesFromEpub(epubPath: string): Promise<Buffer | null> {
	try {
		const buf = await fs.readFile(epubPath);
		const zip = unzipSync(new Uint8Array(buf));

		// Parse OPF path from META-INF/container.xml
		const containerXml = zip['META-INF/container.xml'];
		if (!containerXml) return null;
		const containerStr = strFromU8(containerXml);
		const opfMatch = containerStr.match(/full-path="([^"]+\.opf)"/i);
		if (!opfMatch) return null;
		const opfPath = opfMatch[1];

		const opfData = zip[opfPath];
		if (!opfData) return null;
		const opf = strFromU8(opfData);
		const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

		// Collect all image manifest items
		const itemById = new Map<string, { href: string; mediaType: string }>();
		for (const m of opf.matchAll(/<item\b([^>]+?)\/>/gi)) {
			const attrs = m[1];
			const idM = attrs.match(/\bid=["']([^"']+)["']/i);
			const hrefM = attrs.match(/\bhref=["']([^"']+)["']/i);
			const mtM = attrs.match(/\bmedia-type=["']([^"']+)["']/i);
			if (idM && hrefM && mtM?.[1]?.startsWith('image/')) {
				itemById.set(idM[1], { href: hrefM[1], mediaType: mtM[1] });
			}
		}

		function getImageData(href: string): Uint8Array | null {
			return zip[opfDir + href] ?? zip[href] ?? null;
		}

		let imageData: Uint8Array | null = null;

		// Method 1: <meta name="cover" content="id">
		const metaCoverM =
			opf.match(/<meta\b[^>]+\bname=["']cover["'][^>]+\bcontent=["']([^"']+)["']/i) ??
			opf.match(/<meta\b[^>]+\bcontent=["']([^"']+)["'][^>]+\bname=["']cover["']/i);
		if (metaCoverM) {
			const item = itemById.get(metaCoverM[1]);
			if (item) imageData = getImageData(item.href);
		}

		// Method 2: <item properties="cover-image">
		if (!imageData) {
			const propM = opf.match(/<item\b[^>]+\bproperties=["'][^"']*cover-image[^"']*["'][^>]+?\/>/i);
			if (propM) {
				const hrefM = propM[0].match(/\bhref=["']([^"']+)["']/i);
				if (hrefM) imageData = getImageData(hrefM[1]);
			}
		}

		// Method 3: item with id="cover"
		if (!imageData) {
			const item = itemById.get('cover');
			if (item) imageData = getImageData(item.href);
		}

		if (!imageData || imageData.length < 100) return null;
		return Buffer.from(imageData);
	} catch {
		return null;
	}
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
		const imageBytes = await extractCoverBytesFromEpub(epubPath);
		if (!imageBytes) return null;

		return `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
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
	async function query(params: URLSearchParams): Promise<string[]> {
		params.set('limit', '10');
		params.set('fields', 'cover_i,cover_edition_key');
		const buf = await fetchUrl(`https://openlibrary.org/search.json?${params}`);
		const results = JSON.parse(buf.toString('utf8'));
		const urls: string[] = [];
		for (const doc of results?.docs ?? []) {
			if (doc.cover_i) {
				urls.push(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`);
			} else if (doc.cover_edition_key) {
				urls.push(`https://covers.openlibrary.org/b/olid/${doc.cover_edition_key}-L.jpg`);
			}
		}
		return urls;
	}

	try {
		// First try: precise title + author fields
		if (author) {
			const p = new URLSearchParams({ title, author });
			const urls = await query(p);
			if (urls.length > 0) return urls;
		}
		// Fallback: title only
		const urls = await query(new URLSearchParams({ title }));
		return urls;
	} catch (err) {
		console.warn(`[calibre-db] Open Library cover search failed: ${err}`);
		return [];
	}
}

/**
 * Search Google Books for cover image URLs using the unauthenticated GData
 * Atom feed — no API key, no quota limits.
 *
 * Cover images are fetched as zoom=0 (full resolution) from the content CDN.
 */
export async function searchGoogleBooksCovers(title: string, author: string): Promise<string[]> {
	try {
		const q = author ? `${title} ${author}` : title;
		const params = new URLSearchParams({ q, 'max-results': '10' });
		const buf = await fetchUrl(`https://www.googleapis.com/books/feeds/volumes?${params}`);
		const xml = buf.toString('utf8');

		// Extract volume IDs from <id>…/volumes/VOLUME_ID</id> entries
		const idMatches = xml.matchAll(
			/<id>https?:\/\/www\.google\.com\/books\/feeds\/volumes\/([^<]+)<\/id>/g
		);
		const urls: string[] = [];
		for (const m of idMatches) {
			const volumeId = m[1];
			// zoom=0 gives the largest available cover image
			urls.push(
				`https://books.google.com/books/content?id=${volumeId}&printsec=frontcover&img=1&zoom=0&source=gbs_gdata`
			);
		}
		return urls;
	} catch (err) {
		console.warn(`[calibre-db] Google Books cover search failed: ${err}`);
		return [];
	}
}
