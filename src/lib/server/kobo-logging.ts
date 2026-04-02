import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

const KOBO_LOG_DIR = path.join(env.BOOKS_DIR, '.kobo-state');
const KOBO_LOG_FILE = path.join(KOBO_LOG_DIR, 'debug.log');
const MAX_LOG_BYTES = 256 * 1024;

function formatLine(level: 'info' | 'error', message: string, payload?: unknown): string {
	const timestamp = new Date().toISOString();
	const suffix = payload === undefined ? '' : ` ${safeStringify(payload)}`;
	return `${timestamp} [${level}] [kobo] ${message}${suffix}\n`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return '[unserializable]';
	}
}

async function appendKoboLogLine(line: string): Promise<void> {
	try {
		await fs.mkdir(KOBO_LOG_DIR, { recursive: true });
		await fs.appendFile(KOBO_LOG_FILE, line, 'utf8');
		const stat = await fs.stat(KOBO_LOG_FILE);
		if (stat.size <= MAX_LOG_BYTES) return;
		const raw = await fs.readFile(KOBO_LOG_FILE, 'utf8');
		const trimmed = raw.slice(-Math.floor(MAX_LOG_BYTES / 2));
		const firstNewline = trimmed.indexOf('\n');
		await fs.writeFile(
			KOBO_LOG_FILE,
			firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed,
			'utf8'
		);
	} catch {
		// Debug logging must never break request handling.
	}
}

export function getKoboDebugLogPath(): string {
	return KOBO_LOG_FILE;
}

export function logKoboRequest(message: string, details?: Record<string, unknown>) {
	const line = formatLine('info', message, details);
	console.log(line.trimEnd());
	void appendKoboLogLine(line);
}

export function logKoboError(message: string, error: unknown, details?: Record<string, unknown>) {
	const payload = details ? { details, error } : { error };
	const line = formatLine('error', message, payload);
	console.error(line.trimEnd());
	void appendKoboLogLine(line);
}
