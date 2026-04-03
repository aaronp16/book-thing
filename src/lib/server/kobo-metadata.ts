import { readBookMetadata } from './book-metadata.js';
import type { KoboLibraryBook, KoboShelf } from './kobo-library.js';
import { toKoboTimestamp } from './kobo-routes.js';

export interface KoboDownloadDescriptor {
	Format: string;
	Size: number;
	Url: string;
	Platform: 'Generic';
}

export interface KoboBookMetadata {
	Categories: string[];
	CoverImageId: string;
	CrossRevisionId: string;
	CurrentDisplayPrice: { CurrencyCode: string; TotalAmount: number };
	CurrentLoveDisplayPrice: { TotalAmount: number };
	Description: string;
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
	Publisher: { Imprint: string; Name: string };
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
 * Map file extension to Kobo format strings expected by the device.
 * Calibre-web maps EPUB to both EPUB3 and EPUB entries (the device may
 * prefer EPUB3). KEPUB gets a single KEPUB entry.
 *
 * KOBO_FORMATS equivalent from calibre-web:
 *   {"KEPUB": ["KEPUB"], "EPUB": ["EPUB3", "EPUB"]}
 */
function toKoboDownloadFormats(extension: string): string[] {
	const ext = extension.toLowerCase();
	if (ext === 'kepub' || ext === 'kepub.epub') return ['KEPUB'];
	if (ext === 'epub') return ['EPUB3', 'EPUB'];
	if (ext === 'pdf') return ['PDF'];
	return [ext.toUpperCase()];
}

/**
 * Create download descriptors for a book. For EPUB books, this returns
 * two entries (EPUB3 + EPUB) matching calibre-web's behavior, since the
 * Kobo device may require the EPUB3 format entry to trigger downloads.
 */
export function createKoboDownloadDescriptors(
	book: KoboLibraryBook,
	downloadUrl: string
): KoboDownloadDescriptor[] {
	return toKoboDownloadFormats(book.extension).map((format) => ({
		Format: format,
		Size: book.size,
		Url: downloadUrl,
		Platform: 'Generic' as const
	}));
}

export function createKoboBookEntitlement(book: KoboLibraryBook): KoboBookEntitlement {
	return {
		Accessibility: 'Full',
		ActivePeriod: { From: toKoboTimestamp(new Date()) },
		Created: toKoboTimestamp(book.modifiedAt),
		CrossRevisionId: book.koboId,
		Id: book.koboId,
		IsHiddenFromArchive: false,
		IsLocked: false,
		IsRemoved: false,
		LastModified: toKoboTimestamp(book.modifiedAt),
		OriginCategory: 'Imported',
		RevisionId: book.koboId,
		Status: 'Active'
	};
}

export async function createKoboBookMetadata(
	book: KoboLibraryBook,
	shelf: KoboShelf,
	downloadUrl: string,
	koboId: string
): Promise<KoboBookMetadata> {
	const metadata = await readBookMetadata(book.path);
	const hasAuthor = metadata.author && metadata.author !== 'Unknown';

	const result: KoboBookMetadata = {
		Categories: ['00000000-0000-0000-0000-000000000001'],
		CoverImageId: koboId,
		CrossRevisionId: koboId,
		CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 },
		CurrentLoveDisplayPrice: { TotalAmount: 0 },
		Description: metadata.description || '',
		DownloadUrls: createKoboDownloadDescriptors(book, downloadUrl),
		EntitlementId: koboId,
		ExternalIds: [],
		Genre: '00000000-0000-0000-0000-000000000001',
		IsEligibleForKoboLove: false,
		IsInternetArchive: false,
		IsPreOrder: false,
		IsSocialEnabled: true,
		Language: 'en',
		PhoneticPronunciations: {},
		PublicationDate: toKoboTimestamp(book.modifiedAt),
		Publisher: { Imprint: '', Name: '' },
		RevisionId: koboId,
		Title: metadata.title,
		WorkId: koboId
	};

	// Calibre-web always includes ContributorRoles and Contributors
	// (with Contributors=null when no author). We provide empty arrays instead.
	if (hasAuthor) {
		result.Contributors = [metadata.author!];
		result.ContributorRoles = [{ Name: metadata.author! }];
	} else {
		result.Contributors = [];
		result.ContributorRoles = [];
	}

	return result;
}
