import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { logKoboError, logKoboRequest } from '$lib/server/kobo-logging.js';
import { fetchKoboStoreJson } from '$lib/server/kobo-proxy.js';
import { createKoboShelfNotFoundJsonResponse, isKoboShelfError } from '$lib/server/kobo-routes.js';
import { createKoboResourcePayload } from '$lib/server/kobo-resources.js';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const shelf = await assertKoboShelfExists(params.shelf);
		logKoboRequest('initialization', { shelf: shelf.name, path: url.pathname });
		let baseResources: Record<string, unknown> | undefined;
		try {
			const storePayload = await fetchKoboStoreJson('/v1/initialization');
			if (
				storePayload &&
				typeof storePayload === 'object' &&
				'Resources' in storePayload &&
				storePayload.Resources &&
				typeof storePayload.Resources === 'object'
			) {
				baseResources = { ...(storePayload.Resources as Record<string, unknown>) };
			}
		} catch (error) {
			logKoboError('initialization base resource fetch failed', error, {
				shelf: shelf.name,
				path: url.pathname
			});
		}
		const payload = createKoboResourcePayload({
			baseUrl: url.origin,
			shelf,
			baseResources
		});

		return json(payload, {
			headers: {
				'x-kobo-apitoken': 'e30='
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			return createKoboShelfNotFoundJsonResponse();
		}

		logKoboError('initialization failed', error, { shelf: params.shelf, path: url.pathname });
		return json({ error: 'Failed to initialize Kobo sync' }, { status: 500 });
	}
};
