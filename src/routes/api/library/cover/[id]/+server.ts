/**
 * GET /api/library/cover/[id]
 *
 * Serve a book cover by filesystem-native library item ID.
 * Prefers sibling sidecar covers, then falls back to embedded covers.
 */

import type { RequestHandler } from './$types';
import * as fs from 'fs/promises';
import { extractEmbeddedCoverBytes, findSidecarCover } from '$lib/server/book-covers.js';
import { decodeLibraryItemId, resolveLibraryItemAbsolutePath } from '$lib/server/fs-library.js';

function detectImageContentType(bytes: Buffer): string {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return 'image/png';
	}
	if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF87a') {
		return 'image/gif';
	}
	if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
		return 'image/gif';
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
		bytes.subarray(8, 12).toString('ascii') === 'WEBP'
	) {
		return 'image/webp';
	}
	return 'application/octet-stream';
}

export const GET: RequestHandler = async ({ params }) => {
	try {
		const relativePath = decodeLibraryItemId(params.id);
		const bookPath = resolveLibraryItemAbsolutePath(relativePath);

		const sidecarPath = await findSidecarCover(bookPath);
		if (sidecarPath) {
			const stat = await fs.stat(sidecarPath);
			const etag = `"${stat.mtimeMs.toString(36)}"`;
			const coverData = await fs.readFile(sidecarPath);
			return new Response(new Uint8Array(coverData), {
				headers: {
					'Content-Type': 'image/jpeg',
					'Cache-Control': 'no-cache',
					ETag: etag
				}
			});
		}

		const embeddedCover = await extractEmbeddedCoverBytes(bookPath);
		if (embeddedCover) {
			const stat = await fs.stat(bookPath);
			const etag = `"${stat.mtimeMs.toString(36)}"`;
			return new Response(new Uint8Array(embeddedCover), {
				headers: {
					'Content-Type': detectImageContentType(embeddedCover),
					'Cache-Control': 'no-cache',
					ETag: etag
				}
			});
		}

		return new Response('Cover not found', { status: 404 });
	} catch (err) {
		console.error('[api/library/cover] Error:', err);
		return new Response('Internal server error', { status: 500 });
	}
};
