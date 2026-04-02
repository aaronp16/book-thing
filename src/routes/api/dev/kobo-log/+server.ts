import type { RequestHandler } from './$types';
import * as fs from 'fs/promises';
import { getKoboDebugLogPath } from '$lib/server/kobo-logging.js';

export const GET: RequestHandler = async () => {
	try {
		const logPath = getKoboDebugLogPath();
		const raw = await fs.readFile(logPath, 'utf8');
		return new Response(raw, {
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-cache'
			}
		});
	} catch {
		return new Response('', {
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-cache'
			}
		});
	}
};
