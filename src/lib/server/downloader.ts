/**
 * Download orchestrator
 *
 * Coordinates fetching .torrent files from MAM and adding them to qBittorrent.
 * Tracks download jobs and provides progress updates via subscriptions.
 */

import { downloadTorrentFile } from './mam-client.js';
import {
	addTorrent,
	getTorrent,
	deleteTorrent,
	mapState,
	computeInfoHash
} from './qbittorrent-client.js';
import { copyBookToLibrary } from './library.js';
import type { DownloadJob } from '$lib/types.js';

/** Active download jobs */
const activeJobs = new Map<string, DownloadJob>();

/** Progress listeners for SSE streaming */
const progressListeners = new Map<string, Set<(job: DownloadJob) => void>>();

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
	return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Notify all listeners of a job update
 */
function notifyProgress(jobId: string, job: DownloadJob): void {
	const listeners = progressListeners.get(jobId);
	if (listeners) {
		for (const listener of listeners) {
			listener(job);
		}
	}
}

/**
 * Start a download job for a book
 *
 * @param mamId - MyAnonamouse torrent ID
 * @param title - Book title (for display)
 * @param shelfNames - Shelf names to add book to after download completes
 * @returns Job ID for tracking progress
 */
export async function startDownload(
	mamId: number,
	title: string,
	shelfNames: string[]
): Promise<string> {
	const jobId = generateJobId();

	const job: DownloadJob = {
		id: jobId,
		mamId,
		title,
		status: 'fetching',
		progress: 0,
		downloadSpeed: 0,
		uploadSpeed: 0,
		numPeers: 0,
		shelfNames
	};

	activeJobs.set(jobId, job);
	notifyProgress(jobId, job);

	// Start download in background
	(async () => {
		try {
			// Step 1: Fetch .torrent file from MAM
			console.log(`[downloader] Fetching torrent for ${mamId}: ${title}`);
			const torrentBuffer = await downloadTorrentFile(mamId);

			// Step 2: Add to qBittorrent — remove first if it already exists
			job.status = 'downloading';
			notifyProgress(jobId, job);

			const hash = computeInfoHash(torrentBuffer);
			const existing = await getTorrent(hash);
			if (existing) {
				console.log(
					`[downloader] Torrent already exists (${hash}), removing before re-add: ${title}`
				);
				await deleteTorrent(hash, false); // keep files — they may already be in the library
				// Brief pause to let qBittorrent process the removal
				await new Promise((r) => setTimeout(r, 1000));
			}

			console.log(`[downloader] Adding torrent to qBittorrent: ${title}`);
			await addTorrent(torrentBuffer);
			job.infoHash = hash;

			// Step 3: Set up progress polling
			const pollInterval = setInterval(async () => {
				try {
					const torrent = await getTorrent(hash);
					if (!torrent) {
						clearInterval(pollInterval);
						return;
					}

					job.progress = torrent.progress;
					job.downloadSpeed = torrent.dlspeed;
					job.uploadSpeed = torrent.upspeed;
					job.numPeers = torrent.num_seeds + torrent.num_leechs;

					const status = mapState(torrent.state);

					if (status === 'seeding' || torrent.progress >= 1) {
						job.status = 'complete';
						job.progress = 1;
						clearInterval(pollInterval);
						console.log(`[downloader] Download complete: ${title}`);

						// Copy the best ebook file to the library directory, await so we get book IDs
						if (torrent.content_path) {
							try {
								const bookIds = await copyBookToLibrary(torrent.content_path, job.shelfNames);
								job.bookIds = bookIds;
							} catch (err) {
								console.error(`[downloader] Copy to library failed:`, err);
							}
						}

						notifyProgress(jobId, job);

						// Clean up job after a delay (keep for SSE to report completion)
						setTimeout(() => {
							activeJobs.delete(jobId);
							progressListeners.delete(jobId);
						}, 30000);
					} else if (status === 'error') {
						job.status = 'error';
						job.error = `Torrent in error state: ${torrent.state}`;
						notifyProgress(jobId, job);
						clearInterval(pollInterval);
					} else {
						notifyProgress(jobId, job);
					}
				} catch (err) {
					console.error(`[downloader] Error polling torrent status:`, err);
				}
			}, 2000); // Poll every 2 seconds (qBittorrent is remote, don't poll too fast)
		} catch (err) {
			job.status = 'error';
			job.error = err instanceof Error ? err.message : 'Download failed';
			notifyProgress(jobId, job);
			console.error(`[downloader] Failed to start download for ${title}:`, job.error);

			// Clean up failed job after a delay
			setTimeout(() => {
				activeJobs.delete(jobId);
				progressListeners.delete(jobId);
			}, 30000);
		}
	})();

	return jobId;
}

/**
 * Get the current status of a download job
 */
export function getJobStatus(jobId: string): DownloadJob | undefined {
	return activeJobs.get(jobId);
}

/**
 * Get all active download jobs
 */
export function getActiveJobs(): DownloadJob[] {
	return Array.from(activeJobs.values());
}

/**
 * Subscribe to progress updates for a job
 *
 * @param jobId - The job ID to subscribe to
 * @param listener - Callback for progress updates
 * @returns Unsubscribe function
 */
export function subscribeToProgress(
	jobId: string,
	listener: (job: DownloadJob) => void
): () => void {
	if (!progressListeners.has(jobId)) {
		progressListeners.set(jobId, new Set());
	}

	progressListeners.get(jobId)!.add(listener);

	// Send current state immediately
	const job = activeJobs.get(jobId);
	if (job) {
		listener(job);
	}

	// Return unsubscribe function
	return () => {
		progressListeners.get(jobId)?.delete(listener);
	};
}
