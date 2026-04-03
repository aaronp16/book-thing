import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { logKoboError, logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';
import { fetchKoboStoreJson } from '$lib/server/kobo-proxy.js';
import { createKoboShelfNotFoundJsonResponse, isKoboShelfError } from '$lib/server/kobo-routes.js';
import { createKoboResourcePayload } from '$lib/server/kobo-resources.js';

export const GET: RequestHandler = async ({ params, url, request }) => {
	try {
		const shelf = await assertKoboShelfExists(params.shelf);
		logKoboRequest('initialization', { shelf: shelf.name, path: url.pathname });
		let baseResources: Record<string, unknown> | undefined;
		try {
			const forwardedHeaders: Record<string, string> = {};
			for (const [key, value] of request.headers.entries()) {
				if (key.toLowerCase() === 'host') continue;
				forwardedHeaders[key] = value;
			}
			const storePayload = await fetchKoboStoreJson('/v1/initialization', forwardedHeaders);
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
		logKoboRequest('initialization resources', {
			shelf: shelf.name,
			path: url.pathname,
			usedStoreResources: Boolean(baseResources),
			overriddenKeys: [
				'library_sync',
				'image_host',
				'image_url_template',
				'image_url_quality_template',
				'device_auth',
				'device_refresh',
				'initialization'
			]
		});
		const payload = createKoboResourcePayload({
			baseUrl: url.origin,
			shelf,
			baseResources
		});

		logKoboRequest('initialization response', {
			shelf: shelf.name,
			resourceCount: Object.keys(payload.Resources).length,
			library_sync: payload.Resources.library_sync,
			image_host: payload.Resources.image_host,
			image_url_template: payload.Resources.image_url_template,
			device_auth: payload.Resources.device_auth
		});

		return json(payload, {
			headers: {
				'x-kobo-apitoken': 'e30='
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('initialization shelf not found', { shelf: params.shelf });
			return createKoboShelfNotFoundJsonResponse();
		}

		logKoboError('initialization failed', error, { shelf: params.shelf, path: url.pathname });
		return json({ error: 'Failed to initialize Kobo sync' }, { status: 500 });
	}
};
