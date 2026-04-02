import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { createKoboShelfNotFoundJsonResponse, isKoboShelfError } from '$lib/server/kobo-routes.js';
import { logKoboError, logKoboRequest } from '$lib/server/kobo-logging.js';

function createRefreshPayload() {
	return {
		AccessToken: randomBytes(24).toString('base64'),
		RefreshToken: randomBytes(24).toString('base64'),
		TokenType: 'Bearer',
		TrackingId: randomUUID()
	};
}

async function handleRefreshRequest(args: { shelf: string; method: string }): Promise<Response> {
	try {
		const shelf = await assertKoboShelfExists(args.shelf);

		logKoboRequest('auth/refresh', {
			shelf: shelf.name,
			method: args.method
		});

		return json(createRefreshPayload(), {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'x-kobo-apitoken': 'e30='
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			return createKoboShelfNotFoundJsonResponse();
		}

		logKoboError('auth/refresh failed', error, { shelf: args.shelf, method: args.method });
		return json({ error: 'Failed to refresh Kobo auth' }, { status: 500 });
	}
}

export const GET: RequestHandler = async ({ params }) =>
	handleRefreshRequest({ shelf: params.shelf, method: 'GET' });

export const POST: RequestHandler = async ({ params }) =>
	handleRefreshRequest({ shelf: params.shelf, method: 'POST' });
