/**
 * Library scanner
 *
 * Scans the books directory for downloaded ebook files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';
import { readBookMetadata } from './book-metadata.js';
import { encodeLibraryItemId } from './fs-library.js';
import { ensureShelfDirectory } from './fs-shelves.js';

/** Supported ebook file extensions */
const EBOOK_EXTENSIONS = new Set([
	'.epub',
	'.mobi',
	'.azw',
	'.azw3',
	'.pdf',
	'.cbz',
	'.cbr',
	'.djvu',
	'.fb2',
	'.lit',
	'.pdb',
	'.txt',
	'.rtf',
	'.doc',
	'.docx'
]);

/** A file in the library */
export interface LibraryFile {
	name: string;
	path: string;
	relativePath: string;
	extension: string;
	size: number;
	modifiedAt: string;
}

/** Library scan result */
export interface LibraryScanResult {
	files: LibraryFile[];
	totalSize: number;
	totalFiles: number;
}

/**
 * Check if a file is an ebook based on extension
 */
function isEbook(filename: string): boolean {
	const ext = path.extname(filename).toLowerCase();
	return EBOOK_EXTENSIONS.has(ext);
}

/**
 * Recursively scan a directory for ebook files
 */
async function scanDirectory(
	dirPath: string,
	basePath: string,
	files: LibraryFile[]
): Promise<void> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);

			// Skip hidden files and the .torrents directory
			if (entry.name.startsWith('.')) {
				continue;
			}

			if (entry.isDirectory()) {
				await scanDirectory(fullPath, basePath, files);
			} else if (entry.isFile() && isEbook(entry.name)) {
				try {
					const stats = await fs.stat(fullPath);
					const relativePath = path.relative(basePath, fullPath);

					files.push({
						name: entry.name,
						path: fullPath,
						relativePath,
						extension: path.extname(entry.name).toLowerCase().slice(1),
						size: stats.size,
						modifiedAt: stats.mtime.toISOString()
					});
				} catch {
					// Skip files we can't stat
				}
			}
		}
	} catch {
		// Directory doesn't exist or can't be read
	}
}

/**
 * Scan the library for all ebook files
 */
export async function scanLibrary(): Promise<LibraryScanResult> {
	const files: LibraryFile[] = [];

	await scanDirectory(env.BOOKS_DIR, env.BOOKS_DIR, files);

	// Sort by modification date, newest first
	files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

	const totalSize = files.reduce((sum, f) => sum + f.size, 0);

	return {
		files,
		totalSize,
		totalFiles: files.length
	};
}

/**
 * Format priority when a torrent contains multiple formats of the same book.
 * epub is preferred over kepub — kepub is Kobo's proprietary variant and
 * offers no benefit outside a Kobo device. Lower index = higher priority.
 */
const FORMAT_PRIORITY = ['.epub', '.mobi', '.azw3', '.fb2', '.kepub', '.pdf'];

/**
 * Translate a qBittorrent content_path to a path accessible inside our container.
 *
 * qBittorrent sees:  /data/torrents/books/SomeBook/SomeBook.epub
 * We mount that as:  /torrents/SomeBook/SomeBook.epub
 */
function translateQBPath(contentPath: string): string {
	return contentPath.replace(/^\/data\/torrents\/books/, '/torrents');
}

/**
 * Recursively collect all ebook file paths under a directory.
 */
async function collectEbooks(dirPath: string, results: string[] = []): Promise<string[]> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			await collectEbooks(fullPath, results);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).toLowerCase();
			if (FORMAT_PRIORITY.includes(ext)) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

/**
 * From a list of absolute ebook paths, pick one per unique stem (basename without
 * extension) using format priority. This means for a series with one book per
 * subfolder we get one file per book, and if a folder has e.g. both .epub and .kepub
 * of the same title we take only the .epub.
 */
function pickBestPerBook(files: string[]): string[] {
	// Group by lowercased stem so "Book One.epub" and "Book One.pdf" are the same key
	const byTitle = new Map<string, string[]>();
	for (const f of files) {
		const stem = path.basename(f, path.extname(f)).toLowerCase();
		if (!byTitle.has(stem)) byTitle.set(stem, []);
		byTitle.get(stem)!.push(f);
	}

	const chosen: string[] = [];
	for (const candidates of byTitle.values()) {
		// Sort candidates by format priority, pick the best one
		candidates.sort((a, b) => {
			const ai = FORMAT_PRIORITY.indexOf(path.extname(a).toLowerCase());
			const bi = FORMAT_PRIORITY.indexOf(path.extname(b).toLowerCase());
			return ai - bi;
		});
		chosen.push(candidates[0]);
	}
	return chosen;
}

/**
 * Copy a completed download into the filesystem-native library layout.
 *
 * Only called from the download completion handler — does NOT retroactively
 * copy existing torrents. Handles single files, flat directories, and nested
 * series folders. Picks the best ebook format per book when multiple formats exist.
 *
 * @param contentPath - The content_path from qBittorrent (internal container path)
 * @param shelfNames - Shelf names to copy books into after download completes
 */
export async function copyBookToLibrary(
	contentPath: string,
	shelfNames?: string[]
): Promise<string[]> {
	const booksDir = env.BOOKS_DIR;
	const libraryItemIds: string[] = [];

	console.log(`[library] copyBookToLibrary called with: ${contentPath}`);

	if (!booksDir) {
		console.warn('[library] BOOKS_DIR not set, skipping copy');
		return libraryItemIds;
	}

	if (!shelfNames || shelfNames.length === 0) {
		console.warn('[library] No shelf names provided, skipping copy');
		return libraryItemIds;
	}

	const localPath = translateQBPath(contentPath);
	console.log(`[library] Translated path: ${contentPath} → ${localPath}`);

	try {
		await fs.mkdir(booksDir, { recursive: true });

		let stat;
		try {
			stat = await fs.stat(localPath);
		} catch (err) {
			console.error(
				`[library] Cannot stat translated path "${localPath}" — does the /torrents volume mount exist and is the path correct? Error: ${err}`
			);
			return libraryItemIds;
		}

		let srcFiles: string[];

		if (stat.isFile()) {
			const ext = path.extname(localPath).toLowerCase();
			console.log(`[library] Single file detected, extension: ${ext}`);
			if (!FORMAT_PRIORITY.includes(ext)) {
				console.warn(`[library] Skipping non-ebook file: ${localPath}`);
				return libraryItemIds;
			}
			srcFiles = [localPath];
		} else if (stat.isDirectory()) {
			console.log(`[library] Directory detected, scanning recursively: ${localPath}`);
			const allEbooks = await collectEbooks(localPath);
			console.log(`[library] Found ${allEbooks.length} ebook file(s):`, allEbooks);
			if (allEbooks.length === 0) {
				console.warn(`[library] No recognised ebook files found in: ${localPath}`);
				return libraryItemIds;
			}
			srcFiles = pickBestPerBook(allEbooks);
			console.log(
				`[library] Selected ${srcFiles.length} file(s) after format dedup:`,
				srcFiles.map((f) => path.basename(f))
			);
		} else {
			console.warn(`[library] Unexpected file type at: ${localPath}`);
			return libraryItemIds;
		}

		let copied = 0;
		let skipped = 0;
		for (const srcFile of srcFiles) {
			const metadata = await readBookMetadata(srcFile);
			const authorDirName = sanitizePathSegment(metadata.author || 'Unknown');
			for (const shelfName of shelfNames) {
				const safeShelfName = sanitizePathSegment(shelfName);
				const shelfDir = await ensureShelfDirectory(safeShelfName);
				const destDir = path.join(shelfDir, authorDirName);
				const destFile = path.join(destDir, path.basename(srcFile));
				await fs.mkdir(destDir, { recursive: true });

				try {
					await fs.access(destFile);
					console.log(`[library] Already exists, skipping: ${destFile}`);
					skipped++;
				} catch {
					await fs.copyFile(srcFile, destFile);
					console.log(`[library] Copied to shelf: ${srcFile} → ${destFile}`);
					copied++;
				}

				const relativePath = path.relative(booksDir, destFile);
				libraryItemIds.push(encodeLibraryItemId(relativePath));
			}
		}

		console.log(
			`[library] Done — ${copied} copied, ${skipped} skipped, ${libraryItemIds.length} library items`
		);
	} catch (err) {
		console.error(`[library] Failed to copy book from ${localPath}:`, err);
	}

	return Array.from(new Set(libraryItemIds));
}

function sanitizePathSegment(value: string): string {
	return (
		value
			.replace(/[\\/:*?"<>|]/g, '_')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120) || 'Unknown'
	);
}

/**
 * Get disk usage stats for the books directory
 */
export async function getDiskStats(): Promise<{
	used: number;
	files: number;
}> {
	const result = await scanLibrary();
	return {
		used: result.totalSize,
		files: result.totalFiles
	};
}

/**
 * Format bytes for display
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
