/**
 * Read metadata embedded in book files.
 *
 * EPUB and KEPUB are zip archives; META-INF/container.xml points at an OPF
 * file whose <metadata> block holds Dublin Core fields (dc:title, dc:creator,
 * ...) plus <meta> extras such as Calibre's series info.
 *
 * Covers are written back into the file (not as sidecar images) because Kobo
 * only reads covers embedded in the book.
 */

import { readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { BookMetadata } from '$lib/types.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function decodeEntities(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/** Descriptions are often HTML (sometimes entity-escaped); reduce to plain text */
function htmlToText(html: string): string {
	return decodeEntities(
		decodeEntities(html)
			.replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
			.replace(/<[^>]+>/g, '')
	)
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n\n')
		.trim();
}

function getAttr(attrs: string, name: string): string | undefined {
	const match = attrs.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
	return match ? decodeEntities(match[2]) : undefined;
}

/** All <dc:{tag}> elements as { text, attrs } */
function dcElements(xml: string, tag: string): { text: string; attrs: string }[] {
	const re = new RegExp(`<dc:${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</dc:${tag}>)`, 'gi');
	return [...xml.matchAll(re)]
		.map((m) => ({ attrs: m[1] ?? '', text: decodeEntities((m[2] ?? '').trim()) }))
		.filter((el) => el.text);
}

/** EPUB2 <meta name="x" content="y"/> */
function metaContent(xml: string, name: string): string | undefined {
	for (const m of xml.matchAll(/<meta\b([^>]*?)\/?>/gi)) {
		if (getAttr(m[1], 'name') === name) return getAttr(m[1], 'content');
	}
	return undefined;
}

/** EPUB3 <meta property="x">y</meta> */
function metaProperty(xml: string, property: string): string | undefined {
	for (const m of xml.matchAll(/<meta\b([^>]*?)>([\s\S]*?)<\/meta>/gi)) {
		if (getAttr(m[1], 'property') === property) return decodeEntities(m[2].trim());
	}
	return undefined;
}

function findIsbn(identifiers: { text: string; attrs: string }[]): string | undefined {
	for (const { text, attrs } of identifiers) {
		const scheme = getAttr(attrs, 'scheme')?.toLowerCase();
		const digits = text.replace(/^urn:isbn:/i, '').replace(/[-\s]/g, '');
		if ((scheme === 'isbn' || /^urn:isbn:/i.test(text)) && /^\d{9}[\dx]$|^\d{13}$/i.test(digits)) {
			return digits;
		}
	}
	// Fall back to any bare 13-digit 978/979 identifier
	return identifiers.map((i) => i.text.replace(/[-\s]/g, '')).find((t) => /^97[89]\d{10}$/.test(t));
}

/** Calibre writes 0101-01-01 for "no date" */
function cleanDate(raw: string | undefined): string | undefined {
	if (!raw || raw.startsWith('0101')) return undefined;
	return raw.slice(0, 10);
}

function parseOpf(xml: string): BookMetadata {
	const metadataBlock = xml.match(/<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/i)?.[0] ?? xml;
	const identifiers = dcElements(metadataBlock, 'identifier');
	const description = dcElements(metadataBlock, 'description')[0]?.text;
	const seriesIndex = metaContent(metadataBlock, 'calibre:series_index');
	const rating = Number(metaContent(metadataBlock, 'calibre:rating'));
	const language = dcElements(metadataBlock, 'language')[0]?.text;

	return {
		title: dcElements(metadataBlock, 'title')[0]?.text,
		authors: dcElements(metadataBlock, 'creator').map((el) => el.text),
		series:
			metaContent(metadataBlock, 'calibre:series') ??
			metaProperty(metadataBlock, 'belongs-to-collection'),
		seriesIndex: seriesIndex ? Number(seriesIndex) : undefined,
		publisher: dcElements(metadataBlock, 'publisher')[0]?.text,
		published: cleanDate(dcElements(metadataBlock, 'date')[0]?.text),
		language: language && language !== 'und' ? language : undefined,
		isbn: findIsbn(identifiers),
		subjects: [...new Set(dcElements(metadataBlock, 'subject').map((el) => el.text))],
		// Calibre stores ratings 0-10 (half-stars); show out of 5
		rating: rating > 0 ? rating / 2 : undefined,
		description: description ? htmlToText(description) : undefined
	};
}

interface OpenedEpub {
	archive: Uint8Array;
	opfPath: string;
	opf: string;
}

/** Unzip just the container and OPF of an EPUB/KEPUB */
async function openEpub(absolutePath: string): Promise<OpenedEpub | null> {
	if (!/\.(epub|kepub)$/i.test(absolutePath)) return null;
	return parseEpub(new Uint8Array(await readFile(absolutePath)));
}

function parseEpub(archive: Uint8Array): OpenedEpub | null {
	const container = unzipSync(archive, { filter: (f) => f.name === 'META-INF/container.xml' })[
		'META-INF/container.xml'
	];
	if (!container) return null;

	const opfPath = decoder.decode(container).match(/full-path\s*=\s*["']([^"']+)["']/)?.[1];
	if (!opfPath) return null;

	const opf = unzipSync(archive, { filter: (f) => f.name === opfPath })[opfPath];
	return opf ? { archive, opfPath, opf: decoder.decode(opf) } : null;
}

/**
 * Read embedded metadata from a book file. Returns null for formats we can't
 * parse (e.g. MOBI) or files without readable metadata.
 */
export async function readBookMetadata(absolutePath: string): Promise<BookMetadata | null> {
	const epub = await openEpub(absolutePath);
	return epub ? parseOpf(epub.opf) : null;
}

interface ManifestItem {
	/** The full <item .../> tag as it appears in the OPF */
	tag: string;
	id?: string;
	href: string;
	mediaType: string;
	properties: string;
}

function parseManifest(opf: string): ManifestItem[] {
	return [...opf.matchAll(/<(?:\w+:)?item\b([^>]*?)\/?>/gi)]
		.map((m) => ({
			tag: m[0],
			id: getAttr(m[1], 'id'),
			href: getAttr(m[1], 'href') ?? '',
			mediaType: getAttr(m[1], 'media-type') ?? '',
			properties: getAttr(m[1], 'properties') ?? ''
		}))
		.filter((item) => item.href);
}

/**
 * Locate the cover image in the manifest: EPUB3 properties="cover-image",
 * then EPUB2 <meta name="cover" content="{item id}">, then any image item
 * whose id or filename mentions "cover".
 */
function findCoverItem(opf: string): ManifestItem | undefined {
	const images = parseManifest(opf).filter((item) => item.mediaType.startsWith('image/'));
	const coverId = metaContent(opf, 'cover');
	return (
		images.find((item) => item.properties.split(/\s+/).includes('cover-image')) ??
		images.find((item) => coverId !== undefined && item.id === coverId) ??
		images.find((item) => /cover/i.test(item.id ?? '') || /cover/i.test(item.href))
	);
}

/** Resolve a manifest href (relative to the OPF, URL-encoded) to a zip entry name */
function resolveZipPath(opfPath: string, href: string): string {
	const parts = opfPath.split('/').slice(0, -1);
	for (const segment of decodeURIComponent(href.split('#')[0]).split('/')) {
		if (segment === '..') parts.pop();
		else if (segment && segment !== '.') parts.push(segment);
	}
	return parts.join('/');
}

/**
 * Extract the embedded cover image from a book file, or null if it has none
 * (or the format isn't supported).
 */
export async function readBookCover(
	absolutePath: string
): Promise<{ data: Uint8Array; contentType: string } | null> {
	const epub = await openEpub(absolutePath);
	return epub ? extractCover(epub) : null;
}

function extractCover(epub: OpenedEpub): { data: Uint8Array; contentType: string } | null {
	const item = findCoverItem(epub.opf);
	if (!item) return null;

	const entry = resolveZipPath(epub.opfPath, item.href);
	const data = unzipSync(epub.archive, { filter: (f) => f.name === entry })[entry];
	return data ? { data, contentType: item.mediaType } : null;
}

function isJpeg(data: Uint8Array): boolean {
	return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

function setAttr(tag: string, name: string, value: string): string {
	const re = new RegExp(`(\\s${name}\\s*=\\s*)(["']).*?\\2`, 'i');
	return re.test(tag)
		? tag.replace(re, `$1"${value}"`)
		: tag.replace(/\s*(\/?>)$/, ` ${name}="${value}"$1`);
}

/** First name in `taken` not already used, trying base, base-2, base-3... */
function uniqueName(base: string, ext: string, taken: (name: string) => boolean): string {
	for (let n = 1; ; n++) {
		const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
		if (!taken(name)) return name;
	}
}

/**
 * Return a copy of the EPUB's entries and OPF with the cover set to `jpeg`.
 *
 * - Existing JPEG cover: bytes replaced in place, so pages that show it keep working.
 * - Existing non-JPEG cover: a .jpg is added beside it, the manifest item is
 *   repointed, and references in content documents are updated.
 * - No cover: an image item is added to the manifest with
 *   <meta name="cover"> (EPUB2) and properties="cover-image" (EPUB3).
 */
function applyCover(
	entries: Record<string, Uint8Array>,
	opfPath: string,
	opf: string,
	jpeg: Uint8Array
): string {
	const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
	const item = findCoverItem(opf);

	if (item && /^image\/jpe?g$/i.test(item.mediaType)) {
		entries[resolveZipPath(opfPath, item.href)] = jpeg;
		return opf;
	}

	if (item) {
		const oldEntry = resolveZipPath(opfPath, item.href);
		const hrefDir = item.href.includes('/')
			? item.href.slice(0, item.href.lastIndexOf('/') + 1)
			: '';
		const stem = path.posix.basename(oldEntry, path.posix.extname(oldEntry));
		const newName = uniqueName(
			stem,
			'.jpg',
			(name) => resolveZipPath(opfPath, hrefDir + name) in entries
		);
		const newEntry = resolveZipPath(opfPath, hrefDir + newName);

		delete entries[oldEntry];
		entries[newEntry] = jpeg;

		// Repoint pages/styles that showed the old image
		const oldBase = path.posix.basename(oldEntry);
		for (const [name, data] of Object.entries(entries)) {
			if (name === opfPath || !/\.(x?html?|css|ncx)$/i.test(name)) continue;
			const text = decoder.decode(data);
			if (text.includes(oldBase)) entries[name] = encoder.encode(text.split(oldBase).join(newName));
		}
		const renamedTag = item.tag.split(oldBase).join(newName);
		return opf
			.split(oldBase)
			.join(newName)
			.replace(renamedTag, setAttr(renamedTag, 'media-type', 'image/jpeg'));
	}

	const manifest = parseManifest(opf);
	const href = uniqueName('cover', '.jpg', (name) => opfDir + name in entries);
	const id = uniqueName('cover-image', '', (name) => manifest.some((i) => i.id === name));
	entries[opfDir + href] = jpeg;

	const isEpub3 = /<(?:\w+:)?package\b[^>]*\bversion\s*=\s*["']3/i.test(opf);
	opf = opf.replace(/<\/(\w+:)?manifest>/i, (close, prefix = '') => {
		const props = isEpub3 ? ' properties="cover-image"' : '';
		return `<${prefix}item id="${id}" href="${href}" media-type="image/jpeg"${props}/>\n${close}`;
	});

	const existingMeta = [...opf.matchAll(/<(?:\w+:)?meta\b([^>]*?)\/?>/gi)].find(
		(m) => getAttr(m[1], 'name') === 'cover'
	);
	if (existingMeta) {
		return opf.replace(existingMeta[0], setAttr(existingMeta[0], 'content', id));
	}
	return opf.replace(/<\/(\w+:)?metadata>/i, (close, prefix = '') => {
		return `<${prefix}meta name="cover" content="${id}"/>\n${close}`;
	});
}

/**
 * Embed `jpeg` as the cover of an EPUB/KEPUB file, in place.
 *
 * The archive is rebuilt with `mimetype` first and stored uncompressed (as
 * the EPUB spec requires; Kobo is strict about it), written to a temp file,
 * verified, then renamed over the original. The original modification time is
 * kept so the book doesn't jump to the top of "recently added".
 */
export async function writeBookCover(absolutePath: string, jpeg: Uint8Array): Promise<void> {
	if (!isJpeg(jpeg)) throw new Error('Cover must be a JPEG image');

	const epub = await openEpub(absolutePath);
	if (!epub) throw new Error('Only EPUB/KEPUB files can have their cover replaced');

	const entries = unzipSync(epub.archive);
	entries[epub.opfPath] = encoder.encode(applyCover(entries, epub.opfPath, epub.opf, jpeg));

	const files: Zippable = {};
	if (entries.mimetype) files.mimetype = [entries.mimetype, { level: 0 }];
	for (const [name, data] of Object.entries(entries)) {
		if (name === 'mimetype' || name.endsWith('/')) continue;
		// Images are already compressed
		files[name] = [data, { level: /\.(jpe?g|png|gif|webp)$/i.test(name) ? 0 : 6 }];
	}
	const output = zipSync(files);

	// Sanity check the rebuilt archive before it goes anywhere near the original
	const rebuilt = parseEpub(output);
	const check = rebuilt && extractCover(rebuilt);
	if (!check || check.data.length !== jpeg.length || check.contentType !== 'image/jpeg') {
		throw new Error('Rebuilt EPUB failed verification; original left untouched');
	}

	const original = await stat(absolutePath);
	const dir = path.dirname(absolutePath);
	// Dot-prefixed so library scans skip it
	const tempPath = path.join(dir, `.${path.basename(absolutePath)}.${process.pid}.tmp`);
	try {
		await writeFile(tempPath, output, { mode: original.mode });
		await utimes(tempPath, original.atime, original.mtime);
		await rename(tempPath, absolutePath);
	} catch (err) {
		await rm(tempPath, { force: true });
		throw err;
	}
}
