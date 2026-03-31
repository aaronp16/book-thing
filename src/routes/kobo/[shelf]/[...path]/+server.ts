import type { RequestHandler } from './$types';
import { assertKoboShelfExists } from '$lib/server/kobo-library.js';
import { filterKoboProxyResponseHeaders, proxyKoboStoreRequest } from '$lib/server/kobo-proxy.js';

function buildProxyPath(pathValue: string | undefined): string {
	const joined = pathValue ?? '';
	return joined.startsWith('/') ? joined : `/${joined}`;
}

async function handleProxyRequest(args: {
	method: string;
	params: { shelf: string; path?: string };
	request: Request;
	url: URL;
}): Promise<Response> {
	try {
		await assertKoboShelfExists(args.params.shelf);
		const body =
			args.method === 'GET' || args.method === 'HEAD'
				? undefined
				: Buffer.from(await args.request.arrayBuffer());
		const headers: Record<string, string> = {};
		for (const [key, value] of args.request.headers.entries()) {
			if (key.toLowerCase() === 'host') continue;
			headers[key] = value;
		}

		const proxied = await proxyKoboStoreRequest({
			method: args.method,
			pathname: buildProxyPath(args.params.path),
			search: args.url.search,
			headers,
			body
		});

		return new Response(new Uint8Array(proxied.body), {
			status: proxied.status,
			headers: filterKoboProxyResponseHeaders(proxied.headers)
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Kobo shelf not found')) {
			return new Response('Shelf not found', { status: 404 });
		}

		console.error('[kobo proxy] Error:', error);
		return new Response('{}', {
			status: 502,
			headers: {
				'Content-Type': 'application/json; charset=utf-8'
			}
		});
	}
}

export const GET: RequestHandler = async ({ params, request, url }) =>
	handleProxyRequest({ method: 'GET', params, request, url });

export const POST: RequestHandler = async ({ params, request, url }) =>
	handleProxyRequest({ method: 'POST', params, request, url });

export const PUT: RequestHandler = async ({ params, request, url }) =>
	handleProxyRequest({ method: 'PUT', params, request, url });

export const PATCH: RequestHandler = async ({ params, request, url }) =>
	handleProxyRequest({ method: 'PATCH', params, request, url });

export const DELETE: RequestHandler = async ({ params, request, url }) =>
	handleProxyRequest({ method: 'DELETE', params, request, url });

export const HEAD: RequestHandler = async ({ params, request, url }) =>
	handleProxyRequest({ method: 'HEAD', params, request, url });
