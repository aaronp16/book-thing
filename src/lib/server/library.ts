/**
 * Library scanner
 *
 * Scans the books directory for downloaded ebook files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

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
 * Ebook format priority for Kobo devices (lower index = higher priority).
 * When a torrent contains multiple formats, we pick the best one.
 */
const KOBO_FORMAT_PRIORITY = ['.epub', '.kepub', '.mobi', '.azw3', '.fb2', '.pdf'];

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
			if (KOBO_FORMAT_PRIORITY.includes(ext)) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

/**
 * From a list of absolute ebook paths, pick one per unique stem (basename without
 * extension) using Kobo format priority. This means for a series with one book per
 * subfolder we get one file per book, and if a folder has e.g. both .epub and .pdf
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
			const ai = KOBO_FORMAT_PRIORITY.indexOf(path.extname(a).toLowerCase());
			const bi = KOBO_FORMAT_PRIORITY.indexOf(path.extname(b).toLowerCase());
			return ai - bi;
		});
		chosen.push(candidates[0]);
	}
	return chosen;
}

/**
 * Copy a completed download to the books/Calibre library directory.
 *
 * Only called from the download completion handler — does NOT retroactively
 * copy existing torrents. Handles single files, flat directories, and nested
 * series folders. Picks the best ebook format per book when multiple formats exist.
 *
 * @param contentPath - The content_path from qBittorrent (internal container path)
 */
export async function copyBookToLibrary(contentPath: string): Promise<void> {
	const booksDir = env.BOOKS_DIR;

	if (!booksDir) {
		console.warn('[library] BOOKS_DIR not set, skipping copy');
		return;
	}

	const localPath = translateQBPath(contentPath);

	try {
		await fs.mkdir(booksDir, { recursive: true });

		const stat = await fs.stat(localPath);
		let srcFiles: string[];

		if (stat.isFile()) {
			// Single-file torrent
			const ext = path.extname(localPath).toLowerCase();
			if (!KOBO_FORMAT_PRIORITY.includes(ext)) {
				console.warn(`[library] Skipping non-ebook file: ${localPath}`);
				return;
			}
			srcFiles = [localPath];
		} else if (stat.isDirectory()) {
			// Walk the entire directory tree and collect all ebook files
			const allEbooks = await collectEbooks(localPath);
			if (allEbooks.length === 0) {
				console.warn(`[library] No recognised ebook files found in: ${localPath}`);
				return;
			}
			// Pick the best format per unique book title
			srcFiles = pickBestPerBook(allEbooks);
		} else {
			console.warn(`[library] Unexpected file type at: ${localPath}`);
			return;
		}

		let copied = 0;
		let skipped = 0;
		for (const srcFile of srcFiles) {
			const destFile = path.join(booksDir, path.basename(srcFile));
			try {
				await fs.access(destFile);
				console.log(`[library] Already exists, skipping: ${path.basename(destFile)}`);
				skipped++;
			} catch {
				// File doesn't exist — copy it
				await fs.copyFile(srcFile, destFile);
				console.log(`[library] Copied to library: ${path.basename(srcFile)}`);
				copied++;
			}
		}

		console.log(`[library] Done — ${copied} copied, ${skipped} skipped`);
	} catch (err) {
		console.error(`[library] Failed to copy book from ${localPath}:`, err);
	}
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
