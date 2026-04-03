import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';
import { extractEmbeddedCoverBytes, findSidecarCover } from './book-covers.js';
import { readBookMetadata } from './book-metadata.js';
import { ensureShelfDirectory, getShelfPath, listShelfDirectories } from './fs-shelves.js';

export const FILESYSTEM_EBOOK_EXTENSIONS = new Set([
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

export interface FilesystemLibraryItem {
	id: string;
	bookKey: string;
	name: string;
	path: string;
	relativePath: string;
	shelf: string;
	extension: string;
	size: number;
	modifiedAt: string;
	title: string;
	author: string;
	hasCover: boolean;
}

interface CachedFilesystemLibraryItem {
	cacheKey: string;
	item: FilesystemLibraryItem;
}

const libraryItemCache = new Map<string, CachedFilesystemLibraryItem>();

function isSupportedBookFile(filename: string): boolean {
	return FILESYSTEM_EBOOK_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function encodeLibraryItemId(relativePath: string): string {
	return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function validateRelativeLibraryPath(relativePath: string): string {
	if (!relativePath || path.isAbsolute(relativePath)) {
		throw new Error('Invalid library path');
	}
	const normalized = path.normalize(relativePath);
	if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
		throw new Error('Path traversal is not allowed');
	}
	const parts = normalized.split(path.sep);
	if (parts.length < 2) {
		throw new Error('Library paths must include at least shelf/file');
	}
	return normalized;
}

export function decodeLibraryItemId(id: string): string {
	const relativePath = Buffer.from(id, 'base64url').toString('utf8');
	return validateRelativeLibraryPath(relativePath);
}

export function resolveLibraryItemAbsolutePath(relativePath: string): string {
	const safeRelativePath = validateRelativeLibraryPath(relativePath);
	const absolutePath = path.resolve(env.BOOKS_DIR, safeRelativePath);
	const booksRoot = path.resolve(env.BOOKS_DIR);
	if (!absolutePath.startsWith(`${booksRoot}${path.sep}`) && absolutePath !== booksRoot) {
		throw new Error('Resolved path escapes library root');
	}
	return absolutePath;
}

export function getLibraryItemSubpath(relativePath: string): string {
	const safeRelativePath = validateRelativeLibraryPath(relativePath);
	const parts = safeRelativePath.split(path.sep);
	return parts.slice(1).join(path.sep);
}

export function encodeBookKey(relativePath: string): string {
	const subpath = getLibraryItemSubpath(relativePath);
	return Buffer.from(subpath, 'utf8').toString('base64url');
}

export function decodeBookKey(bookKey: string): string {
	const subpath = Buffer.from(bookKey, 'base64url').toString('utf8');
	if (!subpath || path.isAbsolute(subpath)) {
		throw new Error('Invalid book key');
	}
	const normalized = path.normalize(subpath);
	if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
		throw new Error('Path traversal is not allowed');
	}
	return normalized;
}

export function buildLibraryRelativePathForShelf(
	sourceRelativePath: string,
	shelfName: string
): string {
	const subpath = getLibraryItemSubpath(sourceRelativePath);
	return path.join(shelfName, subpath);
}

async function readLibraryItemFromFile(
	shelf: string,
	absolutePath: string
): Promise<FilesystemLibraryItem> {
	const stat = await fs.stat(absolutePath);
	const relativePath = path.relative(env.BOOKS_DIR, absolutePath);
	const cacheKey = `${stat.mtimeMs}:${stat.size}`;
	const cached = libraryItemCache.get(relativePath);
	if (cached?.cacheKey === cacheKey) {
		return cached.item;
	}

	const metadata = await readBookMetadata(absolutePath);
	const sidecarCover = await findSidecarCover(absolutePath);
	const embeddedCover = sidecarCover ? null : await extractEmbeddedCoverBytes(absolutePath);
	const hasCover = sidecarCover !== null || embeddedCover !== null;
	const item = {
		id: encodeLibraryItemId(relativePath),
		bookKey: encodeBookKey(relativePath),
		name: path.basename(absolutePath),
		path: absolutePath,
		relativePath,
		shelf,
		extension: path.extname(absolutePath).toLowerCase().slice(1),
		size: stat.size,
		modifiedAt: stat.mtime.toISOString(),
		title: metadata.title,
		author: metadata.author,
		hasCover
	};

	libraryItemCache.set(relativePath, { cacheKey, item });
	return item;
}

async function collectShelfBookPaths(dirPath: string, results: string[] = []): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			await collectShelfBookPaths(fullPath, results);
			continue;
		}
		if (entry.isFile() && isSupportedBookFile(entry.name)) {
			results.push(fullPath);
		}
	}

	return results;
}

export async function scanFilesystemLibrary(shelfName?: string): Promise<FilesystemLibraryItem[]> {
	const shelves = shelfName
		? [{ name: shelfName, path: getShelfPath(shelfName) }]
		: await listShelfDirectories();

	const items: FilesystemLibraryItem[] = [];
	for (const shelf of shelves) {
		const bookPaths = await collectShelfBookPaths(shelf.path);
		for (const fullPath of bookPaths) {
			try {
				items.push(await readLibraryItemFromFile(shelf.name, fullPath));
			} catch {
				// Skip malformed or unreadable entries; callers can still render the rest.
			}
		}
	}

	items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	return items;
}

export async function getFilesystemLibraryItemsForBookKey(
	bookKey: string
): Promise<FilesystemLibraryItem[]> {
	const subpath = decodeBookKey(bookKey);
	const shelves = await listShelfDirectories();
	const items: FilesystemLibraryItem[] = [];

	for (const shelf of shelves) {
		const absolutePath = resolveLibraryItemAbsolutePath(path.join(shelf.name, subpath));
		try {
			const stat = await fs.stat(absolutePath);
			if (!stat.isFile()) continue;
			items.push(await readLibraryItemFromFile(shelf.name, absolutePath));
		} catch {
			// Missing copy in this shelf is expected.
		}
	}

	items.sort((a, b) => a.shelf.localeCompare(b.shelf));
	return items;
}

export async function deleteFilesystemLibraryItem(id: string): Promise<void> {
	const relativePath = decodeLibraryItemId(id);
	const absolutePath = resolveLibraryItemAbsolutePath(relativePath);
	const stem = path.basename(absolutePath, path.extname(absolutePath));
	const dir = path.dirname(absolutePath);

	await fs.unlink(absolutePath);
	await fs.rm(path.join(dir, `${stem}.cover.jpg`), { force: true });
	await fs.rm(path.join(dir, `${stem}.json`), { force: true });
	libraryItemCache.delete(relativePath);
}

export async function copyFilesystemLibraryItemToShelf(
	id: string,
	targetShelfName: string
): Promise<string> {
	const relativePath = decodeLibraryItemId(id);
	const sourcePath = resolveLibraryItemAbsolutePath(relativePath);
	const targetRelativePath = buildLibraryRelativePathForShelf(relativePath, targetShelfName);
	const targetPath = resolveLibraryItemAbsolutePath(targetRelativePath);
	await ensureShelfDirectory(targetShelfName);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });

	try {
		await fs.access(targetPath);
	} catch {
		await fs.copyFile(sourcePath, targetPath);
	}

	const sourceSidecar = await findSidecarCover(sourcePath);
	if (sourceSidecar) {
		const stem = path.basename(targetPath, path.extname(targetPath));
		const targetCoverPath = path.join(path.dirname(targetPath), `${stem}.cover.jpg`);
		try {
			await fs.access(targetCoverPath);
		} catch {
			await fs.copyFile(sourceSidecar, targetCoverPath);
		}
	}

	libraryItemCache.delete(targetRelativePath);
	return encodeLibraryItemId(targetRelativePath);
}
