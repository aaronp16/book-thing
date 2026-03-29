import * as fs from 'fs/promises';
import * as path from 'path';
import { env } from './env.js';

const IMPORTED_SHELF_NAME = 'Imported';
const FORMAT_PRIORITY = ['epub', 'azw3', 'mobi', 'azw', 'pdf', 'cbz', 'cbr', 'txt'];
const formatPriority = new Map(FORMAT_PRIORITY.map((format, index) => [format, index]));

interface CalibreBookRow {
	bookId: number;
	calibrePath: string;
	fileBaseName: string;
	format: string;
	author: string;
	title: string;
}

export interface CalibreImportStatus {
	available: boolean;
	hasMetadataDb: boolean;
	hasShelfDb: boolean;
	sourceDir: string | null;
}

export interface CalibreImportSummary {
	importedBooks: number;
	copiedFiles: number;
	copiedCovers: number;
	skippedFiles: number;
	failedFiles: number;
	importedShelves: number;
	unshelvedBooks: number;
	hasShelfDb: boolean;
	sourceDir: string;
}

export interface CalibreImportPreview {
	importedBooks: number;
	plannedCopies: number;
	plannedShelves: number;
	unshelvedBooks: number;
	hasShelfDb: boolean;
	sourceDir: string;
	shelfBreakdown: Array<{
		shelfName: string;
		bookCount: number;
	}>;
}

interface PlannedImportCopy {
	bookId: number;
	shelfName: string;
	sourceFile: string;
	destDir: string;
	destFile: string;
	sourceCover: string;
}

function sanitizeSegment(value: string): string {
	return value
		.replace(/[\\/:*?"<>|]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
}

function getConfiguredCalibreDir(): string | null {
	if (env.CALIBRE_DIR.trim()) {
		return path.resolve(env.CALIBRE_DIR);
	}
	return null;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
}

async function getMetadataDb() {
	const sourceDir = getConfiguredCalibreDir();
	if (!sourceDir) {
		throw new Error('CALIBRE_DIR is not configured');
	}
	const dbPath = path.join(sourceDir, 'metadata.db');
	const { DatabaseSync } = await import('node:sqlite');
	return new DatabaseSync(dbPath);
}

async function getShelfDb() {
	if (!(await fileExists(env.CALIBRE_APP_DB_PATH))) {
		return null;
	}
	const { DatabaseSync } = await import('node:sqlite');
	return new DatabaseSync(env.CALIBRE_APP_DB_PATH);
}

function chooseBetterFormat(
	current: CalibreBookRow | undefined,
	candidate: CalibreBookRow
): CalibreBookRow {
	if (!current) return candidate;
	const currentPriority = formatPriority.get(current.format) ?? Number.MAX_SAFE_INTEGER;
	const candidatePriority = formatPriority.get(candidate.format) ?? Number.MAX_SAFE_INTEGER;
	return candidatePriority < currentPriority ? candidate : current;
}

async function listCalibreBooks(): Promise<CalibreBookRow[]> {
	const db = await getMetadataDb();
	const rows = db
		.prepare(
			`
			SELECT
				b.id AS bookId,
				b.path AS calibrePath,
				d.name AS fileBaseName,
				LOWER(d.format) AS format,
				b.title AS title,
				COALESCE(
					(
						SELECT a.name
						FROM authors a
						JOIN books_authors_link bal ON bal.author = a.id
						WHERE bal.book = b.id
						ORDER BY a.id
						LIMIT 1
					),
					'Unknown'
				) AS author
			FROM books b
			JOIN data d ON d.book = b.id
			ORDER BY b.id
		`
		)
		.all() as unknown as CalibreBookRow[];

	const bestByBookId = new Map<number, CalibreBookRow>();
	for (const row of rows) {
		bestByBookId.set(row.bookId, chooseBetterFormat(bestByBookId.get(row.bookId), row));
	}

	return Array.from(bestByBookId.values());
}

async function getShelfNamesByBookId(): Promise<Map<number, string[]>> {
	const db = await getShelfDb();
	if (!db) return new Map();

	const rows = db
		.prepare(
			`
			SELECT
				bsl.book_id AS bookId,
				s.name AS shelfName
			FROM book_shelf_link bsl
			JOIN shelf s ON s.id = bsl.shelf
			ORDER BY s.name
		`
		)
		.all() as unknown as Array<{ bookId: number; shelfName: string }>;

	const shelfMap = new Map<number, string[]>();
	for (const row of rows) {
		const existing = shelfMap.get(row.bookId) ?? [];
		if (!existing.includes(row.shelfName)) {
			existing.push(row.shelfName);
			shelfMap.set(row.bookId, existing);
		}
	}

	return shelfMap;
}

export async function getCalibreImportStatus(): Promise<CalibreImportStatus> {
	const sourceDir = getConfiguredCalibreDir();
	if (!sourceDir) {
		return {
			available: false,
			hasMetadataDb: false,
			hasShelfDb: false,
			sourceDir: null
		};
	}

	const hasMetadataDb = await fileExists(path.join(sourceDir, 'metadata.db'));
	const hasShelfDb = await fileExists(env.CALIBRE_APP_DB_PATH);

	return {
		available: hasMetadataDb,
		hasMetadataDb,
		hasShelfDb,
		sourceDir
	};
}

async function planCalibreImport() {
	const status = await getCalibreImportStatus();
	if (!status.available || !status.sourceDir) {
		throw new Error('Calibre import is not available');
	}

	const books = await listCalibreBooks();
	const shelfNamesByBookId = await getShelfNamesByBookId();
	let unshelvedBooks = 0;
	const plannedCopies: PlannedImportCopy[] = [];
	const shelfBreakdown = new Map<string, number>();

	for (const book of books) {
		const sourceFile = path.join(
			status.sourceDir,
			book.calibrePath,
			`${book.fileBaseName}.${book.format}`
		);
		const authorDir = sanitizeSegment(
			book.calibrePath.split(path.sep)[0] || book.author || 'Unknown'
		);
		const shelfNames = shelfNamesByBookId.get(book.bookId) ?? [IMPORTED_SHELF_NAME];
		if (!shelfNamesByBookId.has(book.bookId)) {
			unshelvedBooks += 1;
		}

		for (const shelfName of shelfNames) {
			const safeShelfName = sanitizeSegment(shelfName);
			const destDir = path.join(env.BOOKS_DIR, safeShelfName, authorDir);
			const destFile = path.join(destDir, path.basename(sourceFile));
			plannedCopies.push({
				bookId: book.bookId,
				shelfName: safeShelfName,
				sourceFile,
				destDir,
				destFile,
				sourceCover: path.join(status.sourceDir, book.calibrePath, 'cover.jpg')
			});
			shelfBreakdown.set(safeShelfName, (shelfBreakdown.get(safeShelfName) ?? 0) + 1);
		}
	}

	return {
		status,
		books,
		plannedCopies,
		unshelvedBooks,
		shelfBreakdown
	};
}

export async function previewCalibreImport(): Promise<CalibreImportPreview> {
	const { status, books, plannedCopies, unshelvedBooks, shelfBreakdown } =
		await planCalibreImport();

	return {
		importedBooks: books.length,
		plannedCopies: plannedCopies.length,
		plannedShelves: shelfBreakdown.size,
		unshelvedBooks,
		hasShelfDb: status.hasShelfDb,
		sourceDir: status.sourceDir!,
		shelfBreakdown: Array.from(shelfBreakdown.entries())
			.map(([shelfName, bookCount]) => ({ shelfName, bookCount }))
			.sort((a, b) => a.shelfName.localeCompare(b.shelfName))
	};
}

export async function importFromCalibreLibrary(): Promise<CalibreImportSummary> {
	const { status, books, plannedCopies, unshelvedBooks, shelfBreakdown } =
		await planCalibreImport();

	let copiedFiles = 0;
	let copiedCovers = 0;
	let skippedFiles = 0;
	let failedFiles = 0;
	const importedShelves = new Set<string>(Array.from(shelfBreakdown.keys()));

	for (const plannedCopy of plannedCopies) {
		try {
			await fs.mkdir(plannedCopy.destDir, { recursive: true });
			try {
				await fs.access(plannedCopy.destFile);
				skippedFiles += 1;
			} catch {
				await fs.copyFile(plannedCopy.sourceFile, plannedCopy.destFile);
				copiedFiles += 1;
			}

			if (await fileExists(plannedCopy.sourceCover)) {
				const stem = path.basename(plannedCopy.destFile, path.extname(plannedCopy.destFile));
				const destCover = path.join(plannedCopy.destDir, `${stem}.cover.jpg`);
				try {
					await fs.access(destCover);
				} catch {
					await fs.copyFile(plannedCopy.sourceCover, destCover);
					copiedCovers += 1;
				}
			}
		} catch (error) {
			failedFiles += 1;
			console.error(
				`[calibre-import] Failed to import ${plannedCopy.sourceFile} to ${plannedCopy.shelfName}:`,
				error
			);
		}
	}

	return {
		importedBooks: books.length,
		copiedFiles,
		copiedCovers,
		skippedFiles,
		failedFiles,
		importedShelves: importedShelves.size,
		unshelvedBooks,
		hasShelfDb: status.hasShelfDb,
		sourceDir: status.sourceDir!
	};
}
