# Kobo Wireless Sync Plan

## Purpose

This plan turns `PRDs/kobo-wireless-sync.md` into a concrete implementation sequence.

This plan is for a shelf-based wireless Kobo sync feature implemented directly in `book-thing`, without Calibre-Web as the runtime sync provider.

## Guiding Approach

- build the smallest Kobo-compatible surface that actually works
- follow Calibre-Web's Kobo contract where practical, but simplify identity to shelf path plus shelf-local library `id`
- keep the implementation shelf-scoped
- prefer compatibility over elegance in protocol-facing code
- deliver in small steps so Kobo behavior can be tested incrementally

## Execution Rule

This plan should be executed one step at a time.

- Do not start the next step until the current step is implemented and manually tested.
- Each step below includes a `How to test` section so the system can be checked incrementally.
- Prefer small, reviewable changes that leave the app in a runnable state after each step.

## Step-by-Step Plan

### 1. Freeze the Kobo contract decisions

Confirm the implementation decisions already captured in the PRD.

- Shelf name is URL-encoded in the path.
- One Kobo device maps to one shelf.
- The Kobo-facing book identity is the existing shelf-local library `id`.
- Unknown Kobo requests are proxied by default in phase 1.
- Missing covers return a valid placeholder image.
- Invalid shelf paths return `404`.
- Reading progress/state is included in phase 1.
- Kobo reading state is stored in a lightweight JSON store keyed by shelf-local library `id`.

Deliverable:

- final agreement on the phase 1 contract reflected in `PRDs/kobo-wireless-sync.md`

How to test:

- Read `PRDs/kobo-wireless-sync.md` and confirm there is no ambiguity about shelf path handling, identity, progress persistence, or proxy behavior.

### 2. Add Kobo-specific core server modules

Create the new Kobo-specific backend primitives.

- Add `src/lib/server/kobo-library.ts`
- Add `src/lib/server/kobo-metadata.ts`
- Add `src/lib/server/kobo-state.ts`
- Add `src/lib/server/kobo-proxy.ts`
- Add `src/lib/server/kobo-resources.ts`

Responsibilities:

- `kobo-library.ts`
  - resolve a shelf name safely from the URL path
  - list Kobo-eligible books for a shelf
  - resolve one shelf-local book by existing library `id`
  - choose the best syncable format per book
- `kobo-metadata.ts`
  - build Kobo-compatible entitlement and metadata payloads
  - derive authors, language, series, publisher, and download URLs from filesystem-native metadata
- `kobo-state.ts`
  - persist shelf-local Kobo reading state in JSON
  - read and update state by shelf-local library `id`
  - support simple incremental sync state where needed
- `kobo-proxy.ts`
  - proxy unknown Kobo-store-style requests to the real Kobo endpoints
  - strip unsafe headers and preserve expected response behavior
- `kobo-resources.ts`
  - build the initialization resource payload returned to Kobo devices

Deliverable:

- reusable Kobo backend modules with no dependency on Calibre or Calibre-Web runtime data

How to test:

- Confirm the new files exist and export the expected helpers.
- Run `npm run check`.

### 3. Implement shelf-safe Kobo book resolution

Build the shelf-specific resolution layer first.

- Validate and URL-decode shelf names from the route path.
- Return `404` for invalid or missing shelves.
- Reuse the filesystem-native library model to resolve shelf-local books.
- Restrict Kobo sync to only books in the requested shelf.
- Filter to Kobo-usable formats using the chosen phase 1 format strategy.

Deliverable:

- a shelf-scoped Kobo book resolver that can list and resolve syncable books by shelf-local library `id`

How to test:

- Use a temporary internal test route or direct helper invocation to confirm shelf resolution works.
- Confirm invalid shelf names fail cleanly.
- Confirm only books from the requested shelf are returned.

### 4. Implement Kobo progress/state JSON storage

Build the persisted progress store before exposing state endpoints.

- Store reading state in a lightweight JSON file under app-owned storage.
- Key entries by the existing shelf-local library `id`.
- Persist enough fields for Kobo reading state support, including:
  - reading status
  - bookmark/location
  - progress percentage
  - reading statistics when available
- Ensure the state survives restarts.

Deliverable:

- a working JSON-backed Kobo reading state store

How to test:

- Write and read a sample state entry for a known shelf-local library `id`.
- Restart the app and confirm the state remains.
- Run `npm run check`.

### 5. Implement the initialization endpoint

Add the first external Kobo-facing endpoint.

- Create `GET /kobo/[shelf]/v1/initialization`.
- Return the Kobo resource document with URLs pointing back to `book-thing`.
- Include shelf-specific `library_sync`, cover, and download URL templates.
- Return `404` for invalid shelves.

Deliverable:

- shelf-scoped Kobo initialization response

How to test:

- Call `GET /kobo/<encoded-shelf>/v1/initialization`.
- Confirm it returns JSON with the expected resource URLs.
- Confirm invalid shelves return `404`.

### 6. Implement the library sync endpoint

Add the main sync route.

- Create `GET /kobo/[shelf]/v1/library/sync`.
- Return Kobo-compatible sync payloads for books in that shelf.
- Support best-effort incremental sync using filesystem metadata and minimal persisted state where required.
- Ensure only shelf-local books are included.

Deliverable:

- working shelf-specific library sync output

How to test:

- Call the sync endpoint for a real shelf.
- Confirm books from that shelf appear.
- Confirm books from other shelves do not.
- Re-run sync and confirm incremental behavior is sensible for unchanged shelves.

### 7. Implement metadata and download endpoints

Add the endpoints the Kobo needs to retrieve metadata and book files.

- Create `GET /kobo/[shelf]/v1/library/[id]/metadata`.
- Create `GET /kobo/[shelf]/download/[id]/[format]`.
- Use the existing shelf-local library `id` to resolve the physical file.
- Ensure the resolved file really belongs to the requested shelf.
- Serve the selected Kobo-usable format for that book.

Deliverable:

- metadata and book downloads working for a shelf-local Kobo book

How to test:

- Call the metadata endpoint for a known shelf-local `id` and confirm the payload is well-formed.
- Download the book through the Kobo download route and confirm the correct file is returned.
- Confirm cross-shelf access with the wrong shelf path is rejected.

### 8. Implement cover image serving with placeholder fallback

Add Kobo cover image support.

- Create `GET /kobo/[shelf]/covers/[id]/image`.
- Resolve local covers from the existing cover model.
- Prefer selected/current local cover.
- Fall back to embedded cover extraction when needed.
- If no cover exists, return a valid placeholder image instead of `404`.

Deliverable:

- Kobo-compatible cover serving with guaranteed image output

How to test:

- Test a book with a sidecar or embedded cover.
- Test a book with no cover and confirm a placeholder image is returned.
- Confirm the endpoint always returns a valid image response for a valid shelf-local book.

### 9. Implement reading state endpoints

Add Kobo-facing reading progress/state routes.

- Create `GET /kobo/[shelf]/v1/library/[id]/state`.
- Create `PUT /kobo/[shelf]/v1/library/[id]/state`.
- Read and write state using the JSON store.
- Ensure state is scoped to the requested shelf-local library `id`.
- Return Kobo-compatible response payloads.

Deliverable:

- working read/write reading progress support for Kobo devices

How to test:

- Fetch state for a known shelf-local `id`.
- Update state with a test payload.
- Fetch it again and confirm the new values are persisted.
- Restart the app and confirm the state remains.

### 10. Implement proxying for unknown Kobo requests

Add the compatibility fallback layer.

- Route unknown Kobo-store-style requests through a proxy helper.
- Preserve the request method where possible.
- Strip connection-specific headers when proxying responses.
- Return a minimal compatibility response only when proxying is not possible or not appropriate.

Deliverable:

- unknown Kobo paths are proxied by default in phase 1

How to test:

- Hit a non-core Kobo path under `/kobo/[shelf]/...`.
- Confirm the request is proxied rather than hard-failing.
- Confirm proxy failures degrade predictably.

### 11. Wire the routes into a coherent Kobo route surface

Connect the implemented pieces into the external shelf-based Kobo API.

- Ensure all shelf-based Kobo routes share the same shelf validation logic.
- Ensure all routes use the same shelf-local book resolution rules.
- Ensure the same identity model is used across sync, metadata, covers, downloads, and state.

Deliverable:

- consistent shelf-based Kobo route surface

How to test:

- Spot-check several routes for the same shelf and book.
- Confirm all of them resolve the same book identity and shelf context.

### 12. Test against a real Kobo device config

Once the route surface exists, test against the real device.

- Point `api_endpoint` at `/kobo/<encoded-shelf>`.
- Trigger device initialization.
- Trigger a manual sync.
- Confirm books, metadata, and covers arrive.
- Confirm downloads open correctly.
- Confirm reading progress updates are sent and persisted.

Deliverable:

- first real-device validation of the Kobo sync contract

How to test:

- Use a dedicated shelf and a small set of books.
- Trigger sync on the device.
- Confirm end-to-end behavior from the Kobo itself.

### 13. Iterate on compatibility gaps discovered from the device

Expect real-device testing to uncover missing assumptions.

- Add any missing minimal routes the device requires.
- Adjust payload fields or headers to match what the Kobo expects.
- Tighten incremental sync behavior if needed.
- Refine proxy behavior only where the device actually requires it.

Deliverable:

- stable shelf-based Kobo wireless sync for daily use

How to test:

- Repeat real-device sync after each compatibility fix.
- Confirm sync becomes more stable rather than regressing.

## Suggested Execution Order

1. freeze PRD decisions
2. Kobo core modules
3. shelf-safe book resolution
4. JSON reading-state store
5. initialization endpoint
6. library sync endpoint
7. metadata and download endpoints
8. cover image endpoint
9. reading state endpoints
10. proxy fallback layer
11. route unification
12. real-device test
13. compatibility fixes

## Risks To Watch

- Kobo may require more route coverage than expected before sync succeeds.
- Incremental sync behavior may depend on details that are not obvious from Calibre-Web alone.
- Proxying unknown requests may be necessary earlier than expected.
- Reading-state payload shapes may be picky.
- Path-derived IDs may force resync churn if shelf files are renamed.

## Recommended Milestone Checkpoints

### Milestone 1

- initialization and library sync routes respond correctly for a shelf

### Milestone 2

- metadata, covers, and downloads work for a shelf-local book

### Milestone 3

- reading progress/state persists correctly in the JSON store

### Milestone 4

- a real Kobo device can sync books from a shelf endpoint

## Explicit Non-Work For This Plan

This plan does not include:

- USB sync
- token-based auth
- full multi-user device management
- shelf rename-safe stable identities
- KEPUB generation unless later required by device testing
