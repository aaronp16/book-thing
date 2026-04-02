import * as fs from 'fs/promises';
import * as path from 'path';
import type { RequestHandler } from './$types';
import { decodeLibraryItemId, resolveLibraryItemAbsolutePath } from '$lib/server/fs-library.js';

function getContentType(extension: string): string {
	const ext = extension.toLowerCase();
	if (ext === '.epub') return 'application/epub+zip';
	if (ext === '.pdf') return 'application/pdf';
	if (ext === '.cbz') return 'application/x-cbz';
	if (ext === '.cbr') return 'application/x-cbr';
	if (ext === '.txt') return 'text/plain; charset=utf-8';
	if (ext === '.mobi') return 'application/x-mobipocket-ebook';
	return 'application/octet-stream';
}

export const GET: RequestHandler = async ({ params }) => {
	const encodedId = params.id;
	if (!encodedId) {
		return new Response('Invalid book ID', { status: 400 });
	}

	try {
		const relativePath = decodeLibraryItemId(encodedId);
		const absolutePath = resolveLibraryItemAbsolutePath(relativePath);
		const fileData = await fs.readFile(absolutePath);
		const filename = path.basename(absolutePath);

		return new Response(new Uint8Array(fileData), {
			headers: {
				'Content-Type': getContentType(path.extname(filename)),
				'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
				'Cache-Control': 'no-cache'
			}
		});
	} catch (error) {
		console.error(`[api/library/${encodedId}/download] Error:`, error);
		return new Response('Failed to download book', { status: 500 });
	}
};
