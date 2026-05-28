import type { Env, FileMeta } from '../utils/types';
import { json, error, getMimeType } from '../utils/response';
import { getSharedFolders, getExcludedFolders, isFolderShared } from './share';
import {
  getFile,
  putFile,
  deleteFile,
  listFilesInFolder,
  listFilesByFolderPrefix,
  searchFiles,
  listAllFiles,
} from '../db/files';
import {
  getFolder,
  putFolder,
  deleteFolder as dbDeleteFolder,
  deleteFoldersByPrefix,
  listAllFolders,
  listFoldersByPrefix,
  renameFolderRecord,
} from '../db/folders';
import {
  isFolderShareMarked,
  addFolderShare,
  removeFolderShare,
  isFolderExcluded,
  addFolderExclude,
  removeFolderExclude,
  deleteFolderShareLinkByFolder,
  deleteFolderShareLinksByFolderPrefix,
} from '../db/shares';

function extractId(url: URL): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf('files');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
}

export async function upload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'mpu-create') {
    return handleMultipartCreate(request, env);
  }
  if (action === 'mpu-upload') {
    return handleMultipartUpload(request, env, url);
  }
  if (action === 'mpu-complete') {
    return handleMultipartComplete(request, env);
  }

  return handleDirectUpload(request, env);
}

async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);

  const id = crypto.randomUUID();
  const key = folder === 'root' ? fileName : folder + '/' + fileName;

  if (!key || key.includes('..')) return error('Invalid file path', 400);

  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
    customMetadata: { fileId: id },
  });

  if (!r2Object) return error('Upload failed', 500);

  const meta: FileMeta = {
    id,
    key,
    name: fileName,
    size: r2Object.size,
    type: contentType,
    folder,
    uploadedAt: new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
  };

  await putFile(env, meta);

  return json(meta, 201);
}

async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const key = folder === 'root' ? fileName : folder + '/' + fileName;

  const multipart = await env.VAULT_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
  });

  return json({ uploadId: multipart.uploadId, key });
}

async function handleMultipartUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = parseInt(url.searchParams.get('partNumber') || '0', 10);
  const key = url.searchParams.get('key');

  if (!uploadId || !partNumber || !key) return error('Missing uploadId, partNumber, or key', 400);

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await multipart.uploadPart(partNumber, request.body as ReadableStream);

  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function handleMultipartComplete(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    uploadId: string;
    key: string;
    parts: { partNumber: number; etag: string }[];
  }>();

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
  const r2Object = await multipart.complete(body.parts);

  const fileName = body.key.split('/').pop() || body.key;
  const folder = body.key.includes('/') ? body.key.substring(0, body.key.lastIndexOf('/')) : 'root';
  const id = crypto.randomUUID();

  const meta: FileMeta = {
    id,
    key: body.key,
    name: fileName,
    size: r2Object.size,
    type: r2Object.httpMetadata?.contentType || getMimeType(fileName),
    folder,
    uploadedAt: new Date().toISOString(),
    shareToken: null,
    sharePassword: null,
    shareExpiresAt: null,
    downloads: 0,
  };

  await putFile(env, meta);

  return json(meta, 201);
}

export async function list(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folderFilter = url.searchParams.get('folder');
  const searchFilter = url.searchParams.get('search');

  let files: FileMeta[];
  if (searchFilter) {
    files = await searchFiles(env, searchFilter);
    if (folderFilter) {
      files = files.filter((f) => f.folder === folderFilter);
    }
  } else if (folderFilter) {
    files = await listFilesInFolder(env, folderFilter);
  } else {
    files = await listFilesInFolder(env, 'root');
  }

  return json({ files, cursor: null, totalFiles: files.length });
}

export async function get(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  return json(meta);
}

export async function download(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=14400');
  headers.set('Content-Disposition', 'attachment; filename="' + meta.name + '"');

  return new Response(object.body, { headers });
}

export async function deleteFiles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  let ids: string[];

  if (request.method === 'DELETE') {
    const id = extractId(url);
    if (!id) return error('File ID required', 400);
    ids = [id];
  } else {
    const body = await request.json<{ ids: string[] }>();
    ids = body.ids;
  }

  if (!ids || ids.length === 0) return error('No file IDs provided', 400);

  for (const id of ids) {
    const meta = await getFile(env, id);
    if (!meta) continue;

    await env.VAULT_BUCKET.delete(meta.key);
    await deleteFile(env, id);
  }

  return json({ deleted: ids.length });
}

export async function rename(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const body = await request.json<{ name: string }>();
  if (!body.name?.trim()) return error('Name required', 400);

  meta.name = body.name.trim();
  await putFile(env, meta);

  return json(meta);
}

export async function createFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name: string; parent: string }>();
  if (!body.name?.trim()) return error('Folder name required', 400);

  const folderName = body.parent === 'root' ? body.name.trim() : body.parent + '/' + body.name.trim();
  await putFolder(env, folderName, folderName);

  return json({ folder: folderName }, 201);
}

export async function deleteFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  // Delete folder records (this folder + all descendants)
  await dbDeleteFolder(env, folder);
  const deletedSubfolders = await deleteFoldersByPrefix(env, folder + '/');  await removeFolderShare(env, folder);
  await removeFolderExclude(env, folder);
  await deleteFolderShareLinkByFolder(env, folder);
  await deleteFolderShareLinksByFolderPrefix(env, folder + '/');

  const filesToDelete = await listFilesByFolderPrefix(env, folder);
  let deletedFiles = 0;
  for (const file of filesToDelete) {
    if (file.folder === folder || file.folder.startsWith(folder + '/')) {
      await env.VAULT_BUCKET.delete(file.key);
      await deleteFile(env, file.id);
      deletedFiles++;
    }
  }

  return json({ deleted: folder, deletedFiles, deletedSubfolders });
}

export async function renameFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ oldName: string; newName: string }>();
  if (!body.oldName?.trim() || !body.newName?.trim()) return error('Both old and new names required', 400);
  const oldName = body.oldName.trim();
  const newName = body.newName.trim();
  if (oldName === newName) return json({ folder: newName });

  // Rename the folder record itself
  const existing = await getFolder(env, oldName);
  if (existing) {
    await renameFolderRecord(env, oldName, newName, newName);
  } else {
    await putFolder(env, newName, newName);
  }

  // Rename sub-folder records
  const subFolders = await listFoldersByPrefix(env, oldName + '/');
  for (const sf of subFolders) {
    if (sf.path === oldName) continue;
    const newPath = newName + sf.path.slice(oldName.length);
    await renameFolderRecord(env, sf.path, newPath, newPath);
  }

  // Transfer share marks for the renamed folder and its descendants
  if (await isFolderShareMarked(env, oldName)) {
    await removeFolderShare(env, oldName);
    await addFolderShare(env, newName);
  }
  if (await isFolderExcluded(env, oldName)) {
    await removeFolderExclude(env, oldName);
    await addFolderExclude(env, newName);
  }

  // Move files (R2 + DB) for both the folder and its descendants
  const allMovingFiles = await listFilesByFolderPrefix(env, oldName);
  for (const file of allMovingFiles) {
    if (file.folder !== oldName && !file.folder.startsWith(oldName + '/')) continue;
    const newFolder = newName + file.folder.slice(oldName.length);
    const newKey = newFolder === 'root' ? file.name : newFolder + '/' + file.name;
    const obj = await env.VAULT_BUCKET.get(file.key);
    if (obj) {
      await env.VAULT_BUCKET.put(newKey, obj.body, {
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
      });
      await env.VAULT_BUCKET.delete(file.key);
    }
    file.key = newKey;
    file.folder = newFolder;
    await putFile(env, file);
  }

  return json({ folder: newName });
}

export async function listFolders(_request: Request, env: Env): Promise<Response> {
  const folderSet = new Set<string>();

  // From files (catches folders that have files but no folder record)
  const allFiles = await listAllFiles(env);
  for (const file of allFiles) {
    if (file.folder && file.folder !== 'root') {
      folderSet.add(file.folder);
    }
  }

  // From folder records (empty folders)
  const folderRecords = await listAllFolders(env);
  for (const fr of folderRecords) {
    if (fr.path) folderSet.add(fr.path);
  }

  // Ensure all intermediate parent folders are included in the set
  for (const folder of [...folderSet]) {
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      folderSet.add(path);
    }
  }

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const folderList = Array.from(folderSet).sort().map((name) => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
  }));

  return json({ folders: folderList });
}

export async function moveFiles(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ ids: string[]; targetFolder: string }>();
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.targetFolder === undefined) return error('Target folder required', 400);

  const targetFolder = body.targetFolder;
  let moved = 0;

  for (const id of body.ids) {
    const meta = await getFile(env, id);
    if (!meta) continue;
    if (meta.folder === targetFolder) continue;

    const newKey = targetFolder === 'root' ? meta.name : targetFolder + '/' + meta.name;

    const oldObject = await env.VAULT_BUCKET.get(meta.key);
    if (!oldObject) continue;

    await env.VAULT_BUCKET.put(newKey, oldObject.body, {
      httpMetadata: oldObject.httpMetadata,
      customMetadata: oldObject.customMetadata,
    });
    await env.VAULT_BUCKET.delete(meta.key);

    meta.key = newKey;
    meta.folder = targetFolder;
    await putFile(env, meta);
    moved++;
  }

  return json({ moved });
}

export async function thumbnail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  if (!meta.type.startsWith('image/')) return error('Not an image', 400);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');

  return new Response(object.body, { headers });
}

// ─── Inline Preview (admin) ───────────────────────────────────────────
export async function preview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const rangeHeader = request.headers.get('Range');

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', meta.type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('Accept-Ranges', 'bytes');

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const totalSize = object.size;
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (start >= totalSize || end >= totalSize || start > end) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': 'bytes */' + totalSize },
        });
      }
      headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + totalSize);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(object.body, { status: 206, headers });
    }
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

// ─── Zip Download (multiple files) ────────────────────────────────────
export async function zipDownload(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ ids: string[] }>();
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.ids.length > 100) return error('Max 100 files per zip', 400);

  // Collect file metadata
  const fileMetas: FileMeta[] = [];
  for (const id of body.ids) {
    const meta = await getFile(env, id);
    if (meta) fileMetas.push(meta);
  }

  if (fileMetas.length === 0) return error('No valid files found', 404);

  // For single file, just redirect to download
  if (fileMetas.length === 1) {
    const meta = fileMetas[0];
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) return error('File not found in storage', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  // Build a simple uncompressed zip using Uint8Arrays
  // We stream a minimal zip format (store method, no compression)
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const meta of fileMetas) {
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) continue;

    const fileData = new Uint8Array(await object.arrayBuffer());
    const fileName = encoder.encode(meta.name);
    const crc = crc32(fileData);

    // Local file header (30 + nameLen bytes)
    const localHeader = new Uint8Array(30 + fileName.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);  // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // compression (store)
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0, true);           // mod date
    lv.setUint32(14, crc, true);         // crc-32
    lv.setUint32(18, fileData.length, true); // compressed size
    lv.setUint32(22, fileData.length, true); // uncompressed size
    lv.setUint16(26, fileName.length, true); // file name length
    lv.setUint16(28, 0, true);           // extra field length
    localHeader.set(fileName, 30);

    // Central directory entry
    const cdEntry = new Uint8Array(46 + fileName.length);
    const cv = new DataView(cdEntry.buffer);
    cv.setUint32(0, 0x02014b50, true);   // signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);            // flags
    cv.setUint16(10, 0, true);           // compression
    cv.setUint16(12, 0, true);           // mod time
    cv.setUint16(14, 0, true);           // mod date
    cv.setUint32(16, crc, true);         // crc-32
    cv.setUint32(20, fileData.length, true); // compressed size
    cv.setUint32(24, fileData.length, true); // uncompressed size
    cv.setUint16(28, fileName.length, true); // file name length
    cv.setUint16(30, 0, true);           // extra length
    cv.setUint16(32, 0, true);           // comment length
    cv.setUint16(34, 0, true);           // disk number start
    cv.setUint16(36, 0, true);           // internal attributes
    cv.setUint32(38, 0, true);           // external attributes
    cv.setUint32(42, offset, true);      // relative offset
    cdEntry.set(fileName, 46);

    parts.push(localHeader);
    parts.push(fileData);
    centralDir.push(cdEntry);
    offset += localHeader.length + fileData.length;
  }

  // End of central directory
  let cdSize = 0;
  for (const cd of centralDir) cdSize += cd.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);     // signature
  ev.setUint16(4, 0, true);              // disk number
  ev.setUint16(6, 0, true);              // disk with cd
  ev.setUint16(8, centralDir.length, true); // entries on disk
  ev.setUint16(10, centralDir.length, true); // total entries
  ev.setUint32(12, cdSize, true);         // cd size
  ev.setUint32(16, offset, true);         // cd offset
  ev.setUint16(20, 0, true);             // comment length

  // Combine all parts
  let totalSize = offset + cdSize + 22;
  const zipBuffer = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of parts) { zipBuffer.set(part, pos); pos += part.length; }
  for (const cd of centralDir) { zipBuffer.set(cd, pos); pos += cd.length; }
  zipBuffer.set(eocd, pos);

  const zipName = 'cloudvault-' + new Date().toISOString().slice(0, 10) + '.zip';
  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + zipName + '"',
      'Content-Length': String(totalSize),
    },
  });
}

// ─── CRC-32 for zip ───────────────────────────────────────────────────
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
