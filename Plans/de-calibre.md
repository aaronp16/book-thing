# De-Calibre Plan

## Purpose

This plan turns `PRDs/de-calibre.md` into a concrete implementation sequence.

This is intentionally an adaptation plan, not a rewrite plan. A lot of the UI and user flow already exists in `book-thing`; the work is mainly to replace Calibre- and Calibre-Web-backed assumptions with filesystem-native ones.

## Guiding Approach

- keep the current frontend flow where practical
- replace data contracts before redesigning UI behavior
- move the source of truth from SQLite to the filesystem
- treat each shelf-local file as the thing being managed
- deliver in small stages so the app remains testable throughout

## Execution Rule

This plan should be executed one step at a time.

- Do not start the next step until the current step is implemented and manually tested.
- Each step below includes a `How to test` section so the system can be checked incrementally.
- Prefer small, reviewable changes that leave the app in a runnable state after each step.

## Step-by-Step Plan

### 1. Freeze the target data model

Decide and document the exact filesystem-native contracts before changing implementation.

- Confirm that each top-level directory in `BOOKS_DIR` is a shelf.
- Confirm that books are stored as `BOOKS_DIR/<shelf>/<author>/<bookfile>` in phase 1.
- Confirm that each physical file instance belongs to exactly one shelf.
- Confirm that duplicates across shelves are allowed.
- Confirm that selected covers are stored as sibling `.cover.jpg` files.
- Confirm that book identity is a path-based encoded shelf-relative path.

Deliverable:

- final agreement on the phase 1 storage model reflected in `PRDs/de-calibre.md`

How to test:

- Read `PRDs/de-calibre.md` and confirm the storage rules are explicit.
- Confirm there is no unresolved ambiguity about shelf layout, cover embedding fallback behavior, or path-based IDs before coding begins.

### 2. Introduce filesystem-native core server modules

Create the new backend modules that will replace the current Calibre-backed library model.

- Add `src/lib/server/fs-shelves.ts`.
- Add `src/lib/server/fs-library.ts`.
- Add `src/lib/server/book-metadata.ts`.
- Add `src/lib/server/book-covers.ts`.

Responsibilities:

- `fs-shelves.ts`
  - list shelf directories
  - validate shelf names
  - create shelf directories as needed
  - count books per shelf
- `fs-library.ts`
  - scan all shelf directories
  - recognize supported ebook files
  - encode and decode path-based book IDs
  - return normalized library records
  - delete one shelf-local book instance and its sidecars
  - copy one shelf-local book instance to other shelves
- `book-metadata.ts`
  - extract title and author from EPUB, MOBI, AZW, PDF where possible
  - fall back to filename parsing
- `book-covers.ts`
  - detect sibling cover files
  - save uploaded or fetched covers as sibling `.cover.jpg`
  - extract embedded covers directly from ebook files where supported

Deliverable:

- reusable filesystem-native backend primitives with no dependency on Calibre databases

How to test:

- Confirm the new files exist and export the expected helpers.
- Run `npm run check` to ensure the new modules compile even if they are not yet wired in.

### 3. Migrate useful metadata and cover helpers out of Calibre-specific code

Rehome the parts of `src/lib/server/calibre-client.ts` that are still useful.

- Copy EPUB metadata parsing into `book-metadata.ts`.
- Copy MOBI and PDF parsing into `book-metadata.ts`.
- Copy embedded cover extraction logic into `book-covers.ts`, adapting it to direct file paths.
- Keep Open Library and Google Books search helpers, either in `book-covers.ts` or a small shared cover-search helper.
- Remove any dependency on numeric Calibre book IDs from reused logic.

Deliverable:

- metadata and cover extraction logic that works directly on files

How to test:

- Use a few sample files already in your library and confirm metadata helpers return sensible title and author values.
- Confirm embedded cover extraction works for at least one supported format if a sample exists.
- Run `npm run check`.

### 4. Replace shelf API with filesystem shelves

Update the shelf endpoints to stop reading Calibre-Web `app.db`.

- Rewrite `src/routes/api/shelves/+server.ts` to return top-level shelf directories.
- Decide whether shelf `id` is simply the shelf name string.
- If needed later, add a create-shelf endpoint; do not add it unless the current UX requires it.

Also evaluate whether `src/routes/api/shelves/book/[id]/+server.ts` is still needed.

- If the current edit modal still expects multi-shelf membership, adapt it to return shelves containing copies of the same file where feasible.
- If the UI is simplified so one row equals one shelf-local file, remove or repurpose this route.

Deliverable:

- shelf APIs backed entirely by the filesystem

How to test:

- Start the app and call `GET /api/shelves`.
- Confirm it returns the top-level directories under `BOOKS_DIR` rather than Calibre-Web shelf rows.
- Create or remove a test shelf directory manually on disk and confirm the API reflects the change.

### 5. Replace library listing API with filesystem scan

Rebuild `src/routes/api/library/+server.ts` against `fs-library.ts`.

- Remove SQLite access and Calibre-specific queries.
- Scan shelves and return one record per physical file.
- Support optional filtering by shelf name.
- Return path-based `id`, `relativePath`, `shelf`, `title`, `author`, `hasCover`, `lastModified`, `extension`, and `size`.
- Preserve the response shape as much as practical so frontend churn is smaller.

Deliverable:

- library listing entirely driven by filesystem state

How to test:

- Start the app and call `GET /api/library`.
- Confirm the returned books match files on disk.
- Call `GET /api/library?shelf=<name>` for a known shelf and confirm filtering works.
- Run `npm run check`.

### 6. Replace cover serving with sibling cover resolution

Rebuild `src/routes/api/library/cover/[id]/+server.ts`.

- Decode path-based ID to a validated relative path.
- Resolve the physical file.
- Serve sibling `.cover.jpg` if present.
- If not present, optionally serve extracted embedded cover.
- Otherwise return `404`.

Deliverable:

- cover serving with no Calibre DB dependency

How to test:

- Place a test `.cover.jpg` beside a known book file.
- Open the corresponding `/api/library/cover/[id]` URL and confirm the sidecar image is served.
- Remove the sidecar and confirm embedded cover fallback or `404` works as expected.

### 7. Replace book update and delete operations

Rebuild `src/routes/api/library/[id]/+server.ts` to work on filesystem items.

For `POST`:

- Replace `shelfIds` with `shelfNames`.
- Implement shelf changes as copy-to-additional-shelf operations only.
- Save uploaded or fetched covers by embedding them into the book when supported, and falling back to sibling sidecar cover files otherwise.
- Ensure edits apply only to the selected physical file instance unless explicitly extended later.

For `DELETE`:

- Delete only the selected physical file instance.
- Delete matching sibling sidecars in that shelf.
- Do not affect copies in other shelves.

Deliverable:

- edit and delete APIs that manage real files rather than Calibre records

How to test:

- Use one test book in one shelf and add it to another shelf through the API or UI.
- Confirm a copied file appears in the target shelf on disk.
- Delete one shelf-local copy and confirm the other copy remains untouched.
- Save a cover and confirm it is embedded for supported formats, or that a sibling sidecar file is created as fallback for unsupported formats.

### 8. Adapt cover search to filesystem-native books

Update `src/routes/api/covers/search/+server.ts`.

- Replace optional Calibre `bookId` usage with path-based book identity where needed.
- If a current sidecar or embedded cover exists, surface it as a candidate and preselect it.
- Keep provider searches from Open Library and Google Books.
- Preserve the current frontend cover picker where practical.

Deliverable:

- cover search that still feels the same in the UI, but reads from files instead of Calibre

How to test:

- Open the existing cover picker for a filesystem-native book.
- Confirm provider results still appear.
- Confirm an existing sidecar or embedded cover is shown as a candidate when available.
- Run `npm run check`.

### 9. Change shared frontend types from DB IDs to filesystem IDs

Update shared types in `src/lib/types.ts`.

- Replace numeric shelf IDs with shelf names or string IDs.
- Replace numeric library book IDs with path-based string IDs.
- Update download job types to carry shelf names instead of shelf IDs.
- Update any derived UI types that currently assume Calibre records.

Deliverable:

- type system aligned with filesystem-native identity

How to test:

- Run `npm run check` and confirm all type errors caused by ID and shelf contract changes are resolved.
- Spot-check a few frontend payloads in the browser devtools network tab to confirm string IDs and shelf names are flowing through.

### 10. Adapt the library UI to the new data contracts

Update `src/lib/components/LibraryPanel.svelte`.

- Replace numeric `book.id` assumptions with string path-based IDs.
- Update delete requests to target filesystem-native IDs.
- Update cover URLs to use the new identity model.
- Keep current search and filter UX where practical.
- Show the shelf name in each library item if helpful for clarity.

Important:

- do not redesign the library UI unless adaptation reveals a genuine mismatch

Deliverable:

- current library screen working against filesystem-native APIs

How to test:

- Open the library screen in the browser.
- Confirm books render, searching still works, shelf filtering still works, and delete actions target the correct file instance.
- Confirm cover images still load for items with covers.

### 11. Adapt the shelf selector and edit modal

Update `src/lib/components/ShelfSelectorModal.svelte`.

- Replace language that references Calibre-Web shelves.
- Change requests from numeric shelf IDs to shelf names.
- Preserve the current modal flow if possible.
- For edit mode, decide whether the modal still shows multi-shelf membership or shifts toward a simpler "copy to shelf" mental model.

Recommendation:

- keep the current modal for phase 1 if it can be adapted cleanly
- simplify later only if the filesystem model makes the old behavior awkward

Deliverable:

- existing modal behavior retained where practical, with filesystem-native payloads

How to test:

- Open the download shelf selector modal and confirm shelves load correctly.
- Open the edit modal for a library item and confirm it works without numeric Calibre IDs.
- Confirm the modal text no longer references Calibre-Web shelves.

### 12. Adapt the download start API and job model

Update the download initiation flow.

- Change `src/routes/api/download/+server.ts` to accept `shelfNames`.
- Update `src/lib/server/downloader.ts` to carry shelf names through the job lifecycle.
- Keep the existing progress and SSE behavior.
- Avoid changing the user-facing download flow unless required.

Deliverable:

- downloads continue to start the same way from the user perspective

How to test:

- Start a test download from the UI.
- Confirm the request payload uses shelf names.
- Confirm the progress UI still updates as before.

### 13. Replace library ingestion after download completion

Rebuild the current `copyBookToLibrary` path in `src/lib/server/library.ts`.

- Stop copying into the root and registering in Calibre.
- Copy selected ebook files directly into each chosen shelf directory.
- Preserve original filenames in phase 1.
- Skip duplicates if the exact filename already exists in a target shelf.
- Return created filesystem-native IDs so the frontend can refresh correctly.

Deliverable:

- completed downloads land directly into the shelf-based filesystem library

How to test:

- Complete a test download into one shelf and confirm the final ebook file appears in that shelf directory.
- Complete a test download into multiple shelves and confirm copies are created in each target shelf.
- Confirm the new files appear in the library UI after refresh.

### 14. Remove active runtime dependencies on Calibre and Calibre-Web

Once filesystem-native APIs are working, remove the old modules from active codepaths.

- Ensure no live route depends on `metadata.db`.
- Ensure no live route depends on `app.db`.
- Keep old modules temporarily only if needed during transition.
- After validation, remove obsolete imports and dead code.

Deliverable:

- app runs fully without Calibre or Calibre-Web library dependencies

How to test:

- Temporarily remove or ignore access to Calibre `metadata.db` and Calibre-Web `app.db` in your environment.
- Start the app and confirm library, shelf, cover, and download flows still work.
- Search the codebase for active imports of the old Calibre shelf and library modules and confirm they are no longer in live paths.

### 15. Test the end-to-end filesystem workflow

Validate behavior manually and with lightweight checks.

Test scenarios:

- shelf listing with no shelves
- shelf listing with multiple shelves
- library listing across shelves
- library filtering by shelf
- download to one shelf
- download to multiple shelves
- duplicate file already present in one shelf
- cover upload for a filesystem-native book
- external cover save for a filesystem-native book
- delete one shelf-local copy while another shelf copy remains
- metadata fallback when embedded metadata is missing

Also run existing project checks that are relevant:

- `npm run check`
- any existing build or smoke checks you normally rely on

Deliverable:

- confidence that the app behaves the same from the user perspective while using a new backend model

How to test:

- Run through the full checklist in this step manually.
- Run `npm run check`.
- Run any normal build or smoke test you personally trust before moving on.

### 16. Optional cleanup and follow-up docs

After the migration is stable:

- update `CLAUDE.md` or other internal docs if they still describe Calibre-backed behavior
- add a short developer note about the new shelf and cover sidecar conventions
- identify any remaining follow-up work for Kobo integration as a separate plan or PRD

Deliverable:

- codebase and docs consistently describe the filesystem-native library model

How to test:

- Re-read the key docs and confirm they no longer describe Calibre-backed library behavior as current.
- Confirm any follow-up Kobo work remains documented separately rather than mixed into this migration.

## Suggested Execution Order

If implemented incrementally, the safest order is:

1. core filesystem modules
2. metadata and cover helper extraction
3. shelf API
4. library API
5. cover serving
6. shared types
7. library UI adaptation
8. shelf selector and edit modal adaptation
9. download API and job model updates
10. download completion ingestion rewrite
11. delete and update operations
12. dead-code cleanup and documentation

## Risks To Watch

- accidental path traversal bugs when decoding path-based IDs
- filename collisions within a shelf
- UI assumptions that one logical book maps to many shelves via a single ID
- embedded metadata inconsistencies across ebook formats
- embedded cover extraction being slower or less reliable than expected

## Recommended Milestone Checkpoints

### Milestone 1

- shelves and library listing work from filesystem only

### Milestone 2

- covers work from sidecars and embedded extraction

### Milestone 3

- downloads land directly into shelf directories

### Milestone 4

- no active Calibre or Calibre-Web library dependency remains

## Explicit Non-Work For This Plan

This plan does not include:

- implementing Kobo sync
- writing deployment or homelab automation
- pushing to git or deploying containers
- redesigning the app from scratch
