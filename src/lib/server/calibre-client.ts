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
import { randomUUID } from 'crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { env } from './env.js';

// node:sqlite is experimental in Node 22 — lazy-init so the warning fires once at startup
let _db: any = null;

function getDb() {
	if (_db) return _db;
	const dbPath = path.join(env.BOOKS_DIR, 'metadata.db');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { DatabaseSync } = require('node:sqlite');
	_db = new DatabaseSync(dbPath);
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
		console.warn(`[calibre-db] Could not read EPUB metadata from "${filename}": ${err} — falling back to filename`);
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
 *
 * MOBI is a PalmDB file. The header layout:
 *   0x00–0x1F  PalmDB name (null-padded, often the title)
 *   0x4C       number of records (2 bytes big-endian)
 *   0x4E+      record list: each entry is 8 bytes (4 offset + 1 attr + 3 uniqueID)
 *
 * Record 0 is the MobiHeader. Within it, after the PalmDOC header (32 bytes):
 *   +0x00  "MOBI" magic
 *   +0x04  header length
 *   +0x14  title offset (relative to start of record 0)
 *   +0x18  title length
 *
 * After the MOBI header comes the EXTH block (if present):
 *   MOBI header offset + MOBI header length
 *   "EXTH" magic, 4-byte total length, 4-byte record count
 *   Each record: 4-byte type, 4-byte length (including type+length), data
 *     type 100 = author, type 503 = updated title
 *
 * We read only the first ~16 KB to keep it fast.
 */
async function readMobiMeta(filePath: string): Promise<{ title: string; author: string }> {
	const filename = path.basename(filePath);
	try {
		// Read enough to cover the PalmDB header, record list, and record 0 content
		const fh = await fs.open(filePath, 'r');
		const headerBuf = Buffer.alloc(16384);
		const { bytesRead } = await fh.read(headerBuf, 0, 16384, 0);
		await fh.close();
		const buf = headerBuf.subarray(0, bytesRead);

		if (buf.length < 78) throw new Error('File too small');

		// PalmDB: number of records at 0x4C
		const numRecords = buf.readUInt16BE(0x4c);
		if (numRecords < 1) throw new Error('No PalmDB records');

		// Record 0 offset is at 0x4E (first record list entry, first 4 bytes)
		const rec0Offset = buf.readUInt32BE(0x4e);
		if (rec0Offset + 32 > buf.length) throw new Error('Record 0 out of range');

		// PalmDOC header is 32 bytes, then MOBI header starts
		const mobiStart = rec0Offset + 32;
		if (mobiStart + 4 > buf.length) throw new Error('MOBI header out of range');

		const mobiMagic = buf.subarray(mobiStart, mobiStart + 4).toString('ascii');
		if (mobiMagic !== 'MOBI') throw new Error(`Expected MOBI magic, got "${mobiMagic}"`);

		const mobiHeaderLen = buf.readUInt32BE(mobiStart + 4);

		// Title is embedded in record 0 at a given offset + length
		const titleOffset = buf.readUInt32BE(mobiStart + 0x14);
		const titleLength = buf.readUInt32BE(mobiStart + 0x18);
		const titleStart = rec0Offset + titleOffset;
		let title: string | null = null;
		if (titleLength > 0 && titleStart + titleLength <= buf.length) {
			title = buf.subarray(titleStart, titleStart + titleLength).toString('utf8').trim();
		}

		// EXTH block starts immediately after the MOBI header
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
					const data = buf.subarray(pos + 8, pos + recLen).toString('utf8').trim();
					if (recType === 100) author = data;        // dc:creator
					if (recType === 503) exthTitle = data;     // updated title
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
		console.warn(`[calibre-db] Could not read MOBI metadata from "${filename}": ${err} — falling back to filename`);
		return parseFilename(filename);
	}
}

/**
 * Read title and author from a PDF's Info dictionary.
 *
 * PDFs store document metadata in a trailer dictionary that references an Info
 * object. We search the file for the Info object directly using a regex scan,
 * which avoids implementing a full PDF parser while working on the vast majority
 * of real-world PDFs.
 *
 * We read the last 64 KB (where the trailer and xref live) plus the first 64 KB
 * (where early objects often live), then scan for /Title and /Author entries.
 */
async function readPdfMeta(filePath: string): Promise<{ title: string; author: string }> {
	const filename = path.basename(filePath);
	try {
		const stat = await fs.stat(filePath);
		const fh = await fs.open(filePath, 'r');

		// Read first 64 KB + last 64 KB
		const chunkSize = 65536;
		const buf1 = Buffer.alloc(Math.min(chunkSize, stat.size));
		await fh.read(buf1, 0, buf1.length, 0);
		const tailOffset = Math.max(0, stat.size - chunkSize);
		const buf2 = Buffer.alloc(Math.min(chunkSize, stat.size - tailOffset));
		await fh.read(buf2, 0, buf2.length, tailOffset);
		await fh.close();

		const text = buf1.toString('latin1') + buf2.toString('latin1');

		/**
		 * PDF string values come in two forms:
		 *   (literal string)         — may use \n, \r, \ooo octal escapes
		 *   <hex bytes>              — UTF-16BE if starts with FEFF
		 */
		function decodePdfString(raw: string): string {
			if (raw.startsWith('<')) {
				// Hex string
				const hex = raw.slice(1, -1).replace(/\s/g, '');
				const bytes = Buffer.from(hex, 'hex');
				// UTF-16BE BOM?
				if (bytes[0] === 0xfe && bytes[1] === 0xff) {
					return bytes.subarray(2).toString('utf16le');
				}
				return bytes.toString('latin1');
			}
			// Literal string — strip outer parens, handle basic escapes
			return raw
				.slice(1, -1)
				.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
				.replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
				.replace(/\\(.)/g, '$1');
		}

		function extractField(field: string): string | null {
			// Match /Field (value) or /Field <hexvalue>
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
		console.warn(`[calibre-db] Could not read PDF metadata from "${filename}": ${err} — falling back to filename`);
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
 *  1. Parse title/author from filename
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
		const { title, author } = ext === 'epub'
			? await readEpubMeta(flatFilePath)
			: ext === 'mobi' || ext === 'azw3' || ext === 'azw'
				? await readMobiMeta(flatFilePath)
				: ext === 'pdf'
					? await readPdfMeta(flatFilePath)
					: parseFilename(filename);

		console.log(`[calibre-db] Adding "${title}" by "${author}" (${ext})`);

		const db = getDb();
		const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00');
		const uuid = randomUUID();

		// Insert or reuse author
		const existingAuthor = db.prepare('SELECT id FROM authors WHERE name = ?').get(author);
		let authorId: number;
		if (existingAuthor) {
			authorId = existingAuthor.id;
			console.log(`[calibre-db] Reusing author id=${authorId}`);
		} else {
			const r = db.prepare('INSERT INTO authors (name, sort, link) VALUES (?, ?, ?)').run(author, authorSort(author), '');
			authorId = Number(r.lastInsertRowid);
			console.log(`[calibre-db] Inserted author id=${authorId}`);
		}

		// Insert book with empty path first (we need the id to build the path)
		const bookId = Number(
			db.prepare(`
				INSERT INTO books (title, sort, timestamp, pubdate, series_index, author_sort, uuid, path, has_cover, last_modified)
				VALUES (?, ?, ?, ?, 1.0, ?, ?, '', 0, ?)
			`).run(title, titleSort(title), now, now, authorSort(author), uuid, now).lastInsertRowid
		);
		console.log(`[calibre-db] Inserted book id=${bookId}`);

		// Link book ↔ author
		db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)').run(bookId, authorId);

		// Build Calibre path: "Author Name/Title (book_id)"
		const relPath = `${sanitize(author)}/${sanitize(title)} (${bookId})`;
		const absDir = path.join(env.BOOKS_DIR, relPath);
		await fs.mkdir(absDir, { recursive: true });

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

		console.log(`[calibre-db] Done — book id=${bookId} registered in Calibre library`);
		return bookId;
	} catch (err) {
		console.error(`[calibre-db] Failed to add "${flatFilePath}" to Calibre:`, err);
		return null;
	}
}
