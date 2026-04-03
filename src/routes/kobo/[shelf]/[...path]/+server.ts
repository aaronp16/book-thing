import type { RequestHandler } from './$types';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { logKoboRequest, logKoboWarn } from '$lib/server/kobo-logging.js';
import { isKoboShelfError } from '$lib/server/kobo-routes.js';

const KOBO_STORE_BASE_URL = 'https://storeapi.kobo.com';

function buildStorePath(pathValue: string | undefined): string {
	const joined = pathValue ?? '';
	return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * Catch-all route for unhandled Kobo API paths.
 *
 * Follows calibre-web's approach:
 * - GET/HEAD requests: 307 redirect to storeapi.kobo.com so the device can
 *   talk to the store directly (with its own auth tokens).
 * - Other methods: return empty JSON {} with 200 (the device doesn't need
 *   real responses from unhandled endpoints to proceed with library sync).
 */
async function handleCatchAll(args: {
	method: string;
	params: { shelf: string; path?: string };
	url: URL;
}): Promise<Response> {
	try {
		await assertKoboShelfExists(args.params.shelf);
		const storePath = buildStorePath(args.params.path);

		logKoboRequest('catch-all', {
			shelf: args.params.shelf,
			method: args.method,
			path: storePath,
			search: args.url.search
		});

		if (args.method === 'GET' || args.method === 'HEAD') {
			const storeUrl = `${KOBO_STORE_BASE_URL}${storePath}${args.url.search}`;
			logKoboRequest('catch-all redirect', {
				shelf: args.params.shelf,
				method: args.method,
				path: storePath,
				redirectTo: storeUrl
			});
			return new Response(null, {
				status: 307,
				headers: {
					Location: storeUrl
				}
			});
		}

		// Non-GET methods: return empty JSON
		logKoboRequest('catch-all empty response', {
			shelf: args.params.shelf,
			method: args.method,
			path: storePath
		});
		return new Response('{}', {
			status: 200,
			headers: {
				'Content-Type': 'application/json; charset=utf-8'
			}
		});
	} catch (error) {
		if (isKoboShelfError(error)) {
			logKoboWarn('catch-all shelf not found', {
				shelf: args.params.shelf,
				method: args.method,
				path: buildStorePath(args.params.path)
			});
			return new Response('Shelf not found', { status: 404 });
		}

		// For any unexpected error, return empty JSON rather than failing
		logKoboWarn('catch-all error', {
			shelf: args.params.shelf,
			method: args.method,
			path: buildStorePath(args.params.path),
			error: error instanceof Error ? error.message : String(error)
		});
		return new Response('{}', {
			status: 200,
			headers: {
				'Content-Type': 'application/json; charset=utf-8'
			}
		});
	}
}

export const GET: RequestHandler = async ({ params, url }) =>
	handleCatchAll({ method: 'GET', params, url });

export const POST: RequestHandler = async ({ params, url }) =>
	handleCatchAll({ method: 'POST', params, url });

export const PUT: RequestHandler = async ({ params, url }) =>
	handleCatchAll({ method: 'PUT', params, url });

export const PATCH: RequestHandler = async ({ params, url }) =>
	handleCatchAll({ method: 'PATCH', params, url });

export const DELETE: RequestHandler = async ({ params, url }) =>
	handleCatchAll({ method: 'DELETE', params, url });

export const HEAD: RequestHandler = async ({ params, url }) =>
	handleCatchAll({ method: 'HEAD', params, url });
