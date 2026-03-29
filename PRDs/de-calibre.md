# De-Calibre

## Overview

`book-thing` currently depends on Calibre's `metadata.db` for library records and Calibre-Web's `app.db` for shelves. This PRD defines a replacement model where the filesystem is the source of truth:

- shelves are directories
- books are stored directly in those directories
- ebook files provide intrinsic metadata where possible
- optional sidecar files store cover overrides and future app-owned metadata
- no SQLite database is required for library browsing, shelf membership, or cover management

This is a personal-use homelab workflow, not a general-purpose released product. Simplicity and operability matter more than perfect normalization.

## Goals

- Remove Calibre and Calibre-Web as runtime dependencies for library management.
- Make shelves map directly to folders under `BOOKS_DIR`.
- Allow the same book to exist on multiple shelves by copying files.
- Keep metadata extraction filesystem-based.
- Support manual cover selection via external APIs and store selected covers beside the book file.
- Preserve the existing search and download flow from MyAnonamouse.
- Keep the frontend UX broadly similar where practical.

## Non-Goals

- No deduplication across shelves.
- No reading progress or status sync.
- No user-editable title or author metadata UI.
- No full Kobo cloud sync in this phase.
- No embedded cover rewriting across all ebook formats.
- No migration automation for arbitrary existing Calibre libraries unless explicitly added later.

## User Model

Single-user homelab setup. Trusted environment. No multi-user permissions model required.

## Problem Statement

The current library model is tightly coupled to Calibre and Calibre-Web:

- library listing reads Calibre `metadata.db`
- shelf membership reads Calibre-Web `app.db`
- book updates and deletes depend on numeric Calibre book IDs
- cover serving depends on Calibre path resolution
- completed downloads are copied into the library and then registered in Calibre

This creates unnecessary complexity for a personal system where:

- duplicates are acceptable
- shelves can be represented physically
- reading state is not needed
- a simple filesystem-backed model is preferred over normalized relational data

## Product Principles

- Filesystem is the source of truth.
- Shelf membership is represented by file placement, not metadata links.
- Path-based identity is preferred over synthetic database IDs.
- Sidecars are acceptable when format-native metadata writing is brittle.
- Favor simple personal-use behavior over perfect data modeling.

## Phase 1 Frozen Decisions

The following decisions are locked for phase 1 implementation unless explicitly revised later:

- Each top-level directory under `BOOKS_DIR` is a shelf.
- Books are stored under `BOOKS_DIR/<shelf>/<author>/<bookfile>`.
- Author subdirectories are part of the intended phase 1 layout, not just a temporary compatibility behavior.
- Each physical file instance belongs to exactly one shelf.
- The same book may exist in multiple shelves by copying the file.
- No deduplication is required across shelves.
- The canonical library item identity is a path-based ID derived from the shelf-relative file path.
- The path-based ID will be URL-safe and must always be decoded and validated server-side before use.
- Selected covers should be embedded into the book file when the format supports it reliably enough.
- If embedded cover writing is not supported for the file format, the fallback is a sibling sidecar file using the `<book-stem>.cover.jpg` convention.
- Cover sidecars are per physical file instance, not globally shared across copies in different shelves.
- Editing a book applies only to the selected physical file instance unless a future feature explicitly broadens that behavior.
- Deleting a book removes only the selected shelf-local file instance and its sibling sidecars.
- Metadata is read from the file when possible and falls back to filename parsing when extraction fails.
- Optional sidecar JSON remains deferred; it is not required for phase 1.

## Proposed Filesystem Model

Root structure:

- `BOOKS_DIR/<shelf-name>/<author-name>/<book-file>`
- optional sibling files:
  - `BOOKS_DIR/<shelf-name>/<author-name>/<book-stem>.cover.jpg`
  - `BOOKS_DIR/<shelf-name>/<author-name>/<book-stem>.json`

Example:

```text
/books/Unread/Frank Herbert/Dune.epub
/books/Unread/Frank Herbert/Dune.cover.jpg
/books/Sci-Fi/Frank Herbert/Dune.epub
/books/Sci-Fi/Frank Herbert/Dune.cover.jpg
/books/Favorites/Andy Weir/Project Hail Mary.epub
```

## Shelf Model

- Each first-level directory under `BOOKS_DIR` is a shelf.
- Shelf name is derived directly from the directory name.
- Each book lives inside an author subdirectory within a shelf.
- A book belongs to a shelf by existing somewhere under that shelf directory.
- A book can exist on multiple shelves by being copied into multiple shelf directories.
- Hidden directories and system directories are ignored.

## Book Identity Model

Numeric Calibre IDs will be replaced with a stable path-based ID.

Recommended format:

- ID = URL-safe encoded shelf-relative path
- Example relative path: `Sci-Fi/Dune.epub`

Recommendation:

- Use encoded relative path directly where possible for easier debugging.
- Never trust client-provided paths directly; always decode and validate against `BOOKS_DIR`.

## Metadata Model

Intrinsic metadata should be read from the book file where available:

- title
- author
- format or extension
- file size
- modified time
- embedded cover when cheaply available
- optional future fields such as series when extraction is reliable

Fallback order:

1. sidecar JSON override, if present
2. embedded file metadata
3. filename parsing

## Cover Model

Selected covers should be embedded into the book file when supported, and sidecar covers should be used as the fallback when embedding is not supported or is too brittle for the format.

Rules:

- If the book format supports reliable cover embedding, the selected cover should be written into the file.
- If the format does not support reliable embedding, store the selected cover as `<stem>.cover.jpg` beside the book file.
- If `<stem>.cover.jpg` exists beside the book file, it is the primary display cover override.
- Otherwise, attempt embedded cover extraction for supported formats.
- Otherwise, use external cover search candidates at selection time.
- Cover search remains read-only until the user explicitly chooses one.
- Uploaded and externally fetched covers should be normalized to a format suitable for embedding where possible, and to a local JPEG sidecar when falling back.

Rationale:

- preserves the user's preference for metadata living in the file when practical
- still provides a consistent fallback for formats with weak or awkward cover-writing support
- preserves the "filesystem is the database" model

## Optional Sidecar JSON

Sidecar JSON is not required on day one, but the system should leave room for it.

Potential structure:

```json
{
	"titleOverride": null,
	"authorOverride": null,
	"coverFile": "Dune.cover.jpg",
	"source": {
		"mamId": 123456
	}
}
```

Phase 1 can omit JSON entirely if the cover sidecar is sufficient.

## Functional Requirements

Many of the frontend behaviors described in this section already exist in `book-thing` today. For this work, they should generally be adapted to the filesystem-native model rather than reimplemented from scratch. The main changes are in identity, storage, and backend contracts, not in inventing a completely new UI.

### Shelves

- List shelves from top-level directories in `BOOKS_DIR`.
- Show shelf book counts.
- Allow selection of one or more shelves during download.
- Allow creating shelves implicitly when first used or explicitly via API.
- Ignore hidden and system directories.

### Library Browsing

- The existing library UI should be retained where practical and updated to read from the filesystem-native API responses.
- List all books across all shelves.
- Filter by shelf.
- Search client-side by title or author, similar to the current UI.
- Expose path-based identity rather than numeric database IDs.
- Show one row or card per physical file.

### Download Flow

- The existing download flow and shelf-selection UX should be reused where practical, with payloads adapted from numeric shelf IDs to shelf names or path-based identifiers.
- User selects one or more shelves before download begins.
- On completion, chosen ebook file or files are copied into each selected shelf.
- If multiple shelves are selected, copy into each shelf.
- If a target file already exists, skip or rename according to the collision policy.

### Book Editing

- The existing edit interactions should be adapted to operate on physical file instances rather than Calibre book records.
- For an existing library item, the user can:
  - save or replace a sidecar cover
  - add the book to additional shelves by copying it
  - remove the book from a shelf by deleting that shelf-local file instance
- Because duplicates are acceptable, shelf membership changes should be implemented as copy and delete operations rather than relational links.

### Deletion

- Delete acts on the selected physical file only.
- Deleting from one shelf must not delete copies in other shelves.
- Deleting a book file should also delete sibling sidecars for that file stem in the same author directory.

### Cover Search

- The existing cover search UI and provider integrations should be reused where practical, with storage adapted from Calibre-managed covers to sibling sidecar cover files.
- Search Open Library and Google Books as today.
- Support uploaded covers.
- Support preselecting the current sidecar cover if present.
- Support embedded covers as candidates for supported formats.

## Non-Functional Requirements

- Must work entirely from local filesystem state.
- Must not require SQLite for library or shelf features.
- Must be safe against path traversal.
- Must tolerate malformed metadata and unusual filenames.
- Must remain fast enough for a personal library; simple scans are acceptable initially.
- Must not require Calibre folder structure.

## API Design

The existing route structure can largely remain, but contracts should change to reflect filesystem-native identities.

### `GET /api/shelves`

Returns filesystem shelves.

Example response:

```json
{
	"shelves": [{ "id": "Sci-Fi", "name": "Sci-Fi", "bookCount": 12 }]
}
```

### `GET /api/library?shelf=<name>`

Returns physical file entries.

Example response:

```json
{
	"books": [
		{
			"id": "U2NpLUZpL0R1bmUuZXB1Yg",
			"relativePath": "Sci-Fi/Dune.epub",
			"shelf": "Sci-Fi",
			"title": "Dune",
			"author": "Frank Herbert",
			"hasCover": true,
			"coverVersion": "2026-03-28T12:00:00.000Z",
			"addedAt": "2026-03-28T12:00:00.000Z",
			"lastModified": "2026-03-28T12:00:00.000Z",
			"extension": "epub",
			"size": 1234567
		}
	],
	"totalBooks": 1
}
```

### `GET /api/library/cover/[id]`

- Resolve the book by path-based ID.
- Serve sibling sidecar cover if present.
- Otherwise optionally serve extracted embedded cover.
- Otherwise return `404`.

### `POST /api/library/[id]`

Updates one physical file instance.

Example request:

```json
{
	"shelfNames": ["Sci-Fi", "Favorites"],
	"coverUrl": "https://example.com/cover.jpg",
	"coverData": "base64-encoded-image"
}
```

Behavior:

- copy file to any additional shelves listed in `shelfNames`
- do not remove other copies as part of `POST`
- save the selected cover on the edited file instance

Removal behavior:

- deleting a shelf-local copy is handled only by `DELETE /api/library/[id]` on that specific file instance

Recommended rule:

- cover changes apply only to the currently edited file instance, not to all copies across shelves

### `DELETE /api/library/[id]`

- Delete only that physical file instance and its local sidecars.

### `GET /api/shelves/book/[id]`

Two options exist:

- keep this route and return shelf names for a book-like item, or
- simplify the UI model so each file belongs to exactly one shelf and shelf expansion is handled through copy actions instead

Recommendation:

- simplify the UI model over time so each library row represents one physical file in one shelf

## UX Model

Recommended mental model:

- one library row equals one physical file instance in one shelf

Instead of modeling "one logical book with many shelves," the app should model "one shelf-local file that can be copied elsewhere." This better matches the filesystem design and avoids reintroducing database-style coupling.

## Backend Architecture

Recommended new server modules:

- `src/lib/server/fs-shelves.ts`
  - list shelves
  - validate and create shelf directories
  - count books in shelves
- `src/lib/server/fs-library.ts`
  - scan library from filesystem
  - encode and decode path-based IDs
  - resolve and delete sidecars
  - copy files across shelves
- `src/lib/server/book-metadata.ts`
  - extract title, author, and embedded cover from supported formats
- `src/lib/server/book-covers.ts`
  - save sidecar covers from bytes or URLs
  - locate sidecar covers
  - normalize stored cover filenames

## Reuse From Existing Code

Useful logic can be retained from the current Calibre integration code:

- EPUB title and author extraction
- MOBI metadata parsing
- PDF metadata parsing
- external cover search helpers
- embedded cover extraction logic, adapted to direct file paths instead of Calibre IDs

The following should not remain part of the active library path:

- Calibre database connection logic
- Calibre insert and delete routines
- Calibre-Web `app.db` shelf integration

## Download Placement Rules

Recommended behavior:

- At torrent completion, collect candidate ebook files as the app already does.
- For each selected shelf:
  - ensure the shelf directory exists
  - copy the best ebook file or files into that shelf
  - preserve the original filename initially
- Do not rename into Calibre-style paths.
- Do not register files in any database.
- Return created library item IDs as path-based IDs.

Collision policy recommendation:

- Default to skip if the exact same filename already exists in the shelf.
- Log skipped files.
- A later enhancement may append ` (1)`-style suffixes when desired.

## Migration Strategy

### Option A: Clean Cut

- Stop using Calibre entirely.
- Point `BOOKS_DIR` at a new filesystem-native library root.
- Start fresh with shelf directories.

This is the simplest and lowest-risk option.

### Option B: Soft Migration

- Add a one-time importer that scans existing Calibre directories.
- Copy real book files into shelf folders.
- Optionally bring over covers where useful.

This is not required for phase 1.

Recommendation:

- Prefer Option A unless preserving the existing Calibre-managed library is important enough to justify added complexity.

## Edge Cases

- books with missing or broken embedded metadata
- same filename already present in a shelf
- same title represented by different files across shelves
- sidecar cover present while the book file is missing
- non-ebook files in shelf directories
- unsupported formats without metadata

Recommended handling:

- ignore non-ebook files except recognized sidecars
- treat each physical file as independent
- fall back to filename parsing when metadata extraction fails
- keep errors local to affected files rather than failing the entire library scan

## Design Constraints

Recommended default constraints for phase 1:

- each shelf is a flat directory
- each book lives under a shelf-specific author directory
- editing a book affects only that physical copy
- cover sidecars are per-copy, not shared globally across copies

Allowing arbitrary deep nesting beyond the shelf and author directory would add identity and UI complexity that is not warranted for the intended use case.

## Acceptance Criteria

- The app operates without Calibre `metadata.db`.
- The app operates without Calibre-Web `app.db`.
- `GET /api/shelves` returns shelf directories under `BOOKS_DIR`.
- `GET /api/library` returns books discovered from the filesystem.
- Downloading a book to selected shelves copies files into those shelf folders.
- Library UI displays those files without any Calibre registration step.
- Cover selection stores and displays a sibling image file.
- Deleting a library item removes only that shelf-local copy and its sidecars.
- Duplicates across shelves are allowed and visible.

## Implementation Phases

### Phase 1

- Introduce filesystem shelf model.
- Introduce path-based library listing.
- Replace frontend types and API payloads from numeric IDs to path-based IDs and shelf names.

### Phase 2

- Replace download completion flow to copy into selected shelf directories.
- Replace cover serving and saving with sibling sidecars.

### Phase 3

- Remove Calibre and `app.db` dependencies from active codepaths.
- Clean up obsolete modules after validation.

## Deferred Future Work

- Kobo sideload export support
- Kobo device database integration over USB
- optional sidecar JSON metadata overrides
- collision renaming policy improvements
- migration tooling from existing Calibre libraries
