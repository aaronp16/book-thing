import * as path from 'path';
import * as fs from 'fs/promises';
import {
	FILESYSTEM_EBOOK_EXTENSIONS,
	type FilesystemLibraryItem,
	decodeLibraryItemId,
	resolveLibraryItemAbsolutePath,
	scanFilesystemLibrary
} from './fs-library.js';
import { getShelfPath, isValidShelfName, listShelfDirectories } from './fs-shelves.js';

const KOBO_FORMAT_PRIORITY = ['epub', 'kepub', 'kepub.epub', 'pdf', 'cbz', 'cbr', 'txt'];
const KOBO_FORMAT_PRIORITY_MAP = new Map(
	KOBO_FORMAT_PRIORITY.map((format, index) => [format, index])
);

export interface KoboShelf {
	name: string;
	encodedName: string;
	path: string;
}

export interface KoboLibraryBook extends FilesystemLibraryItem {
	koboFormat: string;
}

function getFormatPriority(extension: string): number {
	return KOBO_FORMAT_PRIORITY_MAP.get(extension.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

export function encodeKoboShelfName(shelfName: string): string {
	return shelfName.trim().toLowerCase();
}

export function decodeKoboShelfName(encodedShelfName: string): string {
	const shelfName = decodeURIComponent(encodedShelfName);
	if (!isValidShelfName(shelfName) || shelfName.includes('/')) {
		throw new Error('Invalid Kobo shelf name');
	}
	return shelfName;
}

export async function resolveKoboShelf(encodedShelfName: string): Promise<KoboShelf> {
	const requestedShelfName = decodeKoboShelfName(encodedShelfName);
	const shelves = await listShelfDirectories();
	const matchedShelf = shelves.find(
		(shelf) => shelf.name.toLowerCase() === requestedShelfName.trim().toLowerCase()
	);
	const shelfName = matchedShelf?.name ?? requestedShelfName;
	return {
		name: shelfName,
		encodedName: encodeKoboShelfName(shelfName),
		path: getShelfPath(shelfName)
	};
}

export async function assertKoboShelfExists(encodedShelfName: string): Promise<KoboShelf> {
	const shelf = await resolveKoboShelf(encodedShelfName);
	try {
		const stat = await fs.stat(shelf.path);
		if (!stat.isDirectory()) {
			throw new Error('Shelf path is not a directory');
		}
		return shelf;
	} catch {
		throw new Error(`Kobo shelf not found: ${shelf.name}`);
	}
}

function isKoboUsableBook(book: FilesystemLibraryItem): boolean {
	return FILESYSTEM_EBOOK_EXTENSIONS.has(`.${book.extension.toLowerCase()}`);
}

function choosePreferredKoboBook(
	current: KoboLibraryBook | undefined,
	candidate: FilesystemLibraryItem
): KoboLibraryBook {
	const koboCandidate: KoboLibraryBook = {
		...candidate,
		koboFormat: candidate.extension.toUpperCase()
	};
	if (!current) return koboCandidate;

	const currentPriority = getFormatPriority(current.extension);
	const candidatePriority = getFormatPriority(candidate.extension);
	if (candidatePriority < currentPriority) return koboCandidate;
	if (candidatePriority > currentPriority) return current;

	return new Date(candidate.modifiedAt).getTime() > new Date(current.modifiedAt).getTime()
		? koboCandidate
		: current;
}

export async function listKoboBooksForShelf(encodedShelfName: string): Promise<KoboLibraryBook[]> {
	const shelf = await assertKoboShelfExists(encodedShelfName);
	const books = await scanFilesystemLibrary(shelf.name);
	const bestByBookKey = new Map<string, KoboLibraryBook>();

	for (const book of books) {
		if (!isKoboUsableBook(book)) continue;
		bestByBookKey.set(book.bookKey, choosePreferredKoboBook(bestByBookKey.get(book.bookKey), book));
	}

	return Array.from(bestByBookKey.values()).sort((a, b) => a.title.localeCompare(b.title));
}

export async function getKoboBookById(
	encodedShelfName: string,
	id: string
): Promise<KoboLibraryBook | null> {
	const shelf = await assertKoboShelfExists(encodedShelfName);
	const relativePath = decodeLibraryItemId(id);
	if (!relativePath.startsWith(`${shelf.name}${path.sep}`) && relativePath !== shelf.name) {
		return null;
	}

	const books = await listKoboBooksForShelf(encodedShelfName);
	return books.find((book) => book.id === id) ?? null;
}

export async function resolveKoboBookOrThrow(
	encodedShelfName: string,
	id: string
): Promise<KoboLibraryBook> {
	const book = await getKoboBookById(encodedShelfName, id);
	if (!book) {
		throw new Error(`Kobo book not found for id ${id}`);
	}
	return book;
}

export function resolveKoboBookAbsolutePath(book: KoboLibraryBook): string {
	return resolveLibraryItemAbsolutePath(book.relativePath);
}

export function getKoboDownloadFormat(book: KoboLibraryBook): string {
	return book.koboFormat;
}
