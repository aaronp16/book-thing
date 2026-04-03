import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { scanFilesystemLibrary } from '$lib/server/fs-library.js';
import { isValidShelfName, listShelfDirectories } from '$lib/server/fs-shelves.js';

export const load: PageServerLoad = async ({ params }) => {
	const shelfName = params.shelf;

	if (!isValidShelfName(shelfName)) {
		throw error(404, 'Shelf not found');
	}

	// Verify the shelf directory exists
	const shelves = await listShelfDirectories();
	const shelf = shelves.find((s) => s.name.toLowerCase() === shelfName.toLowerCase());
	if (!shelf) {
		throw error(404, `Shelf "${shelfName}" not found`);
	}

	const items = await scanFilesystemLibrary(shelf.name);

	const books = items.map((item) => ({
		id: item.id,
		title: item.title,
		author: item.author,
		extension: item.extension,
		size: item.size,
		hasCover: item.hasCover
	}));

	return {
		shelfName: shelf.name,
		books
	};
};
