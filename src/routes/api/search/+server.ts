import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { searchBooks } from '$lib/server/mam-client.js';
import type { SearchField } from '$lib/types.js';

const VALID_FIELDS: SearchField[] = ['title', 'author', 'torrent'];
const MAX_PAGES = 20; // Safety cap — 20 pages × 20 = 400 results max

/**
 * GET /api/search?q=harry+potter&field=title
 *
 * Search MyAnonamouse for ebooks, automatically fetching all pages.
 *
 * Query params:
 *   q     - Search query (required)
 *   field - 'title' | 'author' | 'torrent' (default: 'title')
 */
export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q');
	const field = (url.searchParams.get('field') || 'title') as SearchField;

	if (!query) {
		return json({ error: 'Missing query parameter "q"' }, { status: 400 });
	}

	if (!VALID_FIELDS.includes(field)) {
		return json(
			{ error: `Invalid field. Must be one of: ${VALID_FIELDS.join(', ')}` },
			{ status: 400 }
		);
	}

	try {
		// Fetch first page to get the total count
		const first = await searchBooks(query, field, 0);
		const allResults = [...first.results];
		const total = first.total;

		// Fetch remaining pages in parallel if there are more results
		if (total > first.perPage) {
			const remainingPages = Math.min(
				Math.ceil((total - first.perPage) / first.perPage),
				MAX_PAGES - 1
			);

			if (remainingPages > 0) {
				const pagePromises = Array.from({ length: remainingPages }, (_, i) =>
					searchBooks(query, field, i + 1)
				);
				const pages = await Promise.all(pagePromises);
				for (const page of pages) {
					allResults.push(...page.results);
				}
			}
		}

		return json({ results: allResults, total });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error('[api/search] Error:', message);
		return json({ error: message }, { status: 500 });
	}
};
