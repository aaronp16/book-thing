/**
 * GET /api/progress/[id]
 *
 * SSE stream for download progress updates.
 *
 * Events:
 * - { type: 'connected', jobId: string }
 * - { type: 'progress', ...DownloadJob }
 * - { type: 'done' }
 */

import type { RequestHandler } from './$types';
import { subscribeToProgress, getJobStatus } from '$lib/server/downloader';

export const GET: RequestHandler = async ({ params }) => {
	const jobId = params.id;

	// Check if job exists
	const job = getJobStatus(jobId);
	if (!job) {
		return new Response('Job not found', { status: 404 });
	}

	// Create SSE stream
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			// Send initial connection message
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: 'connected', jobId })}\n\n`)
			);

			// Subscribe to progress updates
			const unsubscribe = subscribeToProgress(jobId, (jobUpdate) => {
				try {
					const data = JSON.stringify({ type: 'progress', ...jobUpdate });
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));

					// Close stream when download is complete or errored
					if (jobUpdate.status === 'complete' || jobUpdate.status === 'error') {
						const donePayload = {
							type: 'done',
							status: jobUpdate.status,
							error: jobUpdate.error,
							bookIds: jobUpdate.bookIds ?? []
						};
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(donePayload)}\n\n`));
						unsubscribe();
						controller.close();
					}
				} catch {
					// Stream closed by client
					unsubscribe();
				}
			});

			// Handle client disconnect
			return () => {
				unsubscribe();
			};
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
