/**
 * Environment configuration with defaults
 *
 * Uses SvelteKit's $env/dynamic/private for .env loading in dev,
 * and falls back to process.env for production (adapter-node / Docker).
 */

import { env as svelteEnv } from '$env/dynamic/private';

export const env = {
	/** MyAnonamouse session cookie */
	MAM_ID: svelteEnv.MAM_ID || '',
	/** MyAnonamouse user ID */
	MAM_UID: svelteEnv.MAM_UID || '',
	/** Book download directory (for library scanning and Calibre-Web library in prod) */
	BOOKS_DIR: svelteEnv.BOOKS_DIR || './books',
	/** Optional source Calibre library directory for one-time imports */
	CALIBRE_DIR: svelteEnv.CALIBRE_DIR || '',
	/** Optional Calibre-Web app.db path for importing shelf mappings */
	CALIBRE_APP_DB_PATH: svelteEnv.CALIBRE_APP_DB_PATH || '/config/app.db',
	/** qBittorrent WebUI URL (e.g., http://localhost:8080) */
	QB_URL: svelteEnv.QB_URL || 'http://localhost:8080',
	/** qBittorrent WebUI username */
	QB_USERNAME: svelteEnv.QB_USERNAME || 'admin',
	/** qBittorrent WebUI password */
	QB_PASSWORD: svelteEnv.QB_PASSWORD || '',
	/** Category to use for book downloads in qBittorrent */
	QB_CATEGORY: svelteEnv.QB_CATEGORY || 'books',
	/** Save path in qBittorrent (if different from default) */
	QB_SAVE_PATH: svelteEnv.QB_SAVE_PATH || ''
};
