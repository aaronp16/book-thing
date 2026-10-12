import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

const IGNORED_SHELF_NAMES = new Set(['.torrents']);
const EBOOK_EXTENSIONS = new Set([
	'.epub',
	'.kepub',
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

export interface FilesystemShelf {
	id: string;
	name: string;
	path: string;
	bookCount?: number;
}

export function isValidShelfName(name: string): boolean {
	return Boolean(name) && !name.startsWith('.') && !name.includes('/') && !name.includes('\\');
}

export function getShelfPath(name: string): string {
	if (!isValidShelfName(name)) {
		throw new Error(`Invalid shelf name: ${name}`);
	}
	return path.join(env.BOOKS_DIR, name);
}

export async function ensureShelfDirectory(name: string): Promise<string> {
	const shelfPath = getShelfPath(name);
	await fs.mkdir(shelfPath, { recursive: true });
	return shelfPath;
}

export async function countShelfBooks(name: string): Promise<number> {
	const shelfPath = getShelfPath(name);
	return countBooksRecursively(shelfPath);
}

// Priority order for deduplication (lower index = higher priority).
// Must stay in sync with FORMAT_PRIORITY in fs-library.ts.
const FORMAT_PRIORITY: string[] = ['.epub', '.mobi', '.azw', '.azw3', '.fb2', '.kepub', '.pdf'];

async function countBooksRecursively(dirPath: string): Promise<number> {
	// Collect all ebook paths first, then deduplicate by stem within each directory.
	const allPaths = await collectEbookPathsForCount(dirPath);
	// Group by (dir, lowercase stem), keep highest-priority extension.
	const best = new Map<string, string>();
	for (const p of allPaths) {
		const dir = path.dirname(p);
		const ext = path.extname(p).toLowerCase();
		const stem = path.basename(p, ext).toLowerCase();
		const key = `${dir}\0${stem}`;
		const current = best.get(key);
		if (!current) {
			best.set(key, p);
		} else {
			const currentPriority = FORMAT_PRIORITY.indexOf(path.extname(current).toLowerCase());
			const newPriority = FORMAT_PRIORITY.indexOf(ext);
			const currentIdx = currentPriority === -1 ? FORMAT_PRIORITY.length : currentPriority;
			const newIdx = newPriority === -1 ? FORMAT_PRIORITY.length : newPriority;
			if (newIdx < currentIdx) best.set(key, p);
		}
	}
	return best.size;
}

async function collectEbookPathsForCount(dirPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				results.push(...(await collectEbookPathsForCount(fullPath)));
				continue;
			}
			if (entry.isFile() && EBOOK_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				results.push(fullPath);
			}
		}
		return results;
	} catch {
		return [];
	}
}

export async function listShelfDirectories(): Promise<FilesystemShelf[]> {
	try {
		const entries = await fs.readdir(env.BOOKS_DIR, { withFileTypes: true });
		const shelves = await Promise.all(
			entries
				.filter(
					(entry) =>
						entry.isDirectory() &&
						!entry.name.startsWith('.') &&
						!IGNORED_SHELF_NAMES.has(entry.name) &&
						isValidShelfName(entry.name)
				)
				.map(async (entry) => ({
					id: entry.name,
					name: entry.name,
					path: path.join(env.BOOKS_DIR, entry.name),
					bookCount: await countShelfBooks(entry.name)
				}))
		);
		return shelves.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}
