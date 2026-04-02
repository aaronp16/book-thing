import * as http from 'http';
import * as https from 'https';

const KOBO_STORE_BASE_URL = 'https://storeapi.kobo.com';

export interface KoboProxyResponse {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

export function buildKoboStoreUrl(pathname: string, search: string): string {
	return `${KOBO_STORE_BASE_URL}${pathname}${search}`;
}

export async function proxyKoboStoreRequest(options: {
	method: string;
	pathname: string;
	search?: string;
	headers?: Record<string, string>;
	body?: Buffer;
}): Promise<KoboProxyResponse> {
	const url = buildKoboStoreUrl(options.pathname, options.search ?? '');
	return await new Promise((resolve, reject) => {
		https
			.request(
				url,
				{
					method: options.method,
					headers: options.headers
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
					response.on('end', () => {
						const headers: Record<string, string> = {};
						for (const [key, value] of Object.entries(response.headers)) {
							if (typeof value === 'string') headers[key] = value;
						}
						resolve({
							status: response.statusCode ?? 502,
							headers,
							body: Buffer.concat(chunks)
						});
					});
					response.on('error', reject);
				}
			)
			.on('error', reject)
			.end(options.body);
	});
}

export async function fetchKoboStoreJson(pathname: string): Promise<unknown> {
	const response = await proxyKoboStoreRequest({ method: 'GET', pathname });
	return JSON.parse(response.body.toString('utf8'));
}

export function filterKoboProxyResponseHeaders(
	headers: Record<string, string>
): Record<string, string> {
	const filtered = { ...headers };
	for (const header of ['connection', 'content-encoding', 'content-length', 'transfer-encoding']) {
		delete filtered[header];
	}
	return filtered;
}
