# Kobo Wireless Sync

## Overview

This PRD defines a read-only wireless sync feature for Kobo devices, implemented directly in `book-thing` without Calibre or Calibre-Web as the runtime sync provider.

The target model is intentionally simpler than Calibre-Web's existing Kobo integration:

- one Kobo device maps to one shelf
- the shelf name is part of the endpoint path
- no sync token is used
- the environment is a trusted personal homelab
- phase 1 includes shelf sync plus Kobo reading progress/state sync

The feature should expose a Kobo-compatible HTTP API surface closely enough that a Kobo device can sync books, metadata, and covers from a single shelf in `book-thing`.

## Goals

- Replace Calibre-Web's Kobo sync dependency for a personal homelab setup.
- Support one Kobo device per shelf.
- Allow a Kobo device to sync books wirelessly from `book-thing`.
- Serve shelf-specific books, metadata, covers, and downloads through Kobo-compatible endpoints.
- Reuse the filesystem-native library model already implemented in `book-thing`.
- Keep the implementation shelf-scoped and minimal while still supporting Kobo reading progress/state sync in phase 1.

## Non-Goals

- No general multi-user Kobo sync model.
- No auth token model in phase 1.
- No shelf renaming guarantees; shelf names are assumed stable.
- No broad multi-user writeback model beyond the shelf-scoped Kobo sync path.
- No Kobo store replacement beyond the minimum needed to keep sync working.
- No attempt to clone every Calibre-Web Kobo route on day one.
- No USB sync in this phase.

## User Model

Single-user trusted homelab.

Assumptions:

- the Kobo is configured manually by editing `Kobo eReader.conf`
- each Kobo device is pointed at one shelf-specific endpoint
- shelf names are stable and controlled by the user
- no untrusted external users are using the sync endpoints

## Problem Statement

Today, Kobo wireless sync is available through Calibre-Web's Kobo integration. That integration uses:

- a user-scoped token in the URL path
- Calibre's database-backed book model
- Calibre-Web shelf configuration
- a Kobo-compatible API contract implemented inside Calibre-Web

`book-thing` has already moved to a filesystem-native library model:

- `BOOKS_DIR/<shelf>/<author>/<bookfile>`
- direct metadata extraction from files
- shelf membership represented by folders

To fully bypass Calibre-Web for Kobo use, `book-thing` needs to serve a Kobo-compatible sync API directly from the filesystem-native library.

## Product Principles

- Shelf path is the device identity.
- Filesystem remains the source of truth.
- Prefer the smallest Kobo-compatible API surface that actually works.
- Phase 1 should optimize for reliability over completeness.
- Persist only the minimum sync state needed for Kobo compatibility.

## Phase 1 Frozen Decisions

- One Kobo device syncs one shelf.
- Shelf name is part of the URL path.
- Shelf paths should use simple lowercase shelf names such as `aaron` or `sam`; shelf names containing `/` are unsupported.
- No auth token is used in phase 1.
- Phase 1 includes reading progress/state sync.
- The shelf path is treated as trusted configuration, not user input from an open internet context.
- The implementation should mimic the Kobo-compatible response contract Calibre-Web already uses where practical.
- Books are served from the existing filesystem-native shelf layout.
- Covers should come from the existing cover model: embedded when available, sidecar fallback when needed.
- Multiple Kobo devices may point at the same shelf endpoint.
- Unknown Kobo requests should be proxied by default in phase 1.
- Missing local covers should return a valid placeholder image rather than `404`.
- Invalid shelf paths should return `404`.
- The Kobo-facing book identity is the existing shelf-local library `id`.
- Kobo reading progress/state is persisted in a lightweight JSON store keyed by that shelf-local library `id`.
- Wireless sync may expose any format that proves Kobo-usable, with implementation choosing the best available format per book.

## Target Configuration Model

The Kobo device will be configured manually to point its `api_endpoint` at a shelf-specific URL.

Conceptual example:

```text
http://your-server:13338/kobo/Aaron
```

Or with a reverse proxy:

```text
https://books.example.com/kobo/Aaron
```

The Kobo should then use routes below that base path, such as:

```text
/kobo/Aaron/v1/initialization
/kobo/Aaron/v1/library/sync
```

## Shelf Mapping Model

- The path segment after `/kobo/` is the shelf name.
- The shelf path segment should be a simple lowercase shelf name.
- Shelf names containing `/` are unsupported for Kobo endpoint configuration.
- Shelf existence and validity are checked against the filesystem shelf model.
- Only books in that shelf are visible to that Kobo device.
- The device should not see books from any other shelf.
- Multiple Kobo devices may use the same shelf endpoint and will see the same shelf content.

## Protocol Strategy

Research indicates that Kobo wireless sync in this setup is not a generic OPDS feed. It is closer to a Kobo Store API-compatible contract, as implemented by Calibre-Web.

Therefore, phase 1 should follow a compatibility strategy:

- model the endpoints and response shapes after Calibre-Web's Kobo integration where practical
- simplify identity from `auth_token -> user -> shelves` to `shelf-name -> shelf`
- implement the subset required for shelf sync, metadata, covers, downloads, and reading progress/state

## Functional Requirements

### Initialization

- Provide a Kobo-compatible initialization endpoint for a shelf-specific device.
- Return resource URLs that point back to `book-thing` for:
  - library sync
  - cover images
  - downloads
- Return enough static resource fields for the Kobo device to proceed with sync.

### Library Sync

- Provide a shelf-specific library sync endpoint.
- Return only books from the requested shelf.
- Return Kobo-compatible entitlement and metadata entries for those books.
- Support best-effort incremental sync in phase 1.
- Use filesystem metadata and minimal persisted sync state where necessary to behave incrementally.
- Books should be filtered to formats Kobo can use.

### Reading Progress And State

- Accept Kobo reading-state/progress updates in phase 1.
- Persist enough reading state for the Kobo to continue syncing cleanly.
- At minimum, support the Kobo concepts corresponding to:
  - reading status
  - current bookmark/location
  - reading progress percentage
  - reading statistics where feasible
- Scope this state to the shelf-specific Kobo sync model.
- The persistence model does not need to be database-backed if a simpler local storage model is sufficient.

### Metadata

- Provide a metadata endpoint for a specific synced book.
- Return Kobo-compatible metadata fields, including at minimum:
  - title
  - author(s)
  - language
  - publication date when available
  - series when available
  - download URLs

### Cover Images

- Provide Kobo-compatible cover image URLs.
- Serve local covers from the filesystem-native cover model.
- Prefer the selected/current local cover.
- Fall back to embedded cover extraction where available.
- Return a valid placeholder image if no local cover exists.

### Downloads

- Provide a direct book download endpoint for Kobo-supported formats.
- Serve the best Kobo-usable format selected for that shelf-local book.
- Ensure the download URL points to the shelf-local file intended for the device.

### Shelf Isolation

- A Kobo configured for shelf `Aaron` must only sync books from `Aaron`.
- Books in `Sam` must not appear through `Aaron`'s Kobo sync endpoints.

### Unknown Kobo Requests

- Unknown or unimplemented Kobo-store-style requests should be proxied by default in phase 1.
- If proxying is not possible for a specific request, the app should return the smallest safe compatibility response that keeps the device functioning.

## Phase 1 Endpoint Set

Recommended phase 1 routes:

- `GET /kobo/[shelf]/v1/initialization`
- `GET /kobo/[shelf]/v1/library/sync`
- `GET /kobo/[shelf]/v1/library/[id]/metadata`
- `GET /kobo/[shelf]/covers/[id]/image`
- `GET /kobo/[shelf]/download/[id]/[format]`
- `GET /kobo/[shelf]/v1/library/[id]/state`
- `PUT /kobo/[shelf]/v1/library/[id]/state`
- additional minimal or proxied routes as required by the device during real sync

Implementation note:

- Internal route shapes may differ if needed, but the external contract should remain Kobo-compatible.

## Book Identity Model For Kobo

The existing app uses:

- `id` for a physical shelf-local file instance
- `bookKey` for the same book across shelves

For Kobo shelf-specific sync:

- the existing shelf-local library `id` is the better primary identifier
- it already uniquely identifies the physical file instance in that shelf
- it aligns with the current filesystem-native app model and avoids `bookKey` ambiguity across shelves

Recommendation:

- use the existing shelf-local library `id` for Kobo-facing book identity under a shelf path
- note that Kobo-facing identity is path-derived rather than globally immutable; renaming or moving files changes the derived identity

## Metadata Requirements

At minimum, metadata generation should reuse the existing filesystem metadata extraction logic.

Preferred fields:

- title
- authors
- language
- description if available
- publisher if available
- publication date if available
- series name and index if available
- download URL(s)
- cover image identifier

## Format Strategy

Phase 1 format priority:

1. expose the best available Kobo-usable format for a book in the shelf
2. prefer `EPUB` when it is available
3. allow broader format support when Kobo behavior proves the format is usable

Recommendation:

- if a shelf contains multiple copies or formats of the same logical book, expose the best Kobo-usable format only
- format preference should remain configurable in implementation if device testing shows a better real-world ordering

## Progress Storage Strategy

Phase 1 includes reading progress/state sync, so the app needs a lightweight persistence model.

- store per-book Kobo reading state for the synced shelf context
- survive app restarts
- avoid introducing a heavy Calibre-style database if a simpler persisted store is sufficient

Recommended initial direction:

- a small local persisted JSON store dedicated to Kobo sync state
- keyed by the existing shelf-local library `id` used by the Kobo sync routes
- expanded later only if the protocol requires more detail

## Non-Functional Requirements

- Must work from the filesystem-native library only.
- Must not depend on Calibre `metadata.db`.
- Must not depend on Calibre-Web `app.db`.
- Must return valid Kobo-compatible HTTP responses for the implemented routes.
- Must be stable enough for daily personal use on a homelab.
- Must tolerate missing metadata and missing covers gracefully.

## Security Model

Phase 1 uses a trusted-LAN model.

- No auth token.
- No device-specific secret.
- Shelf name in path is sufficient.

Risks accepted in phase 1:

- anyone who can reach the endpoint and knows the shelf path could access that shelf's Kobo feed

Mitigations outside app scope:

- reverse proxy restrictions
- private network only
- non-public DNS

## Risks

- Kobo may require more of the Calibre-Web route surface than expected.
- The device may require more state persistence detail than anticipated for progress/bookmark sync.
- Cover URL behavior may be sensitive to exact response shape or dimensions.
- Initialization responses may need to be more exact than expected.
- Shelf-name-in-path may be simpler operationally, but is less flexible than token-based addressing.
- File/path-derived identity may cause resync churn if shelf contents are renamed or reorganized.

## Acceptance Criteria

- A Kobo configured with `api_endpoint` pointing at `/kobo/<shelf>` can start sync successfully.
- The Kobo receives only books from the configured shelf.
- Synced books include usable metadata and covers.
- The Kobo can download and open synced books from the shelf.
- Reading progress/state updates from the Kobo are accepted and persisted.
- No Calibre or Calibre-Web runtime dependency is required for this sync path.
- Unknown Kobo requests required for normal device operation are successfully proxied or handled compatibly.

## Deferred Future Work

- token-based or device-specific auth
- shelf rename-safe stable identifiers
- two-way shelf/tag sync
- KEPUB generation and preference
- store/OverDrive proxy compatibility improvements
- multiple shelves per device

## Suggested Implementation Phases

### Phase 1

- shelf-based Kobo initialization
- shelf-based wireless sync
- metadata
- covers
- downloads
- reading progress/state sync

### Phase 2

- compatibility fixes for additional Kobo requests
- better incremental sync behavior
- stronger and more explicit Kobo state model if required by device behavior

### Phase 3

- optional KEPUB support
- optional stronger auth model
