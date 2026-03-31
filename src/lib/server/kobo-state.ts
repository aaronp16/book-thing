import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

const KOBO_STATE_DIR = path.join(env.BOOKS_DIR, '.kobo-state');
const KOBO_STATE_FILE = path.join(KOBO_STATE_DIR, 'reading-state.json');

export function getKoboStateFilePath(): string {
	return KOBO_STATE_FILE;
}

export interface KoboReadingStateRecord {
	id: string;
	status: string | null;
	timesStartedReading: number | null;
	lastTimeStartedReading: string | null;
	progressPercent: number | null;
	contentSourceProgressPercent: number | null;
	location: {
		value: string | null;
		type: string | null;
		source: string | null;
	} | null;
	statistics: {
		spentReadingMinutes: number | null;
		remainingTimeMinutes: number | null;
	} | null;
	updatedAt: string;
}

export interface KoboSyncCursor {
	shelf: string;
	booksLastModified: string | null;
	readingStateLastModified: string | null;
	tagsLastModified: string | null;
	archiveLastModified: string | null;
	booksLastCreated: string | null;
}

interface KoboStateStore {
	readingStates: Record<string, KoboReadingStateRecord>;
	syncCursors: Record<string, KoboSyncCursor>;
}

const EMPTY_STORE: KoboStateStore = {
	readingStates: {},
	syncCursors: {}
};

function sanitizeReadingStateRecord(record: KoboReadingStateRecord): KoboReadingStateRecord {
	return {
		id: record.id,
		status: record.status ?? null,
		timesStartedReading: record.timesStartedReading ?? null,
		lastTimeStartedReading: record.lastTimeStartedReading ?? null,
		progressPercent: record.progressPercent ?? null,
		contentSourceProgressPercent: record.contentSourceProgressPercent ?? null,
		location: record.location
			? {
					value: record.location.value ?? null,
					type: record.location.type ?? null,
					source: record.location.source ?? null
				}
			: null,
		statistics: record.statistics
			? {
					spentReadingMinutes: record.statistics.spentReadingMinutes ?? null,
					remainingTimeMinutes: record.statistics.remainingTimeMinutes ?? null
				}
			: null,
		updatedAt: record.updatedAt
	};
}

function sanitizeSyncCursor(cursor: KoboSyncCursor): KoboSyncCursor {
	return {
		shelf: cursor.shelf,
		booksLastModified: cursor.booksLastModified ?? null,
		readingStateLastModified: cursor.readingStateLastModified ?? null,
		tagsLastModified: cursor.tagsLastModified ?? null,
		archiveLastModified: cursor.archiveLastModified ?? null,
		booksLastCreated: cursor.booksLastCreated ?? null
	};
}

function sanitizeStore(parsed: Partial<KoboStateStore>): KoboStateStore {
	const readingStates: Record<string, KoboReadingStateRecord> = {};
	for (const [id, record] of Object.entries(parsed.readingStates ?? {})) {
		if (!record) continue;
		readingStates[id] = sanitizeReadingStateRecord(record as KoboReadingStateRecord);
	}

	const syncCursors: Record<string, KoboSyncCursor> = {};
	for (const [shelf, cursor] of Object.entries(parsed.syncCursors ?? {})) {
		if (!cursor) continue;
		syncCursors[shelf] = sanitizeSyncCursor(cursor as KoboSyncCursor);
	}

	return { readingStates, syncCursors };
}

async function ensureStateStore(): Promise<void> {
	await fs.mkdir(KOBO_STATE_DIR, { recursive: true });
	try {
		await fs.access(KOBO_STATE_FILE);
	} catch {
		await fs.writeFile(KOBO_STATE_FILE, JSON.stringify(EMPTY_STORE, null, 2));
	}
}

async function readStore(): Promise<KoboStateStore> {
	await ensureStateStore();
	try {
		const raw = await fs.readFile(KOBO_STATE_FILE, 'utf8');
		const parsed = JSON.parse(raw) as Partial<KoboStateStore>;
		return sanitizeStore(parsed);
	} catch {
		return { ...EMPTY_STORE };
	}
}

async function writeStore(store: KoboStateStore): Promise<void> {
	await ensureStateStore();
	await fs.writeFile(KOBO_STATE_FILE, JSON.stringify(store, null, 2));
}

export async function getKoboReadingState(id: string): Promise<KoboReadingStateRecord | null> {
	const store = await readStore();
	return store.readingStates[id] ?? null;
}

export async function listKoboReadingStates(): Promise<KoboReadingStateRecord[]> {
	const store = await readStore();
	return Object.values(store.readingStates).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function upsertKoboReadingState(
	id: string,
	patch: Partial<Omit<KoboReadingStateRecord, 'id' | 'updatedAt'>>
): Promise<KoboReadingStateRecord> {
	const store = await readStore();
	const existing = store.readingStates[id];
	const next: KoboReadingStateRecord = {
		id,
		status: patch.status ?? existing?.status ?? null,
		timesStartedReading: patch.timesStartedReading ?? existing?.timesStartedReading ?? null,
		lastTimeStartedReading:
			patch.lastTimeStartedReading ?? existing?.lastTimeStartedReading ?? null,
		progressPercent: patch.progressPercent ?? existing?.progressPercent ?? null,
		contentSourceProgressPercent:
			patch.contentSourceProgressPercent ?? existing?.contentSourceProgressPercent ?? null,
		location: patch.location ?? existing?.location ?? null,
		statistics: patch.statistics ?? existing?.statistics ?? null,
		updatedAt: new Date().toISOString()
	};
	store.readingStates[id] = sanitizeReadingStateRecord(next);
	await writeStore(store);
	return store.readingStates[id];
}

export async function getKoboSyncCursor(shelf: string): Promise<KoboSyncCursor> {
	const store = await readStore();
	return (
		store.syncCursors[shelf] ?? {
			shelf,
			booksLastModified: null,
			readingStateLastModified: null,
			tagsLastModified: null,
			archiveLastModified: null,
			booksLastCreated: null
		}
	);
}

export async function listKoboSyncCursors(): Promise<KoboSyncCursor[]> {
	const store = await readStore();
	return Object.values(store.syncCursors).sort((a, b) => a.shelf.localeCompare(b.shelf));
}

export async function updateKoboSyncCursor(
	shelf: string,
	patch: Partial<Omit<KoboSyncCursor, 'shelf'>>
): Promise<KoboSyncCursor> {
	const store = await readStore();
	const existing =
		store.syncCursors[shelf] ??
		({
			shelf,
			booksLastModified: null,
			readingStateLastModified: null,
			tagsLastModified: null,
			archiveLastModified: null,
			booksLastCreated: null
		} as KoboSyncCursor);
	const next: KoboSyncCursor = {
		...existing,
		...patch,
		shelf
	};
	store.syncCursors[shelf] = sanitizeSyncCursor(next);
	await writeStore(store);
	return store.syncCursors[shelf];
}
