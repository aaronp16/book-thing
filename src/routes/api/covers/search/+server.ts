/**
 * GET /api/covers/search?title=...&author=...
 *
 * Returns candidate cover image URLs from Open Library and Google Books.
 * The browser loads the images directly for external providers.
 * Current local covers are returned as data URLs.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	searchOpenLibraryCovers,
	searchGoogleBooksCovers,
	extractEmbeddedCoverBytes,
	findSidecarCover
} from '$lib/server/book-covers.js';
import { decodeLibraryItemId, resolveLibraryItemAbsolutePath } from '$lib/server/fs-library.js';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), timeoutMs);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch(() => {
				clearTimeout(timer);
				resolve(fallback);
			});
	});
}

function getProxyDisplayUrl(externalUrl: string, source: string): string {
	let displayUrl = externalUrl;
	if (source === 'google') {
		displayUrl = externalUrl.replace('zoom=0', 'zoom=1');
	}
	if (source === 'openlibrary') {
		displayUrl = externalUrl.replace('-L.jpg', '-M.jpg');
	}
	return `/api/covers/proxy?url=${encodeURIComponent(displayUrl)}`;
}

function getCurrentCoverDisplayUrl(bookId: string): string {
	return `/api/library/cover/${bookId}?w=480&t=${Date.now()}`;
}

export const GET: RequestHandler = async ({ url }) => {
	const title = url.searchParams.get('title') ?? '';
	const author = url.searchParams.get('author') ?? '';
	const bookId = url.searchParams.get('bookId');

	if (!title) {
		return json({ error: 'title is required' }, { status: 400 });
	}

	try {
		const currentCoverPromise = (async () => {
			if (!bookId) return null;
			try {
				const relativePath = decodeLibraryItemId(bookId);
				const bookPath = resolveLibraryItemAbsolutePath(relativePath);
				const sidecarPath = await findSidecarCover(bookPath);
				if (sidecarPath) {
					return getCurrentCoverDisplayUrl(bookId);
				}
				const embeddedCover = await extractEmbeddedCoverBytes(bookPath);
				return embeddedCover ? getCurrentCoverDisplayUrl(bookId) : null;
			} catch {
				return null;
			}
		})();

		// Run all searches in parallel, but don't let one slow provider block the whole modal.
		const [currentCoverDataUrl, googleUrls, olUrls] = await Promise.all([
			withTimeout(currentCoverPromise, 1500, null),
			withTimeout(searchGoogleBooksCovers(title, author), 2000, [] as string[]),
			withTimeout(searchOpenLibraryCovers(title, author), 1500, [] as string[])
		]);

		const seen = new Set<string>();
		const covers: Array<{
			url: string;
			displayUrl: string;
			source: string;
			preSelected?: boolean;
		}> = [];

		if (currentCoverDataUrl) {
			covers.push({
				url: currentCoverDataUrl,
				displayUrl: currentCoverDataUrl,
				source: 'current',
				preSelected: true
			});
			seen.add(currentCoverDataUrl);
		}

		for (const u of googleUrls) {
			if (!seen.has(u)) {
				seen.add(u);
				const proxiedUrl = getProxyDisplayUrl(u, 'google');
				covers.push({
					url: proxiedUrl,
					displayUrl: proxiedUrl,
					source: 'google'
				});
			}
		}
		for (const u of olUrls) {
			if (!seen.has(u)) {
				seen.add(u);
				const proxiedUrl = getProxyDisplayUrl(u, 'openlibrary');
				covers.push({
					url: proxiedUrl,
					displayUrl: proxiedUrl,
					source: 'openlibrary'
				});
			}
		}

		return json({ covers });
	} catch (err) {
		console.error('[api/covers/search] Error:', err);
		return json({ error: 'Failed to search covers' }, { status: 500 });
	}
};
