import { readBookMetadata } from './book-metadata.js';
import type { KoboLibraryBook, KoboShelf } from './kobo-library.js';

export interface KoboDownloadDescriptor {
	Format: string;
	Url: string;
	Platform: 'Generic';
	Size: number;
}

export interface KoboBookMetadata {
	RevisionId: string;
	Title: string;
	Language: string;
	Contributors: string[] | null;
	Publisher: { Name: string | null; Imprint: string };
	PublicationDate: string;
	DownloadUrls: KoboDownloadDescriptor[];
	CoverImageId: string;
	EntitlementId: string;
	WorkId: string;
	Description: string | null;
	Categories: string[];
	MimeType: string;
	Format: string;
	ShelfName: string;
	Series?: {
		Name: string;
		Number: number;
		NumberFloat: number;
		Id: string;
	};
}

export interface KoboBookEntitlement {
	Id: string;
	RevisionId: string;
	Created: string;
	LastModified: string;
	OriginCategory: 'Imported';
	Status: 'Active';
	IsRemoved: boolean;
	IsLocked: false;
	IsHiddenFromArchive: false;
	Accessibility: 'Full';
	ActivePeriod: { From: string };
	CrossRevisionId: string;
}

function toKoboTimestamp(value: string | Date): string {
	const date = typeof value === 'string' ? new Date(value) : value;
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getMimeType(extension: string): string {
	const ext = extension.toLowerCase();
	if (ext === 'epub' || ext === 'kepub' || ext === 'kepub.epub') return 'application/epub+zip';
	if (ext === 'pdf') return 'application/pdf';
	if (ext === 'cbz') return 'application/x-cbz';
	if (ext === 'cbr') return 'application/x-cbr';
	if (ext === 'txt') return 'text/plain';
	return 'application/octet-stream';
}

export function createKoboDownloadDescriptor(
	book: KoboLibraryBook,
	downloadUrl: string
): KoboDownloadDescriptor {
	return {
		Format: book.koboFormat,
		Url: downloadUrl,
		Platform: 'Generic',
		Size: book.size
	};
}

export function createKoboBookEntitlement(book: KoboLibraryBook): KoboBookEntitlement {
	return {
		Id: book.id,
		RevisionId: book.id,
		Created: toKoboTimestamp(book.modifiedAt),
		LastModified: toKoboTimestamp(book.modifiedAt),
		OriginCategory: 'Imported',
		Status: 'Active',
		IsRemoved: false,
		IsLocked: false,
		IsHiddenFromArchive: false,
		Accessibility: 'Full',
		ActivePeriod: { From: toKoboTimestamp(new Date()) },
		CrossRevisionId: book.id
	};
}

export async function createKoboBookMetadata(
	book: KoboLibraryBook,
	shelf: KoboShelf,
	downloadUrl: string,
	coverUrl: string
): Promise<KoboBookMetadata> {
	const metadata = await readBookMetadata(book.path);
	return {
		RevisionId: book.id,
		Title: metadata.title,
		Language: 'en',
		Contributors: metadata.author && metadata.author !== 'Unknown' ? [metadata.author] : null,
		Publisher: { Name: null, Imprint: '' },
		PublicationDate: toKoboTimestamp(book.modifiedAt),
		DownloadUrls: [createKoboDownloadDescriptor(book, downloadUrl)],
		CoverImageId: book.id,
		EntitlementId: book.id,
		WorkId: book.id,
		Description: null,
		Categories: [shelf.name],
		MimeType: getMimeType(book.extension),
		Format: book.koboFormat,
		ShelfName: shelf.name
	};
}
