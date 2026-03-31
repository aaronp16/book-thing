import type { KoboShelf } from './kobo-library.js';

export interface KoboResourcePayload {
	Resources: Record<string, string>;
}

function stripTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function createKoboResourcePayload(options: {
	baseUrl: string;
	shelf: KoboShelf;
}): KoboResourcePayload {
	const baseUrl = stripTrailingSlash(options.baseUrl);
	const shelfBase = `${baseUrl}/kobo/${options.shelf.encodedName}`;
	return {
		Resources: {
			library_sync: `${shelfBase}/v1/library/sync`,
			image_host: baseUrl,
			image_url_template: `${shelfBase}/covers/{ImageId}/image`,
			image_url_quality_template: `${shelfBase}/covers/{ImageId}/image?width={width}&height={height}&quality={Quality}`,
			auth: `${shelfBase}/v1/auth/device`,
			refresh_auth: `${shelfBase}/v1/auth/refresh`,
			initialization: `${shelfBase}/v1/initialization`
		}
	};
}
