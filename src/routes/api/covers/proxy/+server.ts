/**
 * GET /api/covers/proxy?url=<encoded>
 *
 * Proxies cover image bytes from external sources (Google Books, Open Library)
 * to avoid CORS issues when the browser loads images directly.
 *
 * Only allows requests to known cover CDN hostnames.
 */

import type { RequestHandler } from './$types';

const ALLOWED_HOSTS = new Set([
	'books.google.com',
	'covers.openlibrary.org',
	'images-na.ssl-images-amazon.com',
	'i.gr-assets.com'
]);

export const GET: RequestHandler = async ({ url, fetch }) => {
	const rawUrl = url.searchParams.get('url');
	if (!rawUrl) {
		return new Response('Missing url parameter', { status: 400 });
	}

	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return new Response('Invalid URL', { status: 400 });
	}

	if (!ALLOWED_HOSTS.has(parsed.hostname)) {
		return new Response('Host not allowed', { status: 403 });
	}

	try {
		const upstream = await fetch(rawUrl, {
			headers: {
				// Provide a Referer so Google Books serves the image
				Referer: 'https://books.google.com/',
				'User-Agent': 'Mozilla/5.0 (compatible; book-thing/1.0)'
			}
		});

		if (!upstream.ok) {
			return new Response(`Upstream error: ${upstream.status}`, { status: 502 });
		}

		const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
		const body = await upstream.arrayBuffer();

		return new Response(body, {
			status: 200,
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=86400'
			}
		});
	} catch (err) {
		console.error('[covers/proxy] fetch failed:', err);
		return new Response('Proxy fetch failed', { status: 502 });
	}
};
