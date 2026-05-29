import type { Env, FileMeta } from '../utils/types';
import { json, error } from '../utils/response';
import { parseJson } from '../utils/validate';
import { extractPathParam } from '../utils/keys';
import { streamR2Object } from '../utils/r2';
import { getFile } from '../db/files';

export async function thumbnail(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);
  if (!meta.type.startsWith('image/')) return error('Not an image', 400);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  return streamR2Object(object, request, {
    cacheControl: 'public, max-age=14400, s-maxage=86400',
  });
}

export async function preview(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  return streamR2Object(object, request, {
    cacheControl: 'private, max-age=3600',
    acceptRanges: true,
    headers: {
      'Content-Type': meta.type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(meta.name)}"`,
    },
  });
}

export async function zipDownload(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ ids: string[] }>(request);
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.ids.length > 100) return error('Max 100 files per zip', 400);

  const fetchedMetas = await Promise.all(body.ids.map((id) => getFile(env, id)));
  const fileMetas: FileMeta[] = fetchedMetas.filter((m): m is FileMeta => m !== null);
  if (fileMetas.length === 0) return error('No valid files found', 404);

  if (fileMetas.length === 1) {
    const meta = fileMetas[0]!;
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) return error('File not found in storage', 404);
    return streamR2Object(object, request, {
      headers: {
        'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.name)}"`,
      },
    });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Stream zip body asynchronously; do not await before returning Response.
  (async () => {
    try {
      let offset = 0;
      const centralDir: Uint8Array[] = [];

      for (const meta of fileMetas) {
        const obj = await env.VAULT_BUCKET.get(meta.key);
        if (!obj) continue;

        const fileName = encoder.encode(meta.name);
        const localHeader = buildLocalHeader(fileName);
        await writer.write(localHeader);

        let crc = CRC32_INIT;
        let size = 0;
        const reader = obj.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            crc = crc32Update(crc, value);
            size += value.length;
            await writer.write(value);
          }
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
        const finalCrc = crc32Final(crc);

        const descriptor = buildDataDescriptor(finalCrc, size);
        await writer.write(descriptor);

        centralDir.push(buildCentralDirEntry(fileName, finalCrc, size, offset));
        offset += localHeader.length + size + descriptor.length;
      }

      let cdSize = 0;
      for (const cd of centralDir) {
        await writer.write(cd);
        cdSize += cd.length;
      }
      await writer.write(buildEOCD(centralDir.length, cdSize, offset));
    } catch (err) {
      try { await writer.abort(err); } catch { /* ignore */ }
      return;
    }
    await writer.close();
  })();

  const zipName = 'cloudvault-' + new Date().toISOString().slice(0, 10) + '.zip';
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + zipName + '"',
    },
  });
}

const CRC32_INIT = 0xFFFFFFFF;

function crc32Update(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc;
}

function crc32Final(crc: number): number {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildLocalHeader(fileName: Uint8Array): Uint8Array {
  const buf = new Uint8Array(30 + fileName.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0008, true); // GP flag: bit 3 = data descriptor follows
  v.setUint16(8, 0, true);      // stored
  v.setUint16(10, 0, true);     // mod time
  v.setUint16(12, 0, true);     // mod date
  v.setUint32(14, 0, true);     // crc32 = 0 (in data descriptor)
  v.setUint32(18, 0, true);     // compressed size = 0
  v.setUint32(22, 0, true);     // uncompressed size = 0
  v.setUint16(26, fileName.length, true);
  v.setUint16(28, 0, true);     // extra length
  buf.set(fileName, 30);
  return buf;
}

function buildDataDescriptor(crc: number, size: number): Uint8Array {
  const buf = new Uint8Array(16);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, crc, true);
  v.setUint32(8, size, true);   // compressed size (stored = uncompressed)
  v.setUint32(12, size, true);  // uncompressed size
  return buf;
}

function buildCentralDirEntry(
  fileName: Uint8Array,
  crc: number,
  size: number,
  localHeaderOffset: number,
): Uint8Array {
  const buf = new Uint8Array(46 + fileName.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);     // version made by
  v.setUint16(6, 20, true);     // version needed
  v.setUint16(8, 0x0008, true); // GP flag: bit 3
  v.setUint16(10, 0, true);     // stored
  v.setUint16(12, 0, true);     // mod time
  v.setUint16(14, 0, true);     // mod date
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);  // compressed size
  v.setUint32(24, size, true);  // uncompressed size
  v.setUint16(28, fileName.length, true);
  v.setUint16(30, 0, true);     // extra length
  v.setUint16(32, 0, true);     // comment length
  v.setUint16(34, 0, true);     // disk number
  v.setUint16(36, 0, true);     // internal attrs
  v.setUint32(38, 0, true);     // external attrs
  v.setUint32(42, localHeaderOffset, true);
  buf.set(fileName, 46);
  return buf;
}

function buildEOCD(entryCount: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true);              // disk number
  v.setUint16(6, 0, true);              // disk with cd
  v.setUint16(8, entryCount, true);     // entries on this disk
  v.setUint16(10, entryCount, true);    // total entries
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, 0, true);             // comment length
  return buf;
}
