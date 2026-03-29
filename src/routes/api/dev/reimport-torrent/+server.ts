import { dev } from '$app/environment';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as fs from 'fs/promises';
import { getTorrent, getTorrents, mapState } from '$lib/server/qbittorrent-client.js';
import { copyBookToLibrary } from '$lib/server/library.js';
import { env } from '$lib/server/env.js';

function translateQBPath(contentPath: string): string {
	return contentPath.replace(/^\/data\/torrents\/books/, '/torrents');
}

export const GET: RequestHandler = async () => {
	if (!dev) {
		return json({ error: 'Not available outside development' }, { status: 404 });
	}

	try {
		const torrents = await getTorrents({ category: env.QB_CATEGORY });
		const completed = await Promise.all(
			torrents
				.filter((torrent) => mapState(torrent.state) === 'seeding' || torrent.progress >= 1)
				.map(async (torrent) => {
					const translatedPath = translateQBPath(torrent.content_path);
					let localPathAccessible = false;
					try {
						await fs.stat(translatedPath);
						localPathAccessible = true;
					} catch {
						localPathAccessible = false;
					}

					return {
						hash: torrent.hash,
						name: torrent.name,
						contentPath: torrent.content_path,
						translatedPath,
						localPathAccessible,
						progress: torrent.progress,
						state: torrent.state,
						addedAt: new Date(torrent.added_on * 1000).toISOString()
					};
				})
		);
		const sorted = completed.sort((a, b) => b.addedAt.localeCompare(a.addedAt));

		return json({ torrents: sorted });
	} catch (error) {
		console.error('[api/dev/reimport-torrent] Failed to list torrents:', error);
		return json({ error: 'Failed to list completed torrents' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	if (!dev) {
		return json({ error: 'Not available outside development' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
		const shelfNames = Array.isArray(body.shelfNames)
			? body.shelfNames.filter(
					(item: unknown): item is string => typeof item === 'string' && item.trim().length > 0
				)
			: [];

		if (!hash) {
			return json({ error: 'hash is required' }, { status: 400 });
		}
		if (shelfNames.length === 0) {
			return json({ error: 'shelfNames must be a non-empty string array' }, { status: 400 });
		}

		const torrent = await getTorrent(hash);
		if (!torrent) {
			return json({ error: 'Torrent not found' }, { status: 404 });
		}

		const bookIds = await copyBookToLibrary(torrent.content_path, shelfNames);
		if (bookIds.length === 0) {
			return json(
				{
					error:
						'No files were imported. Check the torrent content path, the /torrents mount, and whether the torrent contains supported ebook files.',
					torrent: {
						hash: torrent.hash,
						name: torrent.name,
						contentPath: torrent.content_path,
						state: torrent.state
					}
				},
				{ status: 409 }
			);
		}

		return json({ ok: true, bookIds, torrent: { hash: torrent.hash, name: torrent.name } });
	} catch (error) {
		console.error('[api/dev/reimport-torrent] Reimport failed:', error);
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to re-import torrent' },
			{ status: 500 }
		);
	}
};
