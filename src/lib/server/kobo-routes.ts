import { json } from '@sveltejs/kit';
import type { KoboLibraryBook, KoboShelf } from './kobo-library.js';

export function toKoboTimestamp(value: string | Date | null | undefined): string {
	if (!value) return new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z');
	const date = typeof value === 'string' ? new Date(value) : value;
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildKoboRouteUrls(baseUrl: string, shelf: KoboShelf, book: KoboLibraryBook) {
	const shelfBase = `${baseUrl}/kobo/${shelf.encodedName}`;
	return {
		downloadUrl: `${shelfBase}/download/${book.id}/${book.koboFormat.toLowerCase()}`,
		/** Kobo UUID for the device protocol (used as CoverImageId, EntitlementId, etc.) */
		koboId: book.koboId
	};
}

export function isKoboShelfError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('Kobo shelf not found');
}

export function isKoboBookError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('Kobo book not found');
}

export function createKoboShelfNotFoundJsonResponse() {
	return json({ error: 'Shelf not found' }, { status: 404 });
}

export function createKoboBookNotFoundJsonResponse() {
	return json({ error: 'Book not found' }, { status: 404 });
}

export function createKoboShelfNotFoundTextResponse() {
	return new Response('Shelf not found', { status: 404 });
}

export function createKoboBookNotFoundTextResponse() {
	return new Response('Book not found', { status: 404 });
}
