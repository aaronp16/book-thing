import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { createKoboShelfNotFoundJsonResponse, isKoboShelfError } from '$lib/server/kobo-routes.js';
import { createKoboResourcePayload } from '$lib/server/kobo-resources.js';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const shelf = await assertKoboShelfExists(params.shelf);
		const payload = createKoboResourcePayload({
			baseUrl: url.origin,
			shelf
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

		console.error('[kobo initialization] Error:', error);
		return json({ error: 'Failed to initialize Kobo sync' }, { status: 500 });
	}
};
