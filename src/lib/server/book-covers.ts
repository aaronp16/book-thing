import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import sharp from 'sharp';

const MAX_STORED_COVER_WIDTH = 1200;
const MAX_THUMBNAIL_WIDTH = 600;
const COVER_JPEG_QUALITY = 80;

export function detectImageContentType(bytes: Buffer): string {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return 'image/png';
	}
	if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF87a') {
		return 'image/gif';
	}
	if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
		return 'image/gif';
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
		bytes.subarray(8, 12).toString('ascii') === 'WEBP'
	) {
		return 'image/webp';
	}
	return 'application/octet-stream';
}

export function createBookCoverPlaceholderSvg(title: string): string {
	const safeTitle = title
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
  <rect width="600" height="900" fill="#111827" />
  <rect x="36" y="36" width="528" height="828" rx="18" fill="#1f2937" stroke="#374151" stroke-width="4" />
  <text x="300" y="390" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#e5e7eb">No Cover</text>
  <text x="300" y="450" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#9ca3af">${safeTitle}</text>
</svg>`;
}

function getSidecarCoverPath(bookPath: string): string {
	const dir = path.dirname(bookPath);
	const stem = path.basename(bookPath, path.extname(bookPath));
	return path.join(dir, `${stem}.cover.jpg`);
}

async function fetchUrl(url: string): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const client = url.startsWith('https:') ? https : http;
		client
			.get(url, (res) => {
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location
				) {
					resolve(fetchUrl(res.headers.location));
					return;
				}
				if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
					reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
					return;
				}
				const chunks: Buffer[] = [];
				res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
				res.on('end', () => resolve(Buffer.concat(chunks)));
				res.on('error', reject);
			})
			.on('error', reject);
	});
}

async function normalizeCoverBytes(imageBytes: Buffer, maxWidth: number): Promise<Buffer> {
	if (imageBytes.length < 100) return imageBytes;

	try {
		return await sharp(imageBytes, { failOn: 'none' })
			.rotate()
			.resize({ width: maxWidth, withoutEnlargement: true })
			.jpeg({ quality: COVER_JPEG_QUALITY, mozjpeg: true })
			.toBuffer();
	} catch {
		return imageBytes;
	}
}

export async function findSidecarCover(bookPath: string): Promise<string | null> {
	const coverPath = getSidecarCoverPath(bookPath);
	try {
		const stat = await fs.stat(coverPath);
		if (!stat.isFile() || stat.size < 100) return null;
		return coverPath;
	} catch {
		return null;
	}
}

export async function saveCoverFromBytesForBook(
	bookPath: string,
	imageBytes: Buffer
): Promise<string | null> {
	if (imageBytes.length < 100) return null;
	const normalizedBytes = await normalizeCoverBytes(imageBytes, MAX_STORED_COVER_WIDTH);
	const coverPath = getSidecarCoverPath(bookPath);
	await fs.writeFile(coverPath, normalizedBytes);
	return coverPath;
}

export async function saveCoverFromUrlForBook(
	bookPath: string,
	coverUrl: string
): Promise<string | null> {
	const imageBytes = await fetchUrl(coverUrl);
	if (imageBytes.length < 1000) return null;
	return saveCoverFromBytesForBook(bookPath, imageBytes);
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

async function getJpegDimensions(buf: Buffer): Promise<{ width: number; height: number } | null> {
	try {
		const meta = await sharp(buf, { failOn: 'none' }).metadata();
		if (meta.width && meta.height) return { width: meta.width, height: meta.height };
	} catch {
		// fall through
	}
	return null;
}

async function embedCoverInEpub(bookPath: string, imageBytes: Buffer): Promise<boolean> {
	try {
		const normalizedBytes = await normalizeCoverBytes(imageBytes, MAX_STORED_COVER_WIDTH);
		const buf = await fs.readFile(bookPath);
		const zip = unzipSync(new Uint8Array(buf));

		const containerXml = zip['META-INF/container.xml'];
		if (!containerXml) return false;
		const containerStr = strFromU8(containerXml);
		const opfMatch = containerStr.match(/full-path="([^"]+\.opf)"/i);
		if (!opfMatch) return false;
		const opfPath = opfMatch[1];
		const opfData = zip[opfPath];
		if (!opfData) return false;

		let opf = strFromU8(opfData);
		const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
		const coverFileName = 'book-thing-cover.jpg';
		const coverFullPath = `${opfDir}${coverFileName}`;

		zip[coverFullPath] = new Uint8Array(normalizedBytes);

		const manifestItem =
			'<item id="bookthing-cover" href="book-thing-cover.jpg" media-type="image/jpeg" properties="cover-image"/>';
		if (!/id=["']bookthing-cover["']/i.test(opf)) {
			if (/<manifest[^>]*>/i.test(opf)) {
				opf = opf.replace(/<manifest([^>]*)>/i, `<manifest$1>${manifestItem}`);
			} else {
				return false;
			}
		}

		// Strip properties="cover-image" from every manifest item that isn't ours,
		// so the Kobo (and other readers) don't see two competing cover declarations.
		opf = opf.replace(
			/(<item\b(?![^>]*\bid=["']bookthing-cover["'])[^>]*?)\s+properties=["']cover-image["']([^>]*?\/>)/gi,
			'$1$2'
		);
		// Also handle properties containing cover-image alongside other values
		opf = opf.replace(
			/(<item\b(?![^>]*\bid=["']bookthing-cover["'])[^>]*?)\s+properties=["']([^"']*)\bcover-image\b([^"']*)["']([^>]*?\/>)/gi,
			(_, before, pre, post, after) => {
				const remaining = `${pre}${post}`.trim();
				return remaining ? `${before} properties="${remaining}"${after}` : `${before}${after}`;
			}
		);

		if (/<meta\b[^>]+\bname=["']cover["']/i.test(opf)) {
			opf = opf.replace(
				/<meta\b([^>]*?)\bname=["']cover["']([^>]*?)\bcontent=["'][^"']*["']([^>]*?)\/>/i,
				'<meta$1name="cover"$2content="bookthing-cover"$3/>'
			);
			opf = opf.replace(
				/<meta\b([^>]*?)\bcontent=["'][^"']*["']([^>]*?)\bname=["']cover["']([^>]*?)\/>/i,
				'<meta$1content="bookthing-cover"$2name="cover"$3/>'
			);
		} else if (/<metadata[^>]*>/i.test(opf)) {
			opf = opf.replace(
				/<metadata([^>]*)>/i,
				`<metadata$1><meta name="cover" content="bookthing-cover"/>`
			);
		} else {
			return false;
		}

		zip[opfPath] = new TextEncoder().encode(opf);

		// Patch the titlepage.xhtml referenced by <guide type="cover"> so the
		// Kobo's guide-based cover extraction also picks up our cover image.
		// The Kobo follows the guide reference and extracts the first image from
		// that page — which would otherwise remain pointing at the original cover.
		const guideCoverMatch =
			opf.match(/<reference\b[^>]+\btype=["']cover["'][^>]+\bhref=["']([^"'#]+)[^"']*["']/i) ??
			opf.match(/<reference\b[^>]+\bhref=["']([^"'#]+)[^"']*["'][^>]+\btype=["']cover["']/i);
		if (guideCoverMatch) {
			const titlepageHref = guideCoverMatch[1];
			const titlepageFullPath = `${opfDir}${titlepageHref}`;
			const titlepageData = zip[titlepageFullPath];
			if (titlepageData) {
				// Compute relative path from the titlepage's directory to our cover
				const tpDir = titlepageFullPath.includes('/')
					? titlepageFullPath.slice(0, titlepageFullPath.lastIndexOf('/') + 1)
					: '';
				// e.g. opfDir="", coverFullPath="book-thing-cover.jpg", tpDir="text/"
				// => rel = "../book-thing-cover.jpg"
				const coverRelToTp = path.posix.relative(tpDir, coverFullPath);

				const dims = await getJpegDimensions(normalizedBytes);
				const w = dims?.width ?? 600;
				const h = dims?.height ?? 900;

				const newTitlepage = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
    <meta name="calibre:cover" content="true"/>
    <title>Cover</title>
    <style type="text/css">@page{padding:0pt;margin:0pt}body{text-align:center;padding:0pt;margin:0pt}</style>
  </head>
  <body>
    <div>
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
           width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <image width="${w}" height="${h}" xlink:href="${xmlEscape(coverRelToTp)}"/>
      </svg>
    </div>
  </body>
</html>`;
				zip[titlepageFullPath] = new TextEncoder().encode(newTitlepage);
			}
		}

		const updated = zipSync(zip, { level: 0 });
		await fs.writeFile(bookPath, Buffer.from(updated));
		return true;
	} catch {
		return false;
	}
}

export async function saveCoverForBook(
	bookPath: string,
	imageBytes: Buffer
): Promise<'embedded' | 'sidecar' | null> {
	if (imageBytes.length < 100) return null;
	if (path.extname(bookPath).toLowerCase() === '.epub') {
		const embedded = await embedCoverInEpub(bookPath, imageBytes);
		if (embedded) {
			return 'embedded';
		}
	}

	const sidecar = await saveCoverFromBytesForBook(bookPath, imageBytes);
	return sidecar ? 'sidecar' : null;
}

export async function createResizedCoverBytes(
	imageBytes: Buffer,
	requestedWidth: number
): Promise<Buffer> {
	const width = Math.max(1, Math.min(Math.round(requestedWidth), MAX_THUMBNAIL_WIDTH));
	return normalizeCoverBytes(imageBytes, width);
}

export async function saveCoverFromUrlForBookWithFallback(
	bookPath: string,
	coverUrl: string
): Promise<'embedded' | 'sidecar' | null> {
	const imageBytes = await fetchUrl(coverUrl);
	if (imageBytes.length < 1000) return null;
	return saveCoverForBook(bookPath, imageBytes);
}

export async function extractEmbeddedCoverBytes(bookPath: string): Promise<Buffer | null> {
	if (path.extname(bookPath).toLowerCase() !== '.epub') return null;
	try {
		const buf = await fs.readFile(bookPath);
		const zip = unzipSync(new Uint8Array(buf));

		const containerXml = zip['META-INF/container.xml'];
		if (!containerXml) return null;
		const containerStr = strFromU8(containerXml);
		const opfMatch = containerStr.match(/full-path="([^"]+\.opf)"/i);
		if (!opfMatch) return null;
		const opfPath = opfMatch[1];
		const opfData = zip[opfPath];
		if (!opfData) return null;
		const opf = strFromU8(opfData);
		const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

		const itemById = new Map<string, { href: string; mediaType: string }>();
		for (const match of opf.matchAll(/<item\b([^>]+?)\/>/gi)) {
			const attrs = match[1];
			const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
			const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
			const mediaTypeMatch = attrs.match(/\bmedia-type=["']([^"']+)["']/i);
			if (idMatch && hrefMatch && mediaTypeMatch?.[1]?.startsWith('image/')) {
				itemById.set(idMatch[1], { href: hrefMatch[1], mediaType: mediaTypeMatch[1] });
			}
		}

		function getImageData(href: string): Uint8Array | null {
			return zip[opfDir + href] ?? zip[href] ?? null;
		}

		let imageData: Uint8Array | null = null;
		const metaCoverMatch =
			opf.match(/<meta\b[^>]+\bname=["']cover["'][^>]+\bcontent=["']([^"']+)["']/i) ??
			opf.match(/<meta\b[^>]+\bcontent=["']([^"']+)["'][^>]+\bname=["']cover["']/i);
		if (metaCoverMatch) {
			const item = itemById.get(metaCoverMatch[1]);
			if (item) imageData = getImageData(item.href);
		}

		if (!imageData) {
			const propMatch = opf.match(
				/<item\b[^>]+\bproperties=["'][^"']*cover-image[^"']*["'][^>]+?\/>/i
			);
			if (propMatch) {
				const hrefMatch = propMatch[0].match(/\bhref=["']([^"']+)["']/i);
				if (hrefMatch) imageData = getImageData(hrefMatch[1]);
			}
		}

		if (!imageData) {
			const item = itemById.get('cover');
			if (item) imageData = getImageData(item.href);
		}

		if (!imageData || imageData.length < 100) return null;
		return Buffer.from(imageData);
	} catch {
		return null;
	}
}

export async function extractEmbeddedCoverDataUrl(bookPath: string): Promise<string | null> {
	const imageBytes = await extractEmbeddedCoverBytes(bookPath);
	if (!imageBytes) return null;
	return `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
}

export async function searchOpenLibraryCovers(title: string, author: string): Promise<string[]> {
	async function query(params: URLSearchParams): Promise<string[]> {
		params.set('limit', '10');
		params.set('fields', 'cover_i,cover_edition_key');
		const buf = await fetchUrl(`https://openlibrary.org/search.json?${params}`);
		const results = JSON.parse(buf.toString('utf8'));
		const urls: string[] = [];
		for (const doc of results?.docs ?? []) {
			if (doc.cover_i) {
				urls.push(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`);
			} else if (doc.cover_edition_key) {
				urls.push(`https://covers.openlibrary.org/b/olid/${doc.cover_edition_key}-L.jpg`);
			}
		}
		return urls;
	}

	try {
		if (author) {
			const precise = await query(new URLSearchParams({ title, author }));
			if (precise.length > 0) return precise;
		}
		return await query(new URLSearchParams({ title }));
	} catch {
		return [];
	}
}

export async function searchGoogleBooksCovers(title: string, author: string): Promise<string[]> {
	try {
		const q = author ? `${title} ${author}` : title;
		const params = new URLSearchParams({ q, maxResults: '10' });
		const buf = await fetchUrl(`https://www.googleapis.com/books/v1/volumes?${params}`);
		const data = JSON.parse(buf.toString('utf8'));
		const urls: string[] = [];
		for (const item of data?.items ?? []) {
			const volumeId = item?.id;
			if (!volumeId) continue;
			urls.push(
				`https://books.google.com/books/content?id=${volumeId}&printsec=frontcover&img=1&zoom=0&source=gbs_api`
			);
		}
		return urls;
	} catch {
		return [];
	}
}
