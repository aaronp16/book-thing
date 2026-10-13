# book-thing

A SvelteKit web interface for searching and downloading books from MyAnonamouse, using qBittorrent for downloading and seeding.

## Quick Reference

```bash
# Development
npm run dev           # Start dev server (http://localhost:5173)
npm run build         # Build for production
npm run preview       # Preview production build

# Docker
docker compose up -d  # Start with Docker
docker compose down   # Stop

# Type checking
npm run check         # Run svelte-check
```

## Project Overview

**book-thing** is a self-hosted web app that:
- Searches MyAnonamouse's catalog via their JSON API
- Sends `.torrent` files to an external qBittorrent instance via its WebUI API
- Copies completed downloads into the book library
- Shows download progress, speeds, peers, and seeding status (read from qBittorrent)

### Tech Stack
- **Frontend**: SvelteKit 2, Svelte 5 (runes), Tailwind CSS v4
- **Backend**: SvelteKit server routes (Node.js adapter for Docker)
- **Torrent Client**: qBittorrent (external, via WebUI API)
- **Containerization**: Docker + docker-compose with volume mount for `/books`

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `MAM_ID` | (required) | MyAnonamouse session cookie (`mam_id`) |
| `MAM_UID` | (required) | MyAnonamouse user ID |
| `BOOKS_DIR` | `./books` (dev) / `/books` (Docker) | Download directory (volume mount) |
| `QB_URL` | `http://localhost:8080` | qBittorrent WebUI URL |
| `QB_USERNAME` | `admin` | qBittorrent WebUI username |
| `QB_PASSWORD` | (empty) | qBittorrent WebUI password |
| `QB_CATEGORY` | `books` | qBittorrent category for book downloads |
| `QB_SAVE_PATH` | (category default) | Override qBittorrent save path |

---

## MyAnonamouse API Reference

MAM provides a JSON search API. Auth is cookie-based using `mam_id` and `uid`.

### Search Endpoint
```
GET https://www.myanonamouse.net/tor/js/loadSearchJSONbasic.php
```

**Key parameters:**
- `tor[text]` - search query
- `tor[srchIn][title]`, `tor[srchIn][author]`, etc. - fields to search
- `tor[cat][]` - category filter (e-book IDs: 60-82,90-96,101-104,107,109,112,115,118,120; audiobook IDs: 39-59,83-89,97-100,106,108,111,119)
- `tor[startNumber]` - pagination offset (page size is 20)
- `tor[searchType]` - all, active, fl (freeleech), VIP, etc.

**Response:**
```json
{
  "data": [
    {
      "id": 123456,
      "title": "Harry Potter and the Philosopher's Stone",
      "author_info": "{\"1234\": \"J.K. Rowling\"}",
      "narrator_info": "",
      "series_info": "{\"5678\": {\"series_name\": \"Harry Potter\", \"series_number\": \"1\"}}",
      "catname": "Ebooks - Fantasy",
      "size": "1234567",
      "seeders": 50,
      "leechers": 2,
      "times_completed": 500,
      "filetype": "EPUB",
      "free": 0,
      "vip": 0,
      "lang_code": "en"
    }
  ],
  "total": 100,
  "found": 100,
  "perpage": 20,
  "start": 0
}
```

### Torrent Download
```
GET https://www.myanonamouse.net/tor/download.php?tid={torrent_id}
Cookie: mam_id={MAM_ID}; uid={MAM_UID}
```

Returns the `.torrent` file binary.

---

## Project Structure

```
book-thing/
├── CLAUDE.md                  # This file
├── docker-compose.yml         # Docker orchestration
├── Dockerfile                 # Container build
├── package.json
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── app.html
│   ├── app.d.ts
│   ├── routes/
│   │   ├── +layout.svelte         # Main layout (dark theme)
│   │   ├── +page.svelte           # Main page (search + results + library)
│   │   ├── layout.css             # Tailwind + animations
│   │   └── api/
│   │       ├── search/+server.ts      # Search MAM
│   │       ├── download/+server.ts    # Start torrent download
│   │       ├── progress/[id]/+server.ts  # SSE download progress
│   │       ├── torrents/+server.ts    # List/manage torrents
│   │       ├── library/+server.ts     # Scan book library
│   │       └── stats/+server.ts       # Disk space
│   └── lib/
│       ├── index.ts
│       ├── types.ts               # Shared types
│       ├── components/            # Svelte components
│       ├── stores/                # Svelte stores
│       └── server/
│           ├── env.ts             # Environment config
│           ├── mam-client.ts      # MAM API wrapper
│           ├── qbittorrent-client.ts  # qBittorrent WebUI API client
│           ├── downloader.ts      # Download orchestrator (MAM → qBittorrent)
│           ├── library.ts         # Copy completed books into library
│           ├── fs-library.ts      # Scan book directory
│           └── fs-shelves.ts      # Shelves
└── books/                         # Volume mount point (gitignored)
```

---

## Key Implementation Details

### qBittorrent
`downloader.ts` fetches the `.torrent` from MAM, computes its info hash
(`computeInfoHash`), and adds it to qBittorrent under `QB_CATEGORY`. Progress is
polled from qBittorrent and streamed to the UI over SSE (`/api/progress/[id]`).
qBittorrent handles seeding and persists its own torrent state.

### MAM Cookie Rotation
MAM may rotate the `mam_id` cookie in responses. The client tracks the latest
value from `Set-Cookie` headers, uses it for subsequent requests, and persists it
to `$BOOKS_DIR/.mam_session.json` so it survives restarts.

### Dynamic Seedbox IP
On server start (`init` in `hooks.server.ts`) and every 61 minutes,
`updateSeedboxIp()` calls `https://t.myanonamouse.net/json/dynamicSeedbox.php`
so MAM's tracker accepts qBittorrent's announces after the ISP changes our IP.
The MAM session must be ASN-locked with "Allow Session to set Dynamic Seedbox"
enabled. MAM rate-limits changes to once per hour (429 "Last change too recent").
