import type { KoboShelf } from './kobo-library.js';

export interface KoboResourcePayload {
	Resources: Record<string, unknown>;
}

function stripTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function createKoboResourcePayload(options: {
	baseUrl: string;
	shelf: KoboShelf;
	baseResources?: Record<string, unknown>;
}): KoboResourcePayload {
	const baseUrl = stripTrailingSlash(options.baseUrl);
	const shelfBase = `${baseUrl}/kobo/${options.shelf.encodedName}`;
	const resources = {
		...(options.baseResources ?? {})
	};

	resources.library_sync = `${shelfBase}/v1/library/sync`;
	resources.image_host = baseUrl;
	resources.image_url_template = `${shelfBase}/covers/{ImageId}/image?width={Width}&height={Height}&isGreyscale=false`;
	resources.image_url_quality_template = `${shelfBase}/covers/{ImageId}/image?width={Width}&height={Height}&quality={Quality}&isGreyscale={IsGreyscale}`;
	resources.device_auth = `${shelfBase}/v1/auth/device`;
	resources.device_refresh = `${shelfBase}/v1/auth/refresh`;
	resources.auth = `${shelfBase}/v1/auth/device`;
	resources.refresh_auth = `${shelfBase}/v1/auth/refresh`;
	resources.initialization = `${shelfBase}/v1/initialization`;

	return {
		Resources: resources
	};
}
