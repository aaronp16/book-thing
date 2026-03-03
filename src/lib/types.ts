/**
 * Shared types for book-thing
 */

/** Search result entry from MyAnonamouse */
export interface MamEntry {
	id: number;
	title: string;
	author_info: string;
	narrator_info: string;
	series_info: string;
	category: number;
	catname: string;
	categories: string;
	size: string;
	numfiles: number;
	filetype: string;
	seeders: number;
	leechers: number;
	times_completed: number;
	added: string;
	free: number;
	vip: number;
	lang_code: string;
	language: number;
	tags: number | string;
	browseflags: number;
	comments: number;
}

/** Parsed author/narrator/series info */
export interface PersonInfo {
	id: number;
	name: string;
}

/** Parsed book entry for the frontend */
export interface BookResult {
	id: number;
	title: string;
	authors: PersonInfo[];
	narrators: PersonInfo[];
	series: { id: number; name: string; number?: string }[];
	category: string;
	isAudiobook: boolean;
	isEbook: boolean;
	size: number;
	sizeFormatted: string;
	numFiles: number;
	fileType: string;
	seeders: number;
	leechers: number;
	snatched: number;
	freeleech: boolean;
	vip: boolean;
	language: string;
	added: string;
}

/** Search field filter */
export type SearchField = 'title' | 'author';

/** Torrent status */
export type TorrentStatus = 'downloading' | 'seeding' | 'paused' | 'error';

/** Active torrent info exposed to the frontend */
export interface TorrentInfo {
	infoHash: string;
	name: string;
	progress: number;
	downloadSpeed: number;
	uploadSpeed: number;
	numPeers: number;
	downloaded: number;
	uploaded: number;
	size: number;
	ratio: number;
	status: TorrentStatus;
	files: string[];
	addedAt: string;
	/** The MAM torrent ID this was downloaded from */
	mamId?: number;
}

/** Download job for SSE progress */
export interface DownloadJob {
	id: string;
	mamId: number;
	title: string;
	infoHash?: string;
	status: 'fetching' | 'downloading' | 'complete' | 'error';
	progress: number;
	downloadSpeed: number;
	uploadSpeed: number;
	numPeers: number;
	error?: string;
}

/** A file in the library */
export interface LibraryFile {
	name: string;
	path: string;
	relativePath: string;
	extension: string;
	size: number;
	modifiedAt: string;
}
