import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
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

/**
 * Namespace UUID for generating deterministic book UUIDs via UUID v5.
 * This is a fixed namespace so that the same book path always produces
 * the same UUID, matching the UUID format that Kobo devices expect.
 */
const KOBO_BOOK_UUID_NAMESPACE = '2d5a92f4-7c3e-4b1a-9f6d-8e0c1b2a3d4e';

/**
 * Generate a deterministic UUID v5 from a book's relative path.
 * Kobo devices expect all IDs (RevisionId, EntitlementId, CrossRevisionId,
 * WorkId, CoverImageId) to be standard UUID-formatted strings.
 */
function generateKoboBookUuid(relativePath: string): string {
	// UUID v5: SHA-1 hash of namespace + name, formatted as UUID
	const namespaceBytes = uuidToBytes(KOBO_BOOK_UUID_NAMESPACE);
	const nameBytes = Buffer.from(relativePath, 'utf8');
	const hash = crypto.createHash('sha1').update(namespaceBytes).update(nameBytes).digest();

	// Set version (5) and variant bits per RFC 4122
	hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
	hash[8] = (hash[8] & 0x3f) | 0x80; // variant 10

	const hex = hash.subarray(0, 16).toString('hex');
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32)
	].join('-');
}

function uuidToBytes(uuid: string): Buffer {
	return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export interface KoboShelf {
	name: string;
	encodedName: string;
	path: string;
}

export interface KoboLibraryBook extends FilesystemLibraryItem {
	koboFormat: string;
	/** UUID v5 identifier for the Kobo protocol (derived from relative path) */
	koboId: string;
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
		koboFormat: candidate.extension.toUpperCase(),
		koboId: generateKoboBookUuid(candidate.relativePath)
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

/**
 * Look up a book by its Kobo UUID (used by the device in metadata/state/cover requests).
 * Falls back to trying the id as a base64url-encoded path for backwards compatibility.
 */
export async function getKoboBookByKoboId(
	encodedShelfName: string,
	koboId: string
): Promise<KoboLibraryBook | null> {
	const books = await listKoboBooksForShelf(encodedShelfName);

	// First try matching by Kobo UUID
	const byUuid = books.find((book) => book.koboId === koboId);
	if (byUuid) return byUuid;

	// Fallback: try as a base64url-encoded library item ID
	try {
		return await getKoboBookById(encodedShelfName, koboId);
	} catch {
		return null;
	}
}

export async function resolveKoboBookOrThrow(
	encodedShelfName: string,
	id: string
): Promise<KoboLibraryBook> {
	const book = await getKoboBookByKoboId(encodedShelfName, id);
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
