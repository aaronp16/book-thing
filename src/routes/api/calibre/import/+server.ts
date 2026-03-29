import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getCalibreImportStatus,
	importFromCalibreLibrary,
	previewCalibreImport
} from '$lib/server/calibre-import.js';

export const GET: RequestHandler = async () => {
	try {
		const status = await getCalibreImportStatus();
		return json(status);
	} catch (error) {
		console.error('[api/calibre/import] Failed to get status:', error);
		return json({ error: 'Failed to inspect Calibre import status' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		if (body?.dryRun) {
			const preview = await previewCalibreImport();
			return json({ ok: true, preview, dryRun: true });
		}

		const summary = await importFromCalibreLibrary();
		return json({ ok: true, summary });
	} catch (error) {
		console.error('[api/calibre/import] Import failed:', error);
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to import from Calibre' },
			{ status: 500 }
		);
	}
};
