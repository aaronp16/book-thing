import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

const IGNORED_SHELF_NAMES = new Set(['.torrents']);
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

async function countBooksRecursively(dirPath: string): Promise<number> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		let count = 0;
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				count += await countBooksRecursively(fullPath);
				continue;
			}
			if (entry.isFile() && EBOOK_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				count += 1;
			}
		}
		return count;
	} catch {
		return 0;
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
