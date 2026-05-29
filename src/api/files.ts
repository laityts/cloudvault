import type { Env } from '../utils/types';
import { json, error, getMimeType } from '../utils/response';
import { parseJson } from '../utils/validate';
import { buildR2Key, extractPathParam, isUnsafeKey } from '../utils/keys';
import { createFileMeta } from '../utils/file-meta';
import { streamR2Object } from '../utils/r2';
import { computeHashes } from '../utils/hash';
import {
  getFile,
  putFile,
  deleteFile,
  listFilesInFolder,
  searchFiles,
  updateFileHashes,
} from '../db/files';

export async function upload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'mpu-create') return handleMultipartCreate(request, env);
  if (action === 'mpu-upload') return handleMultipartUpload(request, env, url);
  if (action === 'mpu-complete') return handleMultipartComplete(request, env);
  if (action === 'mpu-abort') return handleMultipartAbort(request, env);

  return handleDirectUpload(request, env);
}

async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);

  const key = buildR2Key(folder, fileName);
  if (isUnsafeKey(key)) return error('Invalid file path', 400);

  const id = crypto.randomUUID();
  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
    customMetadata: { fileId: id },
  });
  if (!r2Object) return error('Upload failed', 500);

  const meta = createFileMeta({
    id,
    key,
    name: fileName,
    size: r2Object.size,
    type: contentType,
    folder,
  });
  await putFile(env, meta);

  return json(meta, 201);
}

async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const key = buildR2Key(folder, fileName);

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
  const body = await parseJson<{
    uploadId: string;
    key: string;
    parts: { partNumber: number; etag: string }[];
  }>(request);

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
  const r2Object = await multipart.complete(body.parts);

  const fileName = body.key.split('/').pop() || body.key;
  const folder = body.key.includes('/') ? body.key.substring(0, body.key.lastIndexOf('/')) : 'root';

  const meta = createFileMeta({
    key: body.key,
    name: fileName,
    size: r2Object.size,
    type: r2Object.httpMetadata?.contentType || getMimeType(fileName),
    folder,
  });  await putFile(env, meta);

  return json(meta, 201);
}

async function handleMultipartAbort(request: Request, env: Env): Promise<Response> {
  // 支持 sendBeacon (text/plain JSON) 与常规 application/json，方便 pagehide 触发。
  let body: { uploadId: string; key: string };
  try {
    const raw = await request.text();
    body = raw ? JSON.parse(raw) : { uploadId: '', key: '' };
  } catch {
    return error('Invalid JSON', 400);
  }
  if (!body.uploadId || !body.key) return error('uploadId and key required', 400);

  // R2 abort 失败通常意味着上传已被 complete 或不存在，不应回 5xx 影响调用方。
  try {
    const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
    await multipart.abort();
  } catch {
    /* swallow — best effort */
  }
  return json({ aborted: true });
}

export async function list(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folderFilter = url.searchParams.get('folder');
  const searchFilter = url.searchParams.get('search');
  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

  let files;
  if (searchFilter) {
    files = await searchFiles(env, searchFilter, folderFilter, limit);
  } else {
    files = await listFilesInFolder(env, folderFilter ?? 'root', limit);
  }

  return json({ files, cursor: null, totalFiles: files.length });
}

export async function get(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  return json(meta);
}

export async function download(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  return streamR2Object(object, request, {
    cacheControl: 'private, max-age=14400',
    headers: {
      'Content-Disposition': 'attachment; filename="' + meta.name + '"',
    },
  });
}

export async function deleteFiles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let ids: string[];

  if (request.method === 'DELETE') {
    const id = extractPathParam(url, 'files');
    if (!id) return error('File ID required', 400);
    ids = [id];
  } else {
    const body = await parseJson<{ ids: string[] }>(request);
    ids = body.ids;
  }

  if (!ids || ids.length === 0) return error('No file IDs provided', 400);

  await Promise.all(
    ids.map(async (id) => {
      const meta = await getFile(env, id);
      if (!meta) return;
      await Promise.all([
        env.VAULT_BUCKET.delete(meta.key),
        deleteFile(env, id),
      ]);
    }),
  );

  return json({ deleted: ids.length });
}

export async function rename(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const body = await parseJson<{ name: string }>(request);
  if (!body.name?.trim()) return error('Name required', 400);

  meta.name = body.name.trim();
  await putFile(env, meta);

  return json(meta);
}

export async function moveFiles(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ ids: string[]; targetFolder: string }>(request);
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.targetFolder === undefined) return error('Target folder required', 400);

  const targetFolder = body.targetFolder;
  const ids = body.ids;

  const moveOne = async (id: string): Promise<boolean> => {
    const meta = await getFile(env, id);
    if (!meta) return false;
    if (meta.folder === targetFolder) return false;

    const newKey = buildR2Key(targetFolder, meta.name);

    const oldObject = await env.VAULT_BUCKET.get(meta.key);
    if (!oldObject) return false;

    await env.VAULT_BUCKET.put(newKey, oldObject.body, {
      httpMetadata: oldObject.httpMetadata,
      customMetadata: oldObject.customMetadata,
    });
    await env.VAULT_BUCKET.delete(meta.key);

    meta.key = newKey;
    meta.folder = targetFolder;
    await putFile(env, meta);
    return true;
  };

  const CONCURRENCY = 4;
  let cursor = 0;
  let moved = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      const ok = await moveOne(ids[i]!);
      if (ok) moved++;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()),
  );

  return json({ moved });
}

export async function info(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  if (meta.sha1 && meta.sha256) {
    return json(meta);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  try {
    const { sha1, sha256 } = await computeHashes(object.body);
    await updateFileHashes(env, id, sha1, sha256);
    meta.sha1 = sha1;
    meta.sha256 = sha256;
    return json(meta);
  } catch (e) {
    return error(
      e instanceof Error ? e.message : 'Hash computation failed',
      500,
    );
  }
}
