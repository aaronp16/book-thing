import type { RequestHandler } from '@sveltejs/kit';
import { backfillCovers } from '$lib/server/calibre-client.js';

/**
 * GET /api/covers/backfill
 *
 * Server-Sent Events stream. Fetches covers for every book in the Calibre
 * library that has has_cover = 0 and streams progress back to the client.
 *
 * Each event is a JSON-encoded CoverBackfillEvent:
 *   { type: 'start' | 'done' | 'skip', bookId, title, author, processed, total, success?, source? }
 *
 * The stream ends naturally when all books have been processed.
 */
export const GET: RequestHandler = () => {
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const event of backfillCovers()) {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					controller.enqueue(encoder.encode(data));
				}
			} catch (err) {
				console.error('[covers/backfill] Stream error:', err);
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
