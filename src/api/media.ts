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
  // IdentityTransformStream 是 Workers 专为字节流提供的实现，bytes pass-through 不经 chunk
  // 转换层，且与 streaming Response body 寿命绑定（无需 ctx.waitUntil 持有）。
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();

  // 背景写入：streaming Response body 还在被 readable 端消费时，runtime 会保活整条 pipeline。
  // 不要用 ctx.waitUntil 包裹——那是把任务挪出 response 生命周期，反而可能与 stream 解耦。
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
            // 必须拷贝：value 指向 R2 reader 内部 buffer，可能在下次 read() 时被复用。
            // 直接传给 writer 会让已 enqueue 但下游未消费的 chunk 被新数据覆盖。
            await writer.write(new Uint8Array(value));
          }
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
        if (size > 0xFFFFFFFF) {
          throw new Error(`File too large for zip32: ${meta.name} (${size} bytes)`);
        }
        const finalCrc = crc32Final(crc);

        const descriptor = buildDataDescriptor(finalCrc, size);
        await writer.write(descriptor);

        centralDir.push(buildCentralDirEntry(fileName, finalCrc, size, offset));
        offset += localHeader.length + size + descriptor.length;
        if (offset > 0xFFFFFFFF) {
          throw new Error(`Zip would exceed 4GB limit at file: ${meta.name}`);
        }
      }

      let cdSize = 0;
      for (const cd of centralDir) {
        await writer.write(cd);
        cdSize += cd.length;
      }
      if (cdSize > 0xFFFFFFFF || offset > 0xFFFFFFFF) {
        throw new Error('Zip exceeds 4GB limit (central directory)');
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

const CRC32_TABLES: Uint32Array[] = (() => {
  const t: Uint32Array[] = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[0]![n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[0]![n]!;
    for (let k = 1; k < 8; k++) {
      c = (t[0]![c & 0xff]! ^ (c >>> 8)) >>> 0;
      t[k]![n] = c;
    }
  }
  return t;
})();

function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc >>> 0;
  let i = 0;
  const len = data.length;
  const aligned = len - (len % 8);

  // 主循环：每次吃 8 字节
  while (i < aligned) {
    const b0 = data[i]!,     b1 = data[i + 1]!, b2 = data[i + 2]!, b3 = data[i + 3]!;
    const b4 = data[i + 4]!, b5 = data[i + 5]!, b6 = data[i + 6]!, b7 = data[i + 7]!;
    const lo = ((c ^ b0) & 0xff) | (((c >>> 8) ^ b1) & 0xff) << 8 | (((c >>> 16) ^ b2) & 0xff) << 16 | (((c >>> 24) ^ b3) & 0xff) << 24;
    c = (
      CRC32_TABLES[7]![lo & 0xff]! ^
      CRC32_TABLES[6]![(lo >>> 8) & 0xff]! ^
      CRC32_TABLES[5]![(lo >>> 16) & 0xff]! ^
      CRC32_TABLES[4]![(lo >>> 24) & 0xff]! ^
      CRC32_TABLES[3]![b4]! ^
      CRC32_TABLES[2]![b5]! ^
      CRC32_TABLES[1]![b6]! ^
      CRC32_TABLES[0]![b7]!
    ) >>> 0;
    i += 8;
  }

  // 尾巴 byte-wise
  while (i < len) {
    c = (CRC32_TABLES[0]![(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
    i++;
  }

  return c;
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
