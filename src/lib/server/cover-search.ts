/**
 * Find candidate cover images for a book on Open Library.
 *
 * Open Library is free, needs no API key, and serves covers with
 * Access-Control-Allow-Origin: *, so the browser can load them straight into
 * a canvas to convert to JPEG before saving.
 */

import type { CoverCandidate } from '$lib/types.js';

const OL = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';
const MAX_CANDIDATES = 24;
const USER_AGENT = 'book-thing (self-hosted library manager)';

function coverUrl(coverId: number): string {
	return `${COVERS}/b/id/${coverId}-L.jpg`;
}

async function getJson<T>(url: string): Promise<T | null> {
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(10_000)
		});
		return response.ok ? ((await response.json()) as T) : null;
	} catch {
		return null;
	}
}

interface SearchDoc {
	key: string;
	title: string;
	author_name?: string[];
	cover_i?: number;
	first_publish_year?: number;
}

interface EditionsResponse {
	entries: { covers?: number[]; publish_date?: string; publishers?: string[] }[];
}

/** Does the work's author list include (roughly) one of ours? */
function authorMatches(doc: SearchDoc, authors: string[]): boolean {
	if (!authors.length || !doc.author_name?.length) return true;
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
	const ours = authors.map(norm);
	return doc.author_name.some((name) => {
		const theirs = norm(name);
		return ours.some((o) => o.includes(theirs) || theirs.includes(o));
	});
}

export async function findCoverCandidates(book: {
	isbn?: string;
	title?: string;
	authors: string[];
}): Promise<CoverCandidate[]> {
	const candidates: CoverCandidate[] = [];
	const seen = new Set<string>();
	const add = (candidate: CoverCandidate) => {
		if (seen.has(candidate.url) || candidates.length >= MAX_CANDIDATES) return;
		seen.add(candidate.url);
		candidates.push(candidate);
	};

	// 1. Exact edition by ISBN. Look up the cover ID rather than using the
	//    /b/isbn/ URL so it dedupes against the edition list below.
	if (book.isbn) {
		const edition = await getJson<{ covers?: number[] }>(`${OL}/isbn/${book.isbn}.json`);
		const coverId = edition?.covers?.find((id) => id > 0);
		if (coverId) add({ url: coverUrl(coverId), label: 'This edition (ISBN)' });
	}

	// 2. Matching works by title/author, then covers from their editions
	if (book.title) {
		const params = new URLSearchParams({
			title: book.title,
			limit: '5',
			fields: 'key,title,author_name,cover_i,first_publish_year'
		});
		if (book.authors[0]) params.set('author', book.authors[0]);

		const search = await getJson<{ docs: SearchDoc[] }>(`${OL}/search.json?${params}`);
		const works = (search?.docs ?? []).filter((doc) => authorMatches(doc, book.authors));

		const addWork = (work: SearchDoc) => {
			if (!work.cover_i) return;
			add({
				url: coverUrl(work.cover_i),
				label: work.first_publish_year ? `${work.title} (${work.first_publish_year})` : work.title
			});
		};

		// Best match first, then its editions (alternative printings of the same
		// book), then other matching works (omnibuses, study guides...)
		const [bestWork, ...otherWorks] = works;
		if (bestWork) {
			addWork(bestWork);
			const editions = await getJson<EditionsResponse>(
				`${OL}${bestWork.key}/editions.json?limit=50`
			);
			for (const edition of editions?.entries ?? []) {
				const coverId = edition.covers?.find((id) => id > 0);
				if (!coverId) continue;
				const details = [edition.publishers?.[0], edition.publish_date].filter(Boolean).join(', ');
				add({ url: coverUrl(coverId), label: details || 'Edition' });
			}
		}
		otherWorks.forEach(addWork);
	}

	return candidates;
}
