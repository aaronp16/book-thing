import type { Handle, ServerInit } from '@sveltejs/kit';
import { startSeedboxUpdates } from '$lib/server/mam-client.js';

export const init: ServerInit = () => {
	startSeedboxUpdates();
};

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
