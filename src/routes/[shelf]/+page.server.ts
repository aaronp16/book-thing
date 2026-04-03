import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { scanFilesystemLibrary } from '$lib/server/fs-library.js';
import { isValidShelfName, listShelfDirectories } from '$lib/server/fs-shelves.js';
import { unzipSync } from 'fflate';

async function epubCoverHash(absolutePath: string): Promise<string | null> {
	try {
		const fileData = await fs.readFile(absolutePath);
		const zip = unzipSync(new Uint8Array(fileData));
		const coverEntry = Object.keys(zip).find((k) => k.endsWith('book-thing-cover.jpg'));
		if (!coverEntry) return null;
		return crypto.createHash('md5').update(zip[coverEntry]).digest('hex').slice(0, 8);
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const shelfName = params.shelf;

	if (!isValidShelfName(shelfName)) {
		throw error(404, 'Shelf not found');
	}

	const shelves = await listShelfDirectories();
	const shelf = shelves.find((s) => s.name.toLowerCase() === shelfName.toLowerCase());
	if (!shelf) {
		throw error(404, `Shelf "${shelfName}" not found`);
	}

	const items = await scanFilesystemLibrary(shelf.name);

	const books = await Promise.all(
		items.map(async (item) => {
			// item.extension has no dot (e.g. "epub"), so we reconstruct a dotted ext.
			const dotExt = `.${item.extension.toLowerCase()}`;
			let downloadFilename = path.basename(item.path);
			if (dotExt === '.epub') {
				const hash = await epubCoverHash(item.path);
				if (hash) {
					const stem = path.basename(item.path, dotExt);
					downloadFilename = `${stem}-${hash}${dotExt}`;
				}
			}
			return {
				id: item.id,
				title: item.title,
				author: item.author,
				extension: item.extension,
				size: item.size,
				hasCover: item.hasCover,
				downloadFilename
			};
		})
	);

	return {
		shelfName: shelf.name,
		books
	};
};
