/**
 * GET /api/covers/search?title=...&author=...
 *
 * Returns candidate cover image URLs from Open Library and Google Books.
 * The browser loads the images directly — no image bytes are proxied here.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	searchOpenLibraryCovers,
	searchGoogleBooksCovers,
	extractCoverForBook
} from '$lib/server/calibre-client.js';

export const GET: RequestHandler = async ({ url }) => {
	const title = url.searchParams.get('title') ?? '';
	const author = url.searchParams.get('author') ?? '';
	const bookIdParam = url.searchParams.get('bookId');
	const bookId = bookIdParam ? parseInt(bookIdParam) : null;

	if (!title) {
		return json({ error: 'title is required' }, { status: 400 });
	}

	try {
		// Run all searches in parallel
		const [embeddedDataUrl, olUrls, googleUrls] = await Promise.all([
			bookId && !isNaN(bookId) ? extractCoverForBook(bookId) : Promise.resolve(null),
			searchOpenLibraryCovers(title, author),
			searchGoogleBooksCovers(title, author)
		]);

		function proxyUrl(externalUrl: string): string {
			return `/api/covers/proxy?url=${encodeURIComponent(externalUrl)}`;
		}

		const seen = new Set<string>();
		const covers: Array<{
			url: string;
			displayUrl: string;
			source: string;
			preSelected?: boolean;
		}> = [];

		// Embedded cover from the EPUB — first and pre-selected
		if (embeddedDataUrl) {
			covers.push({
				url: embeddedDataUrl,
				displayUrl: embeddedDataUrl,
				source: 'embedded',
				preSelected: true
			});
			seen.add(embeddedDataUrl);
		}

		for (const u of olUrls) {
			if (!seen.has(u)) {
				seen.add(u);
				covers.push({ url: u, displayUrl: proxyUrl(u), source: 'openlibrary' });
			}
		}
		for (const u of googleUrls) {
			if (!seen.has(u)) {
				seen.add(u);
				covers.push({ url: u, displayUrl: proxyUrl(u), source: 'google' });
			}
		}

		return json({ covers });
	} catch (err) {
		console.error('[api/covers/search] Error:', err);
		return json({ error: 'Failed to search covers' }, { status: 500 });
	}
};
