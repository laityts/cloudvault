import { Env, FileMeta, MoveFilesRequest, MoveFilesResponse, MoveFolderRequest, MoveFolderResponse, CleanupIncompleteUploadsResponse } from '../utils/types';
import { json, error, getMimeType } from '../utils/response';
import { getSharedFolders, getExcludedFolders, isFolderShared } from './share';
import { getAllowedUploadExtensionList, getSettings } from './settings';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const MOVE_CONCURRENCY = 4;

type MultipartPart = {
  partNumber: number;
  etag: string;
};

type UploadConflictResult = {
  exists: boolean;
  reason?: string;
  file?: Partial<FileMeta> | null;
};

type UploadExtensionCheck = {
  allowed: boolean;
  allowedExtensions: string[];
};

type ByteRange = {
  start: number;
  end: number;
};

function safeDecodeHeaderValue(value: string | null, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function normalizeFolderPath(folder: string): string | null {
  const raw = (folder || 'root').trim();
  if (!raw || raw === 'root') return 'root';
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\') || raw.includes('//')) return null;
  const parts = raw.split('/').map(part => part.trim());
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function normalizeFileName(fileName: string): string | null {
  const raw = (fileName || '').trim();
  if (!raw || raw === '.' || raw === '..') return null;
  if (raw.includes('/') || raw.includes('\\')) return null;
  return raw;
}

function getFolderBaseName(folder: string): string {
  const idx = folder.lastIndexOf('/');
  return idx >= 0 ? folder.slice(idx + 1) : folder;
}

function buildFileKey(folder: string, fileName: string): string {
  return folder === 'root' ? fileName : folder + '/' + fileName;
}

function remapFolderPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath ? newPath : newPath + path.slice(oldPath.length);
}

type StoredFileRow = {
  id: string;
  key: string;
  name: string;
  folder: string;
  uploadStatus?: string | null;
};

type IncompleteUploadRow = {
  id: string;
  key: string;
  uploadId: string | null;
  uploadStatus: string | null;
};

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

function parseUploadRequestMeta(request: Request): { fileName: string; folder: string; contentType: string; key: string } | null {
  const fileName = normalizeFileName(safeDecodeHeaderValue(request.headers.get('X-File-Name'), 'untitled'));
  const folder = normalizeFolderPath(safeDecodeHeaderValue(request.headers.get('X-Folder'), 'root'));
  if (!fileName || !folder) return null;
  const headerContentType = request.headers.get('Content-Type') || '';
  const contentType = headerContentType && headerContentType !== 'application/octet-stream'
    ? headerContentType
    : getMimeType(fileName);
  const key = folder === 'root' ? fileName : folder + '/' + fileName;
  return { fileName, folder, contentType, key };
}

function getStoredContentType(meta: Pick<FileMeta, 'name' | 'type'>): string {
  const type = typeof meta.type === 'string' ? meta.type : '';
  if (type && type !== 'application/octet-stream') return type;
  return getMimeType(meta.name);
}

function normalizeMultipartParts(parts: unknown): MultipartPart[] {
  if (!Array.isArray(parts)) return [];
  const partMap = new Map<number, string>();

  for (const part of parts) {
    const partNumber = Number((part as { partNumber?: unknown })?.partNumber);
    const etag = typeof (part as { etag?: unknown })?.etag === 'string'
      ? (part as { etag: string }).etag.trim()
      : '';
    if (!Number.isInteger(partNumber) || partNumber <= 0 || !etag) continue;
    partMap.set(partNumber, etag);
  }

  return Array.from(partMap.entries())
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
}

function parseStoredMultipartParts(raw: string | null): MultipartPart[] {
  if (!raw) return [];
  try {
    return normalizeMultipartParts(JSON.parse(raw));
  } catch {
    return [];
  }
}

function extractId(url: URL): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf('files');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
}

function parseByteRange(rangeHeader: string, totalSize: number): ByteRange | 'unsatisfiable' | null {
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  if (!match[1] && !match[2]) return null;

  let start: number;
  let end: number;

  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return 'unsatisfiable';
  }
  if (start >= totalSize) return 'unsatisfiable';
  return { start, end: Math.min(end, totalSize - 1) };
}

// 计算文件哈希
async function computeHashes(body: ReadableStream<Uint8Array> | null): Promise<{ sha1: string; sha256: string } | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const fullBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    fullBuffer.set(chunk, offset);
    offset += chunk.length;
  }
  const sha1Buffer = await crypto.subtle.digest('SHA-1', fullBuffer);
  const sha256Buffer = await crypto.subtle.digest('SHA-256', fullBuffer);
  const sha1 = Array.from(new Uint8Array(sha1Buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const sha256 = Array.from(new Uint8Array(sha256Buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { sha1, sha256 };
}

async function getFileById(env: Env, id: string): Promise<FileMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
            share_token as shareToken, share_password as sharePassword, 
            share_expires_at as shareExpiresAt, downloads,
            upload_id as uploadId, upload_chunks as uploadChunks, 
            upload_status as uploadStatus, upload_created_at as uploadCreatedAt,
            upload_updated_at as uploadUpdatedAt, upload_total_chunks as uploadTotalChunks,
            upload_completed_chunks as uploadCompletedChunks, upload_retry_count as uploadRetryCount,
            upload_error as uploadError,
            sha1, sha256
     FROM files WHERE id = ?`
  ).bind(id).first<{
    id: string; key: string; name: string; size: number; type: string; folder: string;
    uploadedAt: string; shareToken: string | null; sharePassword: string | null;
    shareExpiresAt: string | null; downloads: number;
    uploadId: string | null; uploadChunks: string | null; uploadStatus: string | null;
    uploadCreatedAt: string | null; uploadUpdatedAt: string | null;
    uploadTotalChunks: number | null; uploadCompletedChunks: number | null;
    uploadRetryCount: number | null; uploadError: string | null;
    sha1: string | null; sha256: string | null;
  }>();
  if (!row) return null;
  
  let uploadChunks = null;
  if (row.uploadChunks) {
    try {
      uploadChunks = JSON.parse(row.uploadChunks);
    } catch (e) {}
  }
  
  return {
    ...row,
    uploadedAt: row.uploadedAt,
    shareToken: row.shareToken,
    sharePassword: row.sharePassword,
    shareExpiresAt: row.shareExpiresAt,
    uploadId: row.uploadId,
    uploadChunks,
    uploadStatus: row.uploadStatus,
    uploadCreatedAt: row.uploadCreatedAt,
    uploadUpdatedAt: row.uploadUpdatedAt,
    uploadTotalChunks: row.uploadTotalChunks,
    uploadCompletedChunks: row.uploadCompletedChunks,
    uploadRetryCount: row.uploadRetryCount,
    uploadError: row.uploadError,
    sha1: row.sha1,
    sha256: row.sha256,
  };
}

async function findExistingUploadedFileByKey(env: Env, key: string): Promise<Partial<FileMeta> | null> {
  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt,
            share_token as shareToken, downloads
     FROM files
     WHERE key = ?
       AND (upload_status = 'done' OR upload_status IS NULL)
     ORDER BY uploaded_at DESC
     LIMIT 1`
  ).bind(key).first<{
    id: string;
    key: string;
    name: string;
    size: number;
    type: string;
    folder: string;
    uploadedAt: string;
    shareToken: string | null;
    downloads: number;
  }>();

  if (!row) return null;

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    size: row.size,
    type: row.type,
    folder: row.folder,
    uploadedAt: row.uploadedAt,
    shareToken: row.shareToken,
    downloads: row.downloads,
  };
}

async function checkUploadConflict(
  env: Env,
  uploadMeta: { fileName: string; folder: string; contentType: string; key: string }
): Promise<UploadConflictResult> {
  const existingFile = await findExistingUploadedFileByKey(env, uploadMeta.key);
  if (existingFile) {
    return {
      exists: true,
      reason: '目标目录已存在同名文件，已跳过上传',
      file: existingFile,
    };
  }

  const existingObject = await env.VAULT_BUCKET.head(uploadMeta.key);
  if (existingObject) {
    return {
      exists: true,
      reason: '目标目录已存在同名文件，已跳过上传',
      file: {
        key: uploadMeta.key,
        name: uploadMeta.fileName,
        folder: uploadMeta.folder,
        size: existingObject.size,
        type: existingObject.httpMetadata?.contentType || uploadMeta.contentType,
      },
    };
  }

  return { exists: false };
}

function uploadConflictResponse(conflict: UploadConflictResult): Response {
  return json({
    skipped: true,
    exists: true,
    reason: conflict.reason || '目标目录已存在同名文件，已跳过上传',
    file: conflict.file || null,
  }, 409);
}

async function checkUploadExtension(env: Env, fileName: string): Promise<UploadExtensionCheck> {
  const settings = await getSettings(env);
  const allowedExtensions = getAllowedUploadExtensionList(settings);
  if (allowedExtensions.length === 0) return { allowed: true, allowedExtensions };
  const lowerName = fileName.toLowerCase();
  return {
    allowed: allowedExtensions.some(ext => lowerName.endsWith(ext)),
    allowedExtensions,
  };
}

function uploadExtensionBlockedResponse(allowedExtensions: string[]): Response {
  return json({
    allowed: false,
    reason: '该文件后缀不允许上传',
    allowedExtensions,
  }, 415);
}

async function updateStatsCounters(env: Env, sizeDelta: number, countDelta: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stats (id, total_files, total_size) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET total_files = total_files + ?, total_size = total_size + ?`
  ).bind(countDelta, sizeDelta, countDelta, sizeDelta).run();
}

export async function upload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'check') {
    return handleUploadCheck(request, env);
  }
  if (action === 'mpu-status') {
    return handleMultipartStatus(env, url);
  }
  if (action === 'mpu-create') {
    return handleMultipartCreate(request, env);
  }
  if (action === 'mpu-upload') {
    return handleMultipartUpload(request, env, url);
  }
  if (action === 'mpu-complete') {
    return handleMultipartComplete(request, env);
  }
  if (action === 'mpu-abort') {
    return handleMultipartAbort(request, env);
  }
  if (action === 'mpu-progress') {
    return handleMultipartProgress(request, env);
  }
  if (action === 'cleanup-incomplete') {
    return handleCleanupIncompleteUploads(env);
  }

  return handleDirectUpload(request, env);
}

async function handleUploadCheck(request: Request, env: Env): Promise<Response> {
  const uploadMeta = parseUploadRequestMeta(request);
  if (!uploadMeta) return error('Invalid upload target', 400);

  const extensionCheck = await checkUploadExtension(env, uploadMeta.fileName);
  if (!extensionCheck.allowed) return uploadExtensionBlockedResponse(extensionCheck.allowedExtensions);

  const conflict = await checkUploadConflict(env, uploadMeta);
  return json({
    allowed: true,
    exists: conflict.exists,
    skipped: conflict.exists,
    reason: conflict.reason || '',
    allowedExtensions: extensionCheck.allowedExtensions,
    file: conflict.file || null,
  });
}

async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const uploadMeta = parseUploadRequestMeta(request);
  if (!uploadMeta) return error('Invalid upload target', 400);
  if (!request.body) return error('Upload body required', 400);

  const { fileName, folder, contentType, key } = uploadMeta;
  const extensionCheck = await checkUploadExtension(env, fileName);
  if (!extensionCheck.allowed) return uploadExtensionBlockedResponse(extensionCheck.allowedExtensions);

  const conflict = await checkUploadConflict(env, uploadMeta);
  if (conflict.exists) return uploadConflictResponse(conflict);

  const id = crypto.randomUUID();

  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: { contentType, contentDisposition: 'attachment; filename="' + fileName + '"' },
    customMetadata: { fileId: id },
  });

  if (!r2Object) return error('Upload failed', 500);

  // 计算哈希
  const objectForHash = await env.VAULT_BUCKET.get(key);
  const hashes = objectForHash ? await computeHashes(objectForHash.body) : null;

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
    uploadId: null,
    uploadChunks: null,
    uploadStatus: 'done',
    uploadCreatedAt: null,
    uploadUpdatedAt: null,
    uploadTotalChunks: null,
    uploadCompletedChunks: null,
    uploadRetryCount: null,
    uploadError: null,
    sha1: hashes?.sha1 || null,
    sha256: hashes?.sha256 || null,
  };

  await env.DB.prepare(
    `INSERT INTO files (
      id, key, name, size, type, folder, uploaded_at, 
      share_token, share_password, share_expires_at, downloads,
      upload_id, upload_chunks, upload_status, upload_created_at, upload_updated_at,
      upload_total_chunks, upload_completed_chunks, upload_retry_count, upload_error,
      sha1, sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    meta.id, meta.key, meta.name, meta.size, meta.type, meta.folder, meta.uploadedAt,
    meta.shareToken, meta.sharePassword, meta.shareExpiresAt, meta.downloads,
    meta.uploadId, meta.uploadChunks ? JSON.stringify(meta.uploadChunks) : null, 
    meta.uploadStatus, meta.uploadCreatedAt, meta.uploadUpdatedAt,
    meta.uploadTotalChunks, meta.uploadCompletedChunks, meta.uploadRetryCount, meta.uploadError,
    meta.sha1, meta.sha256
  ).run();

  await updateStatsCounters(env, meta.size, 1);
  return json(meta, 201);
}

async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const uploadMeta = parseUploadRequestMeta(request);
  if (!uploadMeta) return error('Invalid upload target', 400);

  const { fileName, folder, contentType, key } = uploadMeta;
  const fileSize = parseInt(request.headers.get('X-File-Size') || '0', 10);
  if (!Number.isFinite(fileSize) || fileSize < 0) return error('Invalid file size', 400);

  const extensionCheck = await checkUploadExtension(env, fileName);
  if (!extensionCheck.allowed) return uploadExtensionBlockedResponse(extensionCheck.allowedExtensions);

  const conflict = await checkUploadConflict(env, uploadMeta);
  if (conflict.exists) return uploadConflictResponse(conflict);

  const multipart = await env.VAULT_BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType, contentDisposition: 'attachment; filename="' + fileName + '"' },
  });

  const id = crypto.randomUUID();
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const now = new Date().toISOString();
  
  await env.DB.prepare(
    `INSERT INTO files (
      id, key, name, size, type, folder, uploaded_at, 
      share_token, share_password, share_expires_at, downloads,
      upload_id, upload_chunks, upload_status, upload_created_at, upload_updated_at,
      upload_total_chunks, upload_completed_chunks, upload_retry_count, upload_error,
      sha1, sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, key, fileName, fileSize, contentType, folder, now,
    null, null, null, 0,
    multipart.uploadId, null, 'uploading', now, now,
    totalChunks, 0, 0, null,
    null, null
  ).run();

  return json({ uploadId: multipart.uploadId, key, fileId: id });
}

async function handleMultipartStatus(env: Env, url: URL): Promise<Response> {
  const fileId = url.searchParams.get('fileId');
  const uploadId = url.searchParams.get('uploadId');
  if (!fileId) return error('Missing fileId', 400);

  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder,
            upload_id as uploadId, upload_chunks as uploadChunks,
            upload_status as uploadStatus, upload_total_chunks as uploadTotalChunks,
            upload_completed_chunks as uploadCompletedChunks, upload_updated_at as uploadUpdatedAt
     FROM files
     WHERE id = ?`
  ).bind(fileId).first<{
    id: string;
    key: string;
    name: string;
    size: number;
    type: string;
    folder: string;
    uploadId: string | null;
    uploadChunks: string | null;
    uploadStatus: string | null;
    uploadTotalChunks: number | null;
    uploadCompletedChunks: number | null;
    uploadUpdatedAt: string | null;
  }>();

  if (!row) return error('Upload session not found', 404);
  if (uploadId && row.uploadId && row.uploadId !== uploadId && row.uploadStatus !== 'done') {
    return error('Upload session mismatch', 409);
  }

  const chunks = parseStoredMultipartParts(row.uploadChunks);
  const completedChunks = Number.isFinite(Number(row.uploadCompletedChunks))
    ? Math.max(Number(row.uploadCompletedChunks), chunks.length)
    : chunks.length;

  return json({
    fileId: row.id,
    uploadId: row.uploadId,
    key: row.key,
    name: row.name,
    size: Number(row.size) || 0,
    type: row.type,
    folder: row.folder,
    status: row.uploadStatus || 'done',
    totalChunks: Number.isFinite(Number(row.uploadTotalChunks)) ? Number(row.uploadTotalChunks) : chunks.length,
    completedChunks,
    chunks,
    updatedAt: row.uploadUpdatedAt,
    completed: !row.uploadId || row.uploadStatus === 'done',
  });
}

async function handleMultipartUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = parseInt(url.searchParams.get('partNumber') || '0', 10);
  const key = url.searchParams.get('key');
  if (!uploadId || !partNumber || !key) return error('Missing uploadId, partNumber, or key', 400);
  if (!request.body) return error('Missing upload chunk body', 400);
  if (key.includes('\\') || key.includes('..')) return error('Invalid file path', 400);

  const row = await env.DB.prepare(
    `SELECT upload_total_chunks as uploadTotalChunks, upload_status as uploadStatus
     FROM files
     WHERE key = ? AND upload_id = ?`
  ).bind(key, uploadId).first<{ uploadTotalChunks: number | null; uploadStatus: string | null }>();
  if (!row || row.uploadStatus === 'done') return error('Upload session not found', 404);
  if (Number.isFinite(Number(row.uploadTotalChunks)) && partNumber > Number(row.uploadTotalChunks)) {
    return error('Invalid part number', 400);
  }

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await multipart.uploadPart(partNumber, request.body as ReadableStream);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function handleMultipartComplete(request: Request, env: Env): Promise<Response> {
  let body: {
    uploadId?: string;
    key?: string;
    parts?: { partNumber: number; etag: string }[];
    fileId?: string;
  };
  try {
    body = await request.json<{
      uploadId?: string;
      key?: string;
      parts?: { partNumber: number; etag: string }[];
      fileId?: string;
    }>();
  } catch {
    return error('Invalid multipart completion payload', 400);
  }
  if (!body?.uploadId || !body?.key || !body?.fileId) return error('Missing multipart completion data', 400);

  const normalizedParts = normalizeMultipartParts(body.parts);
  if (normalizedParts.length === 0) return error('No uploaded parts provided', 400);

  const row = await env.DB.prepare(
    `SELECT id, key, upload_id as uploadId, upload_status as uploadStatus, upload_total_chunks as uploadTotalChunks
     FROM files
     WHERE id = ?`
  ).bind(body.fileId).first<{
    id: string;
    key: string;
    uploadId: string | null;
    uploadStatus: string | null;
    uploadTotalChunks: number | null;
  }>();
  if (!row) return error('File not found', 404);
  if (row.uploadStatus === 'done') {
    const meta = await getFileById(env, body.fileId);
    if (!meta) return error('File not found', 404);
    return json(meta, 200);
  }
  if (row.key !== body.key || row.uploadId !== body.uploadId) return error('Upload session mismatch', 409);
  if (Number.isFinite(Number(row.uploadTotalChunks)) && normalizedParts.length !== Number(row.uploadTotalChunks)) {
    return error('Multipart upload is incomplete', 400);
  }

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
  const r2Object = await multipart.complete(normalizedParts);

  const now = new Date().toISOString();

  // 计算哈希
  const objectForHash = await env.VAULT_BUCKET.get(body.key);
  const hashes = objectForHash ? await computeHashes(objectForHash.body) : null;

  await env.DB.prepare(
    `UPDATE files SET 
      size = ?, uploaded_at = ?, upload_id = NULL, upload_chunks = NULL,
      upload_status = 'done', upload_updated_at = ?, upload_completed_chunks = upload_total_chunks,
      upload_retry_count = 0, upload_error = NULL, sha1 = ?, sha256 = ?
     WHERE id = ?`
  ).bind(r2Object.size, now, now, hashes?.sha1, hashes?.sha256, body.fileId).run();

  const meta = await getFileById(env, body.fileId);
  if (!meta) return error('File not found', 404);

  await updateStatsCounters(env, meta.size, 1);
  return json(meta, 201);
}

async function handleMultipartAbort(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');
  const key = url.searchParams.get('key');
  const fileId = url.searchParams.get('fileId');
  if (!uploadId || !key) return error('Missing uploadId or key', 400);
  if (key.includes('\\') || key.includes('..')) return error('Invalid file path', 400);
  try {
    const multipart = env.VAULT_BUCKET.resumeMultipartUpload(key, uploadId);
    await multipart.abort();
  } catch {}
  if (fileId) {
    await env.DB.prepare(
      `DELETE FROM files WHERE id = ? AND upload_id = ? AND upload_status != 'done'`
    ).bind(fileId, uploadId).run();
  } else {
    await env.DB.prepare(
      `DELETE FROM files WHERE key = ? AND upload_id = ? AND upload_status != 'done'`
    ).bind(key, uploadId).run();
  }
  return json({ message: 'Upload aborted' });
}

async function handleMultipartProgress(request: Request, env: Env): Promise<Response> {
  let body: {
    fileId?: string;
    uploadId?: string;
    completedChunks?: number;
    chunks?: { partNumber: number; etag: string }[];
  };
  try {
    body = await request.json<{
      fileId?: string;
      uploadId?: string;
      completedChunks?: number;
      chunks?: { partNumber: number; etag: string }[];
    }>();
  } catch {
    return error('Invalid upload progress payload', 400);
  }
  if (!body?.fileId || !body?.uploadId) return error('Missing upload progress data', 400);

  const chunks = normalizeMultipartParts(body.chunks);
  const row = await env.DB.prepare(
    `SELECT upload_total_chunks as uploadTotalChunks FROM files WHERE id = ? AND upload_id = ?`
  ).bind(body.fileId, body.uploadId).first<{ uploadTotalChunks: number | null }>();
  if (!row) return error('Upload session not found', 404);

  const totalChunks = Number.isFinite(Number(row.uploadTotalChunks)) ? Number(row.uploadTotalChunks) : null;
  if (totalChunks !== null && chunks.length > totalChunks) return error('Upload progress is out of range', 400);

  const completedChunks = Number.isFinite(Number(body.completedChunks))
    ? Math.max(Math.min(Number(body.completedChunks), totalChunks ?? Number(body.completedChunks)), chunks.length)
    : chunks.length;

  await env.DB.prepare(
    `UPDATE files SET upload_completed_chunks = ?, upload_chunks = ?, upload_updated_at = ?, upload_error = NULL
     WHERE id = ? AND upload_id = ?`
  ).bind(completedChunks, JSON.stringify(chunks), new Date().toISOString(), body.fileId, body.uploadId).run();
  return json({ success: true, completedChunks });
}

async function listIncompleteUploadRows(env: Env): Promise<IncompleteUploadRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, key, upload_id as uploadId, upload_status as uploadStatus
     FROM files
     WHERE upload_status IS NOT NULL
       AND upload_status != 'done'`
  ).all<IncompleteUploadRow>();

  return Array.isArray(rows.results)
    ? rows.results.map(row => ({
        id: row.id as string,
        key: row.key as string,
        uploadId: typeof row.uploadId === 'string' && row.uploadId ? row.uploadId : null,
        uploadStatus: typeof row.uploadStatus === 'string' ? row.uploadStatus : null,
      }))
    : [];
}

async function handleCleanupIncompleteUploads(env: Env): Promise<Response> {
  const rows = await listIncompleteUploadRows(env);
  let abortedMultipartUploads = 0;

  // 先尝试中止远端 multipart，会比单删数据库记录更干净，避免残留未提交分片。
  await runWithConcurrency(rows, MOVE_CONCURRENCY, async row => {
    if (!row.uploadId || !row.key || row.key.includes('\\') || row.key.includes('..')) return;
    try {
      const multipart = env.VAULT_BUCKET.resumeMultipartUpload(row.key, row.uploadId);
      await multipart.abort();
      abortedMultipartUploads += 1;
    } catch {
      // 这里允许继续删库，避免异常 multipart 状态把清理入口卡死。
    }
  });

  await env.DB.prepare(
    `DELETE FROM files
     WHERE upload_status IS NOT NULL
       AND upload_status != 'done'`
  ).run();

  return json<CleanupIncompleteUploadsResponse>({
    deletedTasks: rows.length,
    abortedMultipartUploads,
  });
}

export async function list(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawFolderFilter = url.searchParams.get('folder');
  const folderFilter = typeof rawFolderFilter === 'string' && rawFolderFilter.trim()
    ? normalizeFolderPath(rawFolderFilter)
    : null;
  const rawSearchFilter = url.searchParams.get('search');
  const searchFilter = typeof rawSearchFilter === 'string' ? rawSearchFilter.trim().toLowerCase() : '';
  const parsedLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  const parsedOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
  const offset = Number.isInteger(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

  if (typeof rawFolderFilter === 'string' && rawFolderFilter.trim() && !folderFilter) {
    return error('Invalid folder path', 400);
  }

  let query = `
    SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
           share_token as shareToken, downloads
    FROM files 
    WHERE (upload_status = 'done' OR upload_status IS NULL)
  `;
  const params: any[] = [];

  if (folderFilter && folderFilter !== 'root') {
    query += ` AND folder = ?`;
    params.push(folderFilter);
  } else if (!searchFilter) {
    query += ` AND folder = 'root'`;
  }
  if (searchFilter) {
    query += ` AND LOWER(name) LIKE ?`;
    params.push(`%${searchFilter}%`);
  }
  query += ` ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`;
  params.push(limit + 1, offset);

  const rows = await env.DB.prepare(query).bind(...params).all();
  const normalizedRows = Array.isArray(rows.results) ? rows.results : [];
  const hasMore = normalizedRows.length > limit;
  const visibleRows = hasMore ? normalizedRows.slice(0, limit) : normalizedRows;
  const files = visibleRows.map(r => ({
    id: r.id, key: r.key, name: r.name, size: r.size, type: r.type, folder: r.folder,
    uploadedAt: r.uploadedAt, shareToken: r.shareToken, downloads: r.downloads,
  }));

  return json({
    files,
    hasMore,
    total: hasMore ? null : offset + files.length,
  });
}

export async function get(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);
  const meta = await getFileById(env, id);
  if (!meta) return error('File not found', 404);
  return json(meta);
}

export async function info(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);
  const meta = await getFileById(env, id);
  if (!meta) return error('File not found', 404);
  return json({
    id: meta.id,
    name: meta.name,
    size: meta.size,
    type: meta.type,
    folder: meta.folder,
    uploadedAt: meta.uploadedAt,
    downloads: meta.downloads,
    shareToken: meta.shareToken,
    sharePassword: !!meta.sharePassword,
    shareExpiresAt: meta.shareExpiresAt,
    sha1: meta.sha1,
    sha256: meta.sha256,
  });
}

export async function download(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);
  const meta = await getFileById(env, id);
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
  let totalSizeRemoved = 0;
  for (const id of ids) {
    const meta = await getFileById(env, id);
    if (!meta) continue;
    await env.VAULT_BUCKET.delete(meta.key);
    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(id).run();
    totalSizeRemoved += meta.size;
  }
  await updateStatsCounters(env, -totalSizeRemoved, -ids.length);
  return json({ deleted: ids.length });
}

export async function rename(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);
  const meta = await getFileById(env, id);
  if (!meta) return error('File not found', 404);
  const body = await request.json<{ name: string }>();
  if (!body.name?.trim()) return error('Name required', 400);
  const newName = body.name.trim();
  await env.DB.prepare(`UPDATE files SET name = ? WHERE id = ?`).bind(newName, id).run();
  meta.name = newName;
  return json(meta);
}

async function folderTreeExists(env: Env, folder: string): Promise<boolean> {
  if (folder === 'root') return true;
  const likePattern = folder + '/%';
  const folderRow = await env.DB.prepare(
    `SELECT path FROM folders WHERE path = ? OR path LIKE ? LIMIT 1`
  ).bind(folder, likePattern).first<{ path: string }>();
  if (folderRow) return true;

  const fileRow = await env.DB.prepare(
    `SELECT id FROM files WHERE folder = ? OR folder LIKE ? LIMIT 1`
  ).bind(folder, likePattern).first<{ id: string }>();
  return !!fileRow;
}

async function hasIncompleteUploadsInFolderTree(env: Env, folder: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id
     FROM files
     WHERE (folder = ? OR folder LIKE ?)
       AND upload_status IS NOT NULL
       AND upload_status != 'done'
     LIMIT 1`
  ).bind(folder, folder + '/%').first<{ id: string }>();
  return !!row;
}

async function listStoredFilesByIds(env: Env, ids: string[]): Promise<StoredFileRow[]> {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .filter((id): id is string => typeof id === 'string')
      .map(id => id.trim())
      .filter(Boolean)
  ));
  if (uniqueIds.length === 0) return [];

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT id, key, name, folder, upload_status as uploadStatus
     FROM files
     WHERE id IN (${placeholders})`
  ).bind(...uniqueIds).all<StoredFileRow>();

  return Array.isArray(rows.results)
    ? rows.results.map(row => ({
        id: row.id as string,
        key: row.key as string,
        name: row.name as string,
        folder: row.folder as string,
        uploadStatus: (row as { uploadStatus?: string | null }).uploadStatus ?? null,
      }))
    : [];
}

async function relocateStoredFile(
  env: Env,
  file: StoredFileRow,
  nextFolder: string
): Promise<boolean> {
  const nextKey = buildFileKey(nextFolder, file.name);
  if (!file.key || file.key === nextKey) {
    await env.DB.prepare(`UPDATE files SET folder = ?, key = ? WHERE id = ?`).bind(nextFolder, nextKey, file.id).run();
    return true;
  }

  const object = await env.VAULT_BUCKET.get(file.key);
  if (!object) return false;

  await env.VAULT_BUCKET.put(nextKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
  await env.VAULT_BUCKET.delete(file.key);
  await env.DB.prepare(`UPDATE files SET folder = ?, key = ? WHERE id = ?`).bind(nextFolder, nextKey, file.id).run();
  return true;
}

async function rewriteFolderMetadata(env: Env, oldPath: string, newPath: string): Promise<void> {
  const prefixPattern = oldPath + '/%';
  const suffixStart = oldPath.length + 1;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE folders
       SET path = CASE
         WHEN path = ? THEN ?
         ELSE ? || substr(path, ?)
       END
       WHERE path = ? OR path LIKE ?`
    ).bind(oldPath, newPath, newPath, suffixStart, oldPath, prefixPattern),
    env.DB.prepare(
      `UPDATE folder_shares
       SET folder = CASE
         WHEN folder = ? THEN ?
         ELSE ? || substr(folder, ?)
       END
       WHERE folder = ? OR folder LIKE ?`
    ).bind(oldPath, newPath, newPath, suffixStart, oldPath, prefixPattern),
    env.DB.prepare(
      `UPDATE folder_excludes
       SET folder = CASE
         WHEN folder = ? THEN ?
         ELSE ? || substr(folder, ?)
       END
       WHERE folder = ? OR folder LIKE ?`
    ).bind(oldPath, newPath, newPath, suffixStart, oldPath, prefixPattern),
    env.DB.prepare(
      `UPDATE folder_share_meta
       SET folder = CASE
         WHEN folder = ? THEN ?
         ELSE ? || substr(folder, ?)
       END
       WHERE folder = ? OR folder LIKE ?`
    ).bind(oldPath, newPath, newPath, suffixStart, oldPath, prefixPattern),
    env.DB.prepare(
      `UPDATE folder_share_links
       SET folder = CASE
         WHEN folder = ? THEN ?
         ELSE ? || substr(folder, ?)
       END
       WHERE folder = ? OR folder LIKE ?`
    ).bind(oldPath, newPath, newPath, suffixStart, oldPath, prefixPattern),
  ]);
}

async function rewriteFolderTree(env: Env, oldPath: string, newPath: string): Promise<void> {
  const files = await env.DB.prepare(
    `SELECT id, key, folder, name
     FROM files
     WHERE (folder = ? OR folder LIKE ?)
       AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(oldPath, oldPath + '/%').all<StoredFileRow>();

  const fileRows = Array.isArray(files.results)
    ? files.results.map(row => ({
        id: row.id as string,
        key: row.key as string,
        name: row.name as string,
        folder: row.folder as string,
        uploadStatus: (row as { uploadStatus?: string | null }).uploadStatus ?? null,
      }))
    : [];

  // R2 没有原子重命名，这里用受控并发减少大目录移动时的串行等待。
  await runWithConcurrency(fileRows, MOVE_CONCURRENCY, async row => {
    const nextFolder = remapFolderPath(row.folder, oldPath, newPath);
    await relocateStoredFile(env, row, nextFolder);
  });

  // 目录与分享元数据不依赖逐条搬运结果，合并成批量更新减少 D1 往返。
  await rewriteFolderMetadata(env, oldPath, newPath);
}

export async function createFolder(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ name?: string; parent?: string }>(request);
  const folderNamePart = normalizeFileName(typeof body?.name === 'string' ? body.name : '');
  const parentFolder = normalizeFolderPath(typeof body?.parent === 'string' ? body.parent : 'root');
  if (!folderNamePart) return error('Folder name required', 400);
  if (!parentFolder) return error('Invalid parent folder', 400);
  const folderName = parentFolder === 'root' ? folderNamePart : parentFolder + '/' + folderNamePart;
  await env.DB.prepare(`INSERT INTO folders (path, created_at) VALUES (?, ?)`).bind(folderName, new Date().toISOString()).run();
  return json({ folder: folderName }, 201);
}

export async function deleteFolder(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ folder?: string }>(request);
  const folder = normalizeFolderPath(typeof body?.folder === 'string' ? body.folder : '');
  if (!folder || folder === 'root') return error('Folder name required', 400);
  await env.DB.prepare(`DELETE FROM folders WHERE path = ?`).bind(folder).run();
  await env.DB.prepare(`DELETE FROM folder_shares WHERE folder = ?`).bind(folder).run();
  await env.DB.prepare(`DELETE FROM folder_excludes WHERE folder = ?`).bind(folder).run();
  const linkMeta = await env.DB.prepare(`SELECT token FROM folder_share_meta WHERE folder = ?`).bind(folder).first<{ token: string }>();
  if (linkMeta) {
    await env.DB.prepare(`DELETE FROM folder_share_links WHERE token = ?`).bind(linkMeta.token).run();
    await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(folder).run();
  }
  const subFolders = await env.DB.prepare(`SELECT path FROM folders WHERE path LIKE ?`).bind(folder + '/%').all();
  for (const row of subFolders.results) {
    const sub = row.path as string;
    await env.DB.prepare(`DELETE FROM folders WHERE path = ?`).bind(sub).run();
    await env.DB.prepare(`DELETE FROM folder_shares WHERE folder = ?`).bind(sub).run();
    await env.DB.prepare(`DELETE FROM folder_excludes WHERE folder = ?`).bind(sub).run();
    const subLink = await env.DB.prepare(`SELECT token FROM folder_share_meta WHERE folder = ?`).bind(sub).first<{ token: string }>();
    if (subLink) {
      await env.DB.prepare(`DELETE FROM folder_share_links WHERE token = ?`).bind(subLink.token).run();
      await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(sub).run();
    }
  }
  const filesToDelete = await env.DB.prepare(
    `SELECT id, key, size
     FROM files
     WHERE (folder = ? OR folder LIKE ?)
       AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(folder, folder + '/%').all();
  let totalSizeRemoved = 0, deletedCount = 0;
  for (const row of filesToDelete.results) {
    await env.VAULT_BUCKET.delete(row.key as string);
    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(row.id).run();
    totalSizeRemoved += row.size as number;
    deletedCount++;
  }
  await env.DB.prepare(
    `DELETE FROM files
     WHERE (folder = ? OR folder LIKE ?)
       AND upload_status != 'done'`
  ).bind(folder, folder + '/%').run();
  if (deletedCount > 0) await updateStatsCounters(env, -totalSizeRemoved, -deletedCount);
  return json({ deleted: folder, deletedFiles: deletedCount, deletedSubfolders: subFolders.results.length });
}

export async function renameFolder(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ oldName?: string; newName?: string }>(request);
  const oldName = normalizeFolderPath(typeof body?.oldName === 'string' ? body.oldName : '');
  const newName = normalizeFolderPath(typeof body?.newName === 'string' ? body.newName : '');
  if (!oldName || oldName === 'root' || !newName || newName === 'root') {
    return error('Both old and new names required', 400);
  }
  if (oldName === newName) return json({ folder: newName });
  if (newName.startsWith(oldName + '/')) return error('Cannot move folder into its child folder', 400);
  if (await hasIncompleteUploadsInFolderTree(env, oldName)) {
    return error('Folder contains unfinished uploads and cannot be renamed', 409);
  }
  if (!(await folderTreeExists(env, oldName))) return error('Folder not found', 404);
  if (await folderTreeExists(env, newName)) return error('Target folder already exists', 409);
  await rewriteFolderTree(env, oldName, newName);
  return json({ folder: newName });
}

// MODIFIED: 增加了文件夹统计信息
export async function listFolders(_request: Request, env: Env): Promise<Response> {
  const folderRows = await env.DB.prepare(`SELECT path FROM folders`).all();
  const folderSet = new Set<string>();
  for (const row of folderRows.results) {
    const folder = row.path as string;
    if (!folder) continue;
    folderSet.add(folder);
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      folderSet.add(path);
    }
  }
  const fileFolders = await env.DB.prepare(
    `SELECT DISTINCT folder
     FROM files
     WHERE folder != 'root'
       AND (upload_status = 'done' OR upload_status IS NULL)`
  ).all();
  for (const row of fileFolders.results) {
    const folder = row.folder as string;
    folderSet.add(folder);
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      folderSet.add(path);
    }
  }

  // 这里改成递归统计，方便前端直接显示“子文件夹数 / 子文件数”。
  const fileStats = await env.DB.prepare(`
    SELECT folder, COUNT(*) as fileCount
    FROM files
    WHERE (upload_status = 'done' OR upload_status IS NULL)
    GROUP BY folder
  `).all();

  const statsMap = new Map<string, { fileCount: number; folderCount: number }>();
  for (const name of folderSet) {
    statsMap.set(name, { fileCount: 0, folderCount: 0 });
  }

  for (const row of fileStats.results) {
    const folder = row.folder as string;
    const fileCount = Number(row.fileCount) || 0;
    if (!folder || folder === 'root' || fileCount <= 0) continue;

    const parts = folder.split('/');
    let path = '';
    for (const part of parts) {
      path = path ? path + '/' + part : part;
      const current = statsMap.get(path) || { fileCount: 0, folderCount: 0 };
      current.fileCount += fileCount;
      statsMap.set(path, current);
    }
  }

  for (const name of folderSet) {
    const parts = name.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      const current = statsMap.get(path) || { fileCount: 0, folderCount: 0 };
      current.folderCount += 1;
      statsMap.set(path, current);
    }
  }

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const folderList = Array.from(folderSet).sort().map(name => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
    fileCount: statsMap.get(name)?.fileCount || 0,
    folderCount: statsMap.get(name)?.folderCount || 0,
  }));
  return json({ folders: folderList });
}

export async function moveFiles(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<MoveFilesRequest>(request);
  if (!body?.ids?.length) return error('No file IDs provided', 400);
  const targetFolder = normalizeFolderPath(typeof body.targetFolder === 'string' ? body.targetFolder : '');
  if (!targetFolder) return error('Target folder required', 400);
  if (targetFolder !== 'root' && !(await folderTreeExists(env, targetFolder))) {
    return error('Target folder not found', 404);
  }

  const files = await listStoredFilesByIds(env, body.ids);
  const movableFiles = files.filter(file =>
    file.folder !== targetFolder &&
    (!file.uploadStatus || file.uploadStatus === 'done')
  );

  let moved = 0;
  await runWithConcurrency(movableFiles, MOVE_CONCURRENCY, async file => {
    const success = await relocateStoredFile(env, file, targetFolder);
    if (success) moved += 1;
  });

  return json<MoveFilesResponse>({ moved });
}

export async function moveFolder(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<MoveFolderRequest>(request);
  const sourceFolder = normalizeFolderPath(typeof body?.sourceFolder === 'string' ? body.sourceFolder : '');
  const targetFolder = normalizeFolderPath(typeof body?.targetFolder === 'string' ? body.targetFolder : '');

  if (!sourceFolder || sourceFolder === 'root') return error('Source folder required', 400);
  if (!targetFolder) return error('Target folder required', 400);
  if (!(await folderTreeExists(env, sourceFolder))) return error('Source folder not found', 404);
  if (targetFolder !== 'root' && !(await folderTreeExists(env, targetFolder))) {
    return error('Target folder not found', 404);
  }
  if (targetFolder === sourceFolder || targetFolder.startsWith(sourceFolder + '/')) {
    return error('Cannot move folder into itself or its child folder', 400);
  }
  if (await hasIncompleteUploadsInFolderTree(env, sourceFolder)) {
    return error('Folder contains unfinished uploads and cannot be moved', 409);
  }

  const nextFolder = targetFolder === 'root'
    ? getFolderBaseName(sourceFolder)
    : targetFolder + '/' + getFolderBaseName(sourceFolder);

  if (nextFolder === sourceFolder) return error('Source and target folder are the same', 400);
  if (await folderTreeExists(env, nextFolder)) return error('Target folder already exists', 409);

  await rewriteFolderTree(env, sourceFolder, nextFolder);
  return json<MoveFolderResponse>({ folder: nextFolder, previousFolder: sourceFolder });
}

export async function thumbnail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);
  const meta = await getFileById(env, id);
  if (!meta) return error('File not found', 404);
  const contentType = getStoredContentType(meta);
  if (!contentType.startsWith('image/')) return error('Not an image', 400);
  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
  return new Response(object.body, { headers });
}

export async function preview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);
  const meta = await getFileById(env, id);
  if (!meta) return error('File not found', 404);
  const contentType = getStoredContentType(meta);
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const head = await env.VAULT_BUCKET.head(meta.key);
    if (!head) return error('File not found in storage', 404);

    const parsedRange = parseByteRange(rangeHeader, head.size);
    if (parsedRange === 'unsatisfiable') {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': 'bytes */' + head.size },
      });
    }

    if (parsedRange) {
      const length = parsedRange.end - parsedRange.start + 1;
      const object = await env.VAULT_BUCKET.get(meta.key, {
        range: { offset: parsedRange.start, length },
      });
      if (!object) return error('File not found in storage', 404);

      const headers = new Headers();
      head.writeHttpMetadata(headers);
      headers.set('etag', head.httpEtag);
      headers.set('Content-Type', contentType);
      headers.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
      headers.set('Cache-Control', 'private, max-age=14400, stale-while-revalidate=86400');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', 'bytes ' + parsedRange.start + '-' + parsedRange.end + '/' + head.size);
      headers.set('Content-Length', String(length));
      return new Response(object.body, { status: 206, headers });
    }
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(meta.name) + '"');
  headers.set('Cache-Control', 'private, max-age=14400, stale-while-revalidate=86400');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

export async function zipDownload(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ ids: string[] }>();
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.ids.length > 100) return error('Max 100 files per zip', 400);
  const fileMetas: FileMeta[] = [];
  for (const id of body.ids) {
    const meta = await getFileById(env, id);
    if (meta && (!meta.uploadStatus || meta.uploadStatus === 'done')) fileMetas.push(meta);
  }
  if (fileMetas.length === 0) return error('No valid files found', 404);
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
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;
  function crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  for (const meta of fileMetas) {
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) continue;
    const fileData = new Uint8Array(await object.arrayBuffer());
    const fileName = encoder.encode(meta.name);
    const crc = crc32(fileData);
    const localHeader = new Uint8Array(30 + fileName.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, fileData.length, true);
    lv.setUint32(22, fileData.length, true);
    lv.setUint16(26, fileName.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(fileName, 30);
    const cdEntry = new Uint8Array(46 + fileName.length);
    const cv = new DataView(cdEntry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, fileData.length, true);
    cv.setUint32(24, fileData.length, true);
    cv.setUint16(28, fileName.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdEntry.set(fileName, 46);
    parts.push(localHeader);
    parts.push(fileData);
    centralDir.push(cdEntry);
    offset += localHeader.length + fileData.length;
  }
  let cdSize = 0;
  for (const cd of centralDir) cdSize += cd.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centralDir.length, true);
  ev.setUint16(10, centralDir.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
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
