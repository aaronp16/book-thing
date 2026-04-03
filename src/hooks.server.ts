import type { Handle } from '@sveltejs/kit';
import { logKoboRequest } from '$lib/server/kobo-logging.js';

export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith('/kobo/')) {
		const headers = Object.fromEntries(
			Array.from(event.request.headers.entries()).filter(([key]) =>
				[
					'user-agent',
					'x-kobo-userkey',
					'authorization',
					'x-forwarded-for',
					'x-forwarded-proto',
					'host'
				].includes(key.toLowerCase())
			)
		);

		logKoboRequest('incoming', {
			method: event.request.method,
			path: event.url.pathname,
			search: event.url.search,
			headers
		});
	}

	const response = await resolve(event);

	// Log response status for kobo routes to help debug download/cover failures
	if (event.url.pathname.startsWith('/kobo/')) {
		logKoboRequest('response', {
			method: event.request.method,
			path: event.url.pathname,
			status: response.status
		});
	}

	return response;
};
