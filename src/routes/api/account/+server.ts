import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { getAccount } from '$lib/server/mam-client.js';

/**
 * GET /api/account
 *
 * The MAM user's class and VIP expiry.
 */
export const GET: RequestHandler = async () => {
	try {
		return json(await getAccount());
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to load account';
		return json({ error: message }, { status: 502 });
	}
};
