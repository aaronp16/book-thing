import { readBookMetadata } from './book-metadata.js';
import type { KoboLibraryBook, KoboShelf } from './kobo-library.js';

export interface KoboDownloadDescriptor {
	Format: string;
	Url: string;
	Platform: 'Generic';
	Size: number;
}

export interface KoboBookMetadata {
	Categories: string[];
	CoverImageId: string;
	CrossRevisionId: string;
	CurrentDisplayPrice: { CurrencyCode: string; TotalAmount: number };
	CurrentLoveDisplayPrice: { TotalAmount: number };
	Description: string | null;
	DownloadUrls: KoboDownloadDescriptor[];
	EntitlementId: string;
	ExternalIds: string[];
	Genre: string;
	IsEligibleForKoboLove: boolean;
	IsInternetArchive: boolean;
	IsPreOrder: boolean;
	IsSocialEnabled: boolean;
	Language: string;
	PhoneticPronunciations: Record<string, never>;
	PublicationDate: string;
	Publisher: { Name: string | null; Imprint: string };
	RevisionId: string;
	Title: string;
	WorkId: string;
	Contributors?: string[];
	ContributorRoles?: Array<{ Name: string }>;
	Series?: {
		Name: string;
		Number: number;
		NumberFloat: number;
		Id: string;
	};
}

export interface KoboBookEntitlement {
	Accessibility: 'Full';
	ActivePeriod: { From: string };
	Created: string;
	CrossRevisionId: string;
	Id: string;
	IsHiddenFromArchive: false;
	IsLocked: false;
	IsRemoved: boolean;
	LastModified: string;
	OriginCategory: 'Imported';
	RevisionId: string;
	Status: 'Active';
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

/**
 * Map file extension to the Kobo format string expected by the device.
 * Kobo devices recognize: KEPUB, EPUB, EPUB3, EPUB3FL, PDF
 */
function toKoboDownloadFormat(extension: string): string {
	const ext = extension.toLowerCase();
	if (ext === 'kepub' || ext === 'kepub.epub') return 'KEPUB';
	if (ext === 'epub') return 'EPUB';
	if (ext === 'pdf') return 'PDF';
	return ext.toUpperCase();
}

export function createKoboDownloadDescriptor(
	book: KoboLibraryBook,
	downloadUrl: string
): KoboDownloadDescriptor {
	return {
		Format: toKoboDownloadFormat(book.extension),
		Url: downloadUrl,
		Platform: 'Generic',
		Size: book.size
	};
}

export function createKoboBookEntitlement(book: KoboLibraryBook): KoboBookEntitlement {
	return {
		Accessibility: 'Full',
		ActivePeriod: { From: toKoboTimestamp(new Date()) },
		Created: toKoboTimestamp(book.modifiedAt),
		CrossRevisionId: book.id,
		Id: book.id,
		IsHiddenFromArchive: false,
		IsLocked: false,
		IsRemoved: false,
		LastModified: toKoboTimestamp(book.modifiedAt),
		OriginCategory: 'Imported',
		RevisionId: book.id,
		Status: 'Active'
	};
}

export async function createKoboBookMetadata(
	book: KoboLibraryBook,
	shelf: KoboShelf,
	downloadUrl: string,
	coverImageId: string
): Promise<KoboBookMetadata> {
	const metadata = await readBookMetadata(book.path);
	const hasAuthor = metadata.author && metadata.author !== 'Unknown';

	const result: KoboBookMetadata = {
		Categories: ['00000000-0000-0000-0000-000000000001'],
		CoverImageId: coverImageId,
		CrossRevisionId: book.id,
		CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
		CurrentLoveDisplayPrice: { TotalAmount: 0 },
		Description: null,
		DownloadUrls: [createKoboDownloadDescriptor(book, downloadUrl)],
		EntitlementId: book.id,
		ExternalIds: [],
		Genre: '00000000-0000-0000-0000-000000000001',
		IsEligibleForKoboLove: false,
		IsInternetArchive: false,
		IsPreOrder: false,
		IsSocialEnabled: true,
		Language: 'en',
		PhoneticPronunciations: {},
		PublicationDate: toKoboTimestamp(book.modifiedAt),
		Publisher: { Name: null, Imprint: '' },
		RevisionId: book.id,
		Title: metadata.title,
		WorkId: book.id
	};

	if (hasAuthor) {
		result.Contributors = [metadata.author!];
		result.ContributorRoles = [{ Name: metadata.author! }];
	}

	return result;
}
