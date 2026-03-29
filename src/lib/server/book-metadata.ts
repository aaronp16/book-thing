import * as fs from 'fs/promises';
import * as path from 'path';
import { strFromU8, unzipSync } from 'fflate';

export interface BookMetadata {
	title: string;
	author: string;
}

export function parseFilenameMetadata(filename: string): BookMetadata {
	const stem = path.basename(filename, path.extname(filename));
	const cleaned = stem.replace(/\s*\([A-Za-z0-9]+\)\s*$/, '').trim();
	const dashMatch = cleaned.match(/^(.+?)\s+-\s+(.+)$/);
	if (dashMatch) {
		return { title: dashMatch[1].trim(), author: dashMatch[2].trim() };
	}
	return { title: cleaned, author: 'Unknown' };
}

function parseFilenameAuthor(filename: string): string {
	return parseFilenameMetadata(filename).author;
}

export async function readEpubMetadata(filePath: string): Promise<BookMetadata> {
	const filename = path.basename(filePath);
	try {
		const buf = await fs.readFile(filePath);
		const zip = unzipSync(new Uint8Array(buf));

		const containerXml = zip['META-INF/container.xml'];
		if (!containerXml) throw new Error('No META-INF/container.xml');
		const containerStr = strFromU8(containerXml);
		const opfMatch = containerStr.match(/full-path="([^"]+\.opf)"/i);
		if (!opfMatch) throw new Error('No OPF path in container.xml');
		const opfPath = opfMatch[1];

		const opfData = zip[opfPath];
		if (!opfData) throw new Error(`OPF file not found in zip: ${opfPath}`);
		const opf = strFromU8(opfData);

		const titleMatch = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
		const authorMatch = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);

		const title = titleMatch?.[1]?.trim() || null;
		const author = authorMatch?.[1]?.trim() || null;

		if (title && author) return { title, author };
		if (title) return { title, author: parseFilenameAuthor(filename) };
		throw new Error('Missing dc:title in OPF');
	} catch {
		return parseFilenameMetadata(filename);
	}
}

export async function readMobiMetadata(filePath: string): Promise<BookMetadata> {
	const filename = path.basename(filePath);
	try {
		const fh = await fs.open(filePath, 'r');
		const headerBuf = Buffer.alloc(16384);
		const { bytesRead } = await fh.read(headerBuf, 0, 16384, 0);
		await fh.close();
		const buf = headerBuf.subarray(0, bytesRead);

		if (buf.length < 78) throw new Error('File too small');
		const numRecords = buf.readUInt16BE(0x4c);
		if (numRecords < 1) throw new Error('No PalmDB records');

		const rec0Offset = buf.readUInt32BE(0x4e);
		if (rec0Offset + 32 > buf.length) throw new Error('Record 0 out of range');

		const mobiStart = rec0Offset + 32;
		if (mobiStart + 4 > buf.length) throw new Error('MOBI header out of range');
		const mobiMagic = buf.subarray(mobiStart, mobiStart + 4).toString('ascii');
		if (mobiMagic !== 'MOBI') throw new Error(`Expected MOBI magic, got "${mobiMagic}"`);

		const mobiHeaderLen = buf.readUInt32BE(mobiStart + 4);
		const titleOffset = buf.readUInt32BE(mobiStart + 0x14);
		const titleLength = buf.readUInt32BE(mobiStart + 0x18);
		const titleStart = rec0Offset + titleOffset;

		let title: string | null = null;
		if (titleLength > 0 && titleStart + titleLength <= buf.length) {
			title = buf
				.subarray(titleStart, titleStart + titleLength)
				.toString('utf8')
				.trim();
		}

		const exthStart = mobiStart + mobiHeaderLen;
		let author: string | null = null;
		let exthTitle: string | null = null;

		if (exthStart + 12 <= buf.length) {
			const exthMagic = buf.subarray(exthStart, exthStart + 4).toString('ascii');
			if (exthMagic === 'EXTH') {
				const exthRecordCount = buf.readUInt32BE(exthStart + 8);
				let pos = exthStart + 12;
				for (let i = 0; i < exthRecordCount && pos + 8 <= buf.length; i++) {
					const recType = buf.readUInt32BE(pos);
					const recLen = buf.readUInt32BE(pos + 4);
					if (recLen < 8) break;
					const data = buf
						.subarray(pos + 8, pos + recLen)
						.toString('utf8')
						.trim();
					if (recType === 100) author = data;
					if (recType === 503) exthTitle = data;
					pos += recLen;
				}
			}
		}

		const finalTitle = (exthTitle || title || '').trim() || null;
		const finalAuthor = (author || '').trim() || null;
		if (finalTitle && finalAuthor) return { title: finalTitle, author: finalAuthor };
		if (finalTitle) return { title: finalTitle, author: parseFilenameAuthor(filename) };
		throw new Error('No title found in MOBI headers');
	} catch {
		return parseFilenameMetadata(filename);
	}
}

export async function readPdfMetadata(filePath: string): Promise<BookMetadata> {
	const filename = path.basename(filePath);
	try {
		const stat = await fs.stat(filePath);
		const fh = await fs.open(filePath, 'r');

		const chunkSize = 65536;
		const buf1 = Buffer.alloc(Math.min(chunkSize, stat.size));
		await fh.read(buf1, 0, buf1.length, 0);
		const tailOffset = Math.max(0, stat.size - chunkSize);
		const buf2 = Buffer.alloc(Math.min(chunkSize, stat.size - tailOffset));
		await fh.read(buf2, 0, buf2.length, tailOffset);
		await fh.close();

		const text = buf1.toString('latin1') + buf2.toString('latin1');

		function decodePdfString(raw: string): string {
			if (raw.startsWith('<')) {
				const hex = raw.slice(1, -1).replace(/\s/g, '');
				const bytes = Buffer.from(hex, 'hex');
				if (bytes[0] === 0xfe && bytes[1] === 0xff) {
					return bytes.subarray(2).toString('utf16le');
				}
				return bytes.toString('latin1');
			}
			return raw
				.slice(1, -1)
				.replace(/\\n/g, '\n')
				.replace(/\\r/g, '\r')
				.replace(/\\t/g, '\t')
				.replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
				.replace(/\\(.)/g, '$1');
		}

		function extractField(field: string): string | null {
			const re = new RegExp(`/${field}\\s*(\\([^)]*\\)|<[^>]*>)`, 'i');
			const match = text.match(re);
			if (!match) return null;
			return decodePdfString(match[1]).trim() || null;
		}

		const title = extractField('Title');
		const author = extractField('Author');
		if (title && author) return { title, author };
		if (title) return { title, author: parseFilenameAuthor(filename) };
		throw new Error('No /Title in PDF Info dictionary');
	} catch {
		return parseFilenameMetadata(filename);
	}
}

export async function readBookMetadata(filePath: string): Promise<BookMetadata> {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.epub') return readEpubMetadata(filePath);
	if (ext === '.mobi' || ext === '.azw' || ext === '.azw3') return readMobiMetadata(filePath);
	if (ext === '.pdf') return readPdfMetadata(filePath);
	return parseFilenameMetadata(path.basename(filePath));
}
