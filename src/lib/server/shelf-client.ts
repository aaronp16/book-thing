/**
 * Calibre-Web shelf integration — writes directly to Calibre-Web's app.db
 *
 * Calibre-Web stores user-specific shelves in its own SQLite database (app.db).
 * This is separate from Calibre's metadata.db.
 *
 * Structure:
 *   /config/
 *     app.db                       ← Calibre-Web application database
 *
 * Tables used:
 *   - shelf: user-specific collections (id, name, user_id, ...)
 *   - book_shelf_link: many-to-many linking books to shelves (book_id, shelf, order, date_added)
 *
 * We hardcode user_id=1 (admin user) for all shelf operations.
 */

import * as path from 'path';

const APP_DB_PATH = '/config/app.db';
const USER_ID = 1; // Hardcoded to admin user

// Lazy-init database connection
let _db: any = null;

async function getShelfDb() {
	if (_db) return _db;

	try {
		const { DatabaseSync } = await import('node:sqlite');
		_db = new DatabaseSync(APP_DB_PATH);
		return _db;
	} catch (error) {
		console.error('Failed to connect to Calibre-Web app.db:', error);
		throw new Error('Shelf database not available');
	}
}

export interface Shelf {
	id: number;
	name: string;
	bookCount?: number;
}

/**
 * Get all shelves (for all users - since you're the only one using this)
 */
export async function listShelves(): Promise<Shelf[]> {
	const db = await getShelfDb();

	const stmt = db.prepare(`
		SELECT 
			s.id,
			s.name,
			(SELECT COUNT(*) FROM book_shelf_link WHERE shelf = s.id) as bookCount
		FROM shelf s
		ORDER BY s.name
	`);

	const rows = stmt.all();
	return rows.map((row: any) => ({
		id: row.id,
		name: row.name,
		bookCount: row.bookCount
	}));
}

/**
 * Add a book to a specific shelf
 * @param bookId - The book ID from Calibre's metadata.db
 * @param shelfId - The shelf ID from Calibre-Web's app.db
 */
export async function addBookToShelf(bookId: number, shelfId: number): Promise<void> {
	const db = await getShelfDb();

	// Check if the book is already on this shelf
	const checkStmt = db.prepare(`
		SELECT id FROM book_shelf_link 
		WHERE book_id = ? AND shelf = ?
	`);
	const existing = checkStmt.get(bookId, shelfId);

	if (existing) {
		// Book already on this shelf, skip
		return;
	}

	// Get the next order value for this shelf
	const orderStmt = db.prepare(`
		SELECT COALESCE(MAX("order"), 0) + 1 as next_order
		FROM book_shelf_link
		WHERE shelf = ?
	`);
	const { next_order } = orderStmt.get(shelfId) as { next_order: number };

	// Insert the book-shelf link
	const insertStmt = db.prepare(`
		INSERT INTO book_shelf_link (book_id, "order", shelf, date_added)
		VALUES (?, ?, ?, datetime('now'))
	`);
	insertStmt.run(bookId, next_order, shelfId);
}

/**
 * Add a book to multiple shelves
 * @param bookId - The book ID from Calibre's metadata.db
 * @param shelfIds - Array of shelf IDs to add the book to
 */
export async function addBookToShelves(bookId: number, shelfIds: number[]): Promise<void> {
	if (!shelfIds || shelfIds.length === 0) {
		return;
	}

	// Add to each shelf sequentially
	for (const shelfId of shelfIds) {
		await addBookToShelf(bookId, shelfId);
	}
}

/**
 * Get all book IDs on a specific shelf
 * @param shelfId - The shelf ID
 * @returns Array of book IDs
 */
export async function getBooksOnShelf(shelfId: number): Promise<number[]> {
	const db = await getShelfDb();

	const stmt = db.prepare(`
		SELECT book_id
		FROM book_shelf_link
		WHERE shelf = ?
		ORDER BY "order"
	`);

	const rows = stmt.all(shelfId);
	return rows.map((row: any) => row.book_id);
}

/**
 * Remove a book from a specific shelf
 * @param bookId - The book ID
 * @param shelfId - The shelf ID
 */
export async function removeBookFromShelf(bookId: number, shelfId: number): Promise<void> {
	const db = await getShelfDb();

	const stmt = db.prepare(`
		DELETE FROM book_shelf_link
		WHERE book_id = ? AND shelf = ?
	`);
	stmt.run(bookId, shelfId);
}

/**
 * Get all shelf IDs that contain a specific book
 * @param bookId - The book ID
 * @returns Array of shelf IDs
 */
export async function getShelvesForBook(bookId: number): Promise<number[]> {
	const db = await getShelfDb();

	const stmt = db.prepare(`
		SELECT shelf
		FROM book_shelf_link
		WHERE book_id = ?
	`);

	const rows = stmt.all(bookId);
	return rows.map((row: any) => row.shelf);
}
