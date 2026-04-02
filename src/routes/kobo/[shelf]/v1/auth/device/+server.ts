import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomBytes, randomUUID } from 'node:crypto';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { createKoboShelfNotFoundJsonResponse, isKoboShelfError } from '$lib/server/kobo-routes.js';
import { logKoboError, logKoboRequest } from '$lib/server/kobo-logging.js';

function createAuthPayload(userKey: string) {
	return {
		AccessToken: randomBytes(24).toString('base64'),
		RefreshToken: randomBytes(24).toString('base64'),
		TokenType: 'Bearer',
		TrackingId: randomUUID(),
		UserKey: userKey
	};
}

async function handleAuthRequest(args: {
	shelf: string;
	method: string;
	request: Request;
}): Promise<Response> {
	try {
		const shelf = await assertKoboShelfExists(args.shelf);
		let userKey = '';
		if (args.method !== 'GET') {
			try {
				const body = await args.request.json();
				userKey = typeof body?.UserKey === 'string' ? body.UserKey : '';
			} catch {
				userKey = '';
			}
		}

		logKoboRequest('auth/device', {
			shelf: shelf.name,
			method: args.method,
			userKey
		});

		return json(createAuthPayload(userKey), {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'x-kobo-apitoken': 'e30='
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			return createKoboShelfNotFoundJsonResponse();
		}

		logKoboError('auth/device failed', error, { shelf: args.shelf, method: args.method });
		return json({ error: 'Failed to authenticate Kobo device' }, { status: 500 });
	}
}

export const GET: RequestHandler = async ({ params, request }) =>
	handleAuthRequest({ shelf: params.shelf, method: 'GET', request });

export const POST: RequestHandler = async ({ params, request }) =>
	handleAuthRequest({ shelf: params.shelf, method: 'POST', request });
