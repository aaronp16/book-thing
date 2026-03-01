/**
 * Calibre-Web API client
 *
 * Handles authentication and book uploads via Calibre-Web's web interface.
 * Uses session cookie auth (the only auth mechanism available for uploads).
 *
 * Requires in Calibre-Web admin:
 *   - Admin → Edit Basic Configuration → Feature Configuration → Enable Uploads ✓
 *   - Admin → Edit User → Upload permission ✓
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

/** Session cookie from Calibre-Web login */
let sessionCookie: string | null = null;

function getBaseUrl(): string {
	return env.CALIBRE_WEB_URL.replace(/\/$/, '');
}

/**
 * Login to Calibre-Web and store the session cookie.
 * Calibre-Web uses Flask-WTF CSRF protection, so we must first GET the login
 * page to extract the csrf_token hidden field, then POST it back.
 */
async function login(): Promise<void> {
	const baseUrl = getBaseUrl();

	// Step 1: GET the login page to obtain CSRF token and initial session cookie
	console.log(`[calibre] Fetching login page for CSRF token: ${baseUrl}/login`);
	const getResponse = await fetch(`${baseUrl}/login`, { method: 'GET' });
	console.log(`[calibre] Login page response: ${getResponse.status}`);

	const html = await getResponse.text();
	const csrfMatch = html.match(/name="csrf_token"[^>]*value="([^"]+)"/);
	if (!csrfMatch) {
		throw new Error(`Calibre-Web: could not find csrf_token in login page (status ${getResponse.status})`);
	}
	const csrfToken = csrfMatch[1];
	console.log(`[calibre] Got CSRF token: ${csrfToken.slice(0, 10)}...`);

	// Capture the initial session cookie from the GET response (required for CSRF validation)
	const getCookie = getResponse.headers.get('set-cookie');
	const initialSession = getCookie?.match(/session=([^;]+)/)?.[1];
	console.log(`[calibre] Initial session cookie: ${initialSession ? 'present' : '(none)'}`);

	// Step 2: POST login with CSRF token
	const url = `${baseUrl}/login`;
	console.log(`[calibre] Logging in to ${url} as "${env.CALIBRE_WEB_USERNAME}"...`);

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...(initialSession ? { 'Cookie': `session=${initialSession}` } : {})
		},
		body: new URLSearchParams({
			username: env.CALIBRE_WEB_USERNAME,
			password: env.CALIBRE_WEB_PASSWORD,
			next: '/',
			csrf_token: csrfToken
		}),
		redirect: 'manual'
	});

	console.log(`[calibre] Login response: ${response.status} ${response.statusText}`);

	const setCookie = response.headers.get('set-cookie');
	console.log(`[calibre] Set-Cookie header: ${setCookie ?? '(none)'}`);

	if (!setCookie) {
		throw new Error(`Calibre-Web login failed: no Set-Cookie header (status ${response.status})`);
	}

	const match = setCookie.match(/session=([^;]+)/);
	if (!match) {
		throw new Error(`Calibre-Web login failed: no session= in Set-Cookie: ${setCookie}`);
	}

	sessionCookie = match[1];
	console.log('[calibre] Logged in successfully');
}

/**
 * Upload a book file to Calibre-Web.
 *
 * Calibre-Web extracts title/author/metadata automatically from the file's
 * embedded metadata (EPUB OPF, PDF info, etc.) — no need to pass them separately.
 *
 * @param filePath - Absolute path to the ebook file to upload
 * @returns The Calibre-Web book URL (e.g. /book/42)
 */
export async function uploadBookToCalibre(filePath: string): Promise<string> {
	if (!env.CALIBRE_WEB_URL) {
		console.warn('[calibre] CALIBRE_WEB_URL not set — skipping upload');
		throw new Error('CALIBRE_WEB_URL is not configured');
	}

	console.log(`[calibre] Starting upload: ${filePath}`);

	// Login if we don't have a session
	if (!sessionCookie) {
		await login();
	} else {
		console.log('[calibre] Reusing existing session cookie');
	}

	// Fetch the upload page to get a fresh CSRF token for the upload form
	console.log(`[calibre] Fetching upload page for CSRF token...`);
	const uploadPageResponse = await fetch(`${getBaseUrl()}/upload`, {
		method: 'GET',
		headers: { 'Cookie': `session=${sessionCookie}` },
		redirect: 'manual'
	});

	// If redirected to login, session expired — re-login and retry
	if (uploadPageResponse.status === 302 || (uploadPageResponse.redirected && uploadPageResponse.url.includes('/login'))) {
		console.log('[calibre] Session expired fetching upload page, re-logging in...');
		sessionCookie = null;
		await login();
		return uploadBookToCalibre(filePath);
	}

	console.log(`[calibre] Upload page response: ${uploadPageResponse.status}`);
	const uploadPageHtml = await uploadPageResponse.text();
	const uploadCsrfMatch = uploadPageHtml.match(/name="csrf_token"[^>]*value="([^"]+)"/);
	if (!uploadCsrfMatch) {
		throw new Error(`Calibre-Web: could not find csrf_token in upload page (status ${uploadPageResponse.status})`);
	}
	const uploadCsrfToken = uploadCsrfMatch[1];
	console.log(`[calibre] Got upload CSRF token: ${uploadCsrfToken.slice(0, 10)}...`);

	let fileBuffer: Buffer;
	try {
		fileBuffer = await fs.readFile(filePath);
		console.log(`[calibre] Read file: ${filePath} (${fileBuffer.length} bytes)`);
	} catch (err) {
		throw new Error(`[calibre] Could not read file at ${filePath}: ${err}`);
	}

	const filename = path.basename(filePath);
	const ext = path.extname(filename).toLowerCase().slice(1); // e.g. "epub"
	console.log(`[calibre] Uploading "${filename}" (format: ${ext}) to ${getBaseUrl()}/upload`);

	// Build multipart body manually — same approach as qbittorrent-client.ts
	const boundary = `----book-thing-calibre-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const CRLF = '\r\n';

	const parts: Buffer[] = [];

	// CSRF token field must come first
	parts.push(Buffer.from(
		`--${boundary}${CRLF}` +
		`Content-Disposition: form-data; name="csrf_token"${CRLF}` +
		CRLF +
		uploadCsrfToken + CRLF
	));

	// File field
	parts.push(Buffer.from(
		`--${boundary}${CRLF}` +
		`Content-Disposition: form-data; name="btn-upload"; filename="${filename}"${CRLF}` +
		`Content-Type: application/${ext}${CRLF}` +
		CRLF
	));
	parts.push(fileBuffer);
	parts.push(Buffer.from(CRLF));
	parts.push(Buffer.from(`--${boundary}--${CRLF}`));

	const body = Buffer.concat(parts);

	const response = await fetch(`${getBaseUrl()}/upload`, {
		method: 'POST',
		headers: {
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
			'Cookie': `session=${sessionCookie}`,
			'X-Requested-With': 'XMLHttpRequest'
		},
		body
	});

	console.log(`[calibre] Upload response: ${response.status} ${response.statusText}`);
	console.log(`[calibre] Response URL: ${response.url}`);
	console.log(`[calibre] Redirected: ${response.redirected}`);

	// Session expired — re-login and retry once
	if (response.status === 401 || (response.redirected && response.url.includes('/login'))) {
		console.log('[calibre] Session expired, re-logging in...');
		sessionCookie = null;
		await login();
		return uploadBookToCalibre(filePath);
	}

	const responseText = await response.text();
	console.log(`[calibre] Response body: ${responseText.slice(0, 500)}`);

	if (!response.ok) {
		throw new Error(`Calibre-Web upload failed: ${response.status} ${responseText.slice(0, 200)}`);
	}

	let result: { location?: string; error?: string };
	try {
		result = JSON.parse(responseText);
	} catch {
		throw new Error(`Calibre-Web upload returned non-JSON: ${responseText.slice(0, 200)}`);
	}

	if (result.error) {
		throw new Error(`Calibre-Web upload error: ${result.error}`);
	}

	const location = result.location || '/';
	console.log(`[calibre] Uploaded successfully: ${filename} → ${location}`);
	return location;
}

