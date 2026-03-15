import { Env, FileMeta } from '../utils/types';
import { json, error, getMimeType } from '../utils/response';
import { getSharedFolders, getExcludedFolders, isFolderShared } from './share';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

function extractId(url: URL): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf('files');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
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
            upload_error as uploadError
     FROM files WHERE id = ?`
  ).bind(id).first<{
    id: string; key: string; name: string; size: number; type: string; folder: string;
    uploadedAt: string; shareToken: string | null; sharePassword: string | null;
    shareExpiresAt: string | null; downloads: number;
    uploadId: string | null; uploadChunks: string | null; uploadStatus: string | null;
    uploadCreatedAt: string | null; uploadUpdatedAt: string | null;
    uploadTotalChunks: number | null; uploadCompletedChunks: number | null;
    uploadRetryCount: number | null; uploadError: string | null;
  }>();
  if (!row) return null;
  
  // 解析 uploadChunks JSON
  let uploadChunks = null;
  if (row.uploadChunks) {
    try {
      uploadChunks = JSON.parse(row.uploadChunks);
    } catch (e) {
      // 忽略解析错误
    }
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
  };
}

async function getFilesByFolder(env: Env, folder: string): Promise<FileMeta[]> {
  const rows = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
            share_token as shareToken, share_password as sharePassword, 
            share_expires_at as shareExpiresAt, downloads,
            upload_id as uploadId, upload_chunks as uploadChunks, 
            upload_status as uploadStatus, upload_created_at as uploadCreatedAt,
            upload_updated_at as uploadUpdatedAt, upload_total_chunks as uploadTotalChunks,
            upload_completed_chunks as uploadCompletedChunks, upload_retry_count as uploadRetryCount,
            upload_error as uploadError
     FROM files WHERE folder = ?`
  ).bind(folder).all();
  
  return rows.results.map(r => {
    let uploadChunks = null;
    if (r.uploadChunks) {
      try {
        uploadChunks = JSON.parse(r.uploadChunks as string);
      } catch (e) {}
    }
    return {
      id: r.id as string, key: r.key as string, name: r.name as string, 
      size: r.size as number, type: r.type as string, folder: r.folder as string,
      uploadedAt: r.uploadedAt as string, shareToken: r.shareToken as string | null,
      sharePassword: r.sharePassword as string | null, shareExpiresAt: r.shareExpiresAt as string | null,
      downloads: r.downloads as number,
      uploadId: r.uploadId as string | null,
      uploadChunks,
      uploadStatus: r.uploadStatus as string | null,
      uploadCreatedAt: r.uploadCreatedAt as string | null,
      uploadUpdatedAt: r.uploadUpdatedAt as string | null,
      uploadTotalChunks: r.uploadTotalChunks as number | null,
      uploadCompletedChunks: r.uploadCompletedChunks as number | null,
      uploadRetryCount: r.uploadRetryCount as number | null,
      uploadError: r.uploadError as string | null,
    };
  });
}

async function getAllFiles(env: Env): Promise<FileMeta[]> {
  const rows = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
            share_token as shareToken, share_password as sharePassword, 
            share_expires_at as shareExpiresAt, downloads,
            upload_id as uploadId, upload_chunks as uploadChunks, 
            upload_status as uploadStatus, upload_created_at as uploadCreatedAt,
            upload_updated_at as uploadUpdatedAt, upload_total_chunks as uploadTotalChunks,
            upload_completed_chunks as uploadCompletedChunks, upload_retry_count as uploadRetryCount,
            upload_error as uploadError
     FROM files`
  ).all();
  
  return rows.results.map(r => {
    let uploadChunks = null;
    if (r.uploadChunks) {
      try {
        uploadChunks = JSON.parse(r.uploadChunks as string);
      } catch (e) {}
    }
    return {
      id: r.id as string, key: r.key as string, name: r.name as string, 
      size: r.size as number, type: r.type as string, folder: r.folder as string,
      uploadedAt: r.uploadedAt as string, shareToken: r.shareToken as string | null,
      sharePassword: r.sharePassword as string | null, shareExpiresAt: r.shareExpiresAt as string | null,
      downloads: r.downloads as number,
      uploadId: r.uploadId as string | null,
      uploadChunks,
      uploadStatus: r.uploadStatus as string | null,
      uploadCreatedAt: r.uploadCreatedAt as string | null,
      uploadUpdatedAt: r.uploadUpdatedAt as string | null,
      uploadTotalChunks: r.uploadTotalChunks as number | null,
      uploadCompletedChunks: r.uploadCompletedChunks as number | null,
      uploadRetryCount: r.uploadRetryCount as number | null,
      uploadError: r.uploadError as string | null,
    };
  });
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

  return handleDirectUpload(request, env);
}

async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const contentLength = request.headers.get('Content-Length');

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
    uploadId: null,
    uploadChunks: null,
    uploadStatus: 'done',
    uploadCreatedAt: null,
    uploadUpdatedAt: null,
    uploadTotalChunks: null,
    uploadCompletedChunks: null,
    uploadRetryCount: null,
    uploadError: null,
  };

  await env.DB.prepare(
    `INSERT INTO files (
      id, key, name, size, type, folder, uploaded_at, 
      share_token, share_password, share_expires_at, downloads,
      upload_id, upload_chunks, upload_status, upload_created_at, upload_updated_at,
      upload_total_chunks, upload_completed_chunks, upload_retry_count, upload_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    meta.id, meta.key, meta.name, meta.size, meta.type, meta.folder, meta.uploadedAt,
    meta.shareToken, meta.sharePassword, meta.shareExpiresAt, meta.downloads,
    meta.uploadId, meta.uploadChunks ? JSON.stringify(meta.uploadChunks) : null, 
    meta.uploadStatus, meta.uploadCreatedAt, meta.uploadUpdatedAt,
    meta.uploadTotalChunks, meta.uploadCompletedChunks, meta.uploadRetryCount, meta.uploadError
  ).run();

  await updateStatsCounters(env, meta.size, 1);

  return json(meta, 201);
}

async function handleMultipartCreate(request: Request, env: Env): Promise<Response> {
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'untitled');
  const folder = decodeURIComponent(request.headers.get('X-Folder') || 'root');
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const fileSize = parseInt(request.headers.get('X-File-Size') || '0', 10);
  const key = folder === 'root' ? fileName : folder + '/' + fileName;

  const multipart = await env.VAULT_BUCKET.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
  });

  // 创建临时记录
  const id = crypto.randomUUID();
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const now = new Date().toISOString();
  
  await env.DB.prepare(
    `INSERT INTO files (
      id, key, name, size, type, folder, uploaded_at, 
      share_token, share_password, share_expires_at, downloads,
      upload_id, upload_chunks, upload_status, upload_created_at, upload_updated_at,
      upload_total_chunks, upload_completed_chunks, upload_retry_count, upload_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, key, fileName, fileSize, contentType, folder, now,
    null, null, null, 0,
    multipart.uploadId, null, 'uploading', now, now,
    totalChunks, 0, 0, null
  ).run();

  return json({ uploadId: multipart.uploadId, key, fileId: id });
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
    fileId: string;
  }>();

  const multipart = env.VAULT_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
  const r2Object = await multipart.complete(body.parts);

  const fileName = body.key.split('/').pop() || body.key;
  const folder = body.key.includes('/') ? body.key.substring(0, body.key.lastIndexOf('/')) : 'root';
  const now = new Date().toISOString();

  // 更新文件记录为完成状态
  await env.DB.prepare(
    `UPDATE files SET 
      size = ?, 
      uploaded_at = ?,
      upload_id = NULL,
      upload_chunks = NULL,
      upload_status = 'done',
      upload_updated_at = ?
     WHERE id = ?`
  ).bind(r2Object.size, now, now, body.fileId).run();

  // 获取完整的文件记录返回
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

  try {
    const multipart = env.VAULT_BUCKET.resumeMultipartUpload(key, uploadId);
    await multipart.abort();
  } catch (e) {
    // 忽略 abort 错误
  }

  // 如果提供了 fileId，删除临时记录
  if (fileId) {
    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(fileId).run();
  }

  return json({ message: 'Upload aborted' });
}

async function handleMultipartProgress(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    fileId: string;
    uploadId: string;
    completedChunks: number;
    chunks: { partNumber: number; etag: string }[];
  }>();

  await env.DB.prepare(
    `UPDATE files SET 
      upload_completed_chunks = ?,
      upload_chunks = ?,
      upload_updated_at = ?
     WHERE id = ? AND upload_id = ?`
  ).bind(
    body.completedChunks,
    JSON.stringify(body.chunks),
    new Date().toISOString(),
    body.fileId,
    body.uploadId
  ).run();

  return json({ success: true });
}

export async function list(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folderFilter = url.searchParams.get('folder');
  const searchFilter = url.searchParams.get('search')?.toLowerCase();

  // 基础查询：只返回已完成的上传（upload_status = 'done' 或 upload_status IS NULL）
  let query = `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
                      share_token as shareToken, share_password as sharePassword, 
                      share_expires_at as shareExpiresAt, downloads
               FROM files 
               WHERE (upload_status = 'done' OR upload_status IS NULL)`;
  const params: any[] = [];

  if (folderFilter) {
    // 如果指定了文件夹，就只查询该文件夹下的文件
    query += ` AND folder = ?`;
    params.push(folderFilter);
  } else if (!searchFilter) {
    // 如果没有指定文件夹且没有搜索关键词，则默认只显示根目录下的文件
    query += ` AND folder = 'root'`;
  }
  // 注意：如果有搜索关键词，我们不限制文件夹，以便在所有文件夹中搜索
  if (searchFilter) {
    query += ` AND LOWER(name) LIKE ?`;
    params.push(`%${searchFilter}%`);
  }
  query += ` ORDER BY uploaded_at DESC`;

  const rows = await env.DB.prepare(query).bind(...params).all();
  const files = rows.results.map(r => ({
    id: r.id, key: r.key, name: r.name, size: r.size, type: r.type, folder: r.folder,
    uploadedAt: r.uploadedAt, shareToken: r.shareToken, sharePassword: r.sharePassword,
    shareExpiresAt: r.shareExpiresAt, downloads: r.downloads,
  }));

  return json({ files, cursor: null, totalFiles: files.length });
}

export async function get(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractId(url);
  if (!id) return error('File ID required', 400);

  const meta = await getFileById(env, id);
  if (!meta) return error('File not found', 404);

  return json(meta);
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
  await env.DB.prepare(
    `UPDATE files SET name = ? WHERE id = ?`
  ).bind(newName, id).run();

  meta.name = newName;
  return json(meta);
}

export async function createFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name: string; parent: string }>();
  if (!body.name?.trim()) return error('Folder name required', 400);

  const folderName = body.parent === 'root' ? body.name.trim() : body.parent + '/' + body.name.trim();
  await env.DB.prepare(
    `INSERT INTO folders (path, created_at) VALUES (?, ?)`
  ).bind(folderName, new Date().toISOString()).run();

  return json({ folder: folderName }, 201);
}

export async function deleteFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  // 删除文件夹条目
  await env.DB.prepare(`DELETE FROM folders WHERE path = ?`).bind(folder).run();

  // 删除相关的分享和排除记录
  await env.DB.prepare(`DELETE FROM folder_shares WHERE folder = ?`).bind(folder).run();
  await env.DB.prepare(`DELETE FROM folder_excludes WHERE folder = ?`).bind(folder).run();

  // 删除文件夹分享链接
  const linkMeta = await env.DB.prepare(`SELECT token FROM folder_share_meta WHERE folder = ?`).bind(folder).first<{ token: string }>();
  if (linkMeta) {
    await env.DB.prepare(`DELETE FROM folder_share_links WHERE token = ?`).bind(linkMeta.token).run();
    await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(folder).run();
  }

  // 删除子文件夹
  const subFolders = await env.DB.prepare(
    `SELECT path FROM folders WHERE path LIKE ?`
  ).bind(folder + '/%').all();
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

  // 删除包含的文件
  const filesToDelete = await env.DB.prepare(
    `SELECT id, key, size FROM files WHERE folder = ? OR folder LIKE ? AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(folder, folder + '/%').all();
  let totalSizeRemoved = 0;
  let deletedCount = 0;
  for (const row of filesToDelete.results) {
    await env.VAULT_BUCKET.delete(row.key as string);
    await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(row.id).run();
    totalSizeRemoved += row.size as number;
    deletedCount++;
  }

  // 删除未完成的临时文件记录
  await env.DB.prepare(
    `DELETE FROM files WHERE folder = ? OR folder LIKE ? AND upload_status != 'done'`
  ).bind(folder, folder + '/%').run();

  if (deletedCount > 0) {
    await updateStatsCounters(env, -totalSizeRemoved, -deletedCount);
  }

  return json({ deleted: folder, deletedFiles: deletedCount, deletedSubfolders: subFolders.results.length });
}

export async function renameFolder(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ oldName: string; newName: string }>();
  if (!body.oldName?.trim() || !body.newName?.trim()) return error('Both old and new names required', 400);
  const oldName = body.oldName.trim();
  const newName = body.newName.trim();
  if (oldName === newName) return json({ folder: newName });

  // 更新文件夹本身
  await env.DB.prepare(
    `UPDATE folders SET path = ? WHERE path = ?`
  ).bind(newName, oldName).run();

  // 更新子文件夹路径
  const subFolders = await env.DB.prepare(
    `SELECT path FROM folders WHERE path LIKE ?`
  ).bind(oldName + '/%').all();
  for (const row of subFolders.results) {
    const oldSub = row.path as string;
    const newSub = newName + oldSub.slice(oldName.length);
    await env.DB.prepare(
      `UPDATE folders SET path = ? WHERE path = ?`
    ).bind(newSub, oldSub).run();
  }

  // 更新folder_shares
  const share = await env.DB.prepare(`SELECT * FROM folder_shares WHERE folder = ?`).bind(oldName).first();
  if (share) {
    await env.DB.prepare(`DELETE FROM folder_shares WHERE folder = ?`).bind(oldName).run();
    await env.DB.prepare(`INSERT INTO folder_shares (folder, shared_at) VALUES (?, ?)`).bind(newName, share.shared_at).run();
  }
  const subShares = await env.DB.prepare(`SELECT folder, shared_at FROM folder_shares WHERE folder LIKE ?`).bind(oldName + '/%').all();
  for (const row of subShares.results) {
    const oldSub = row.folder as string;
    const newSub = newName + oldSub.slice(oldName.length);
    await env.DB.prepare(`DELETE FROM folder_shares WHERE folder = ?`).bind(oldSub).run();
    await env.DB.prepare(`INSERT INTO folder_shares (folder, shared_at) VALUES (?, ?)`).bind(newSub, row.shared_at).run();
  }

  // 更新folder_excludes
  const exclude = await env.DB.prepare(`SELECT * FROM folder_excludes WHERE folder = ?`).bind(oldName).first();
  if (exclude) {
    await env.DB.prepare(`DELETE FROM folder_excludes WHERE folder = ?`).bind(oldName).run();
    await env.DB.prepare(`INSERT INTO folder_excludes (folder, excluded_at) VALUES (?, ?)`).bind(newName, exclude.excluded_at).run();
  }
  const subExcludes = await env.DB.prepare(`SELECT folder, excluded_at FROM folder_excludes WHERE folder LIKE ?`).bind(oldName + '/%').all();
  for (const row of subExcludes.results) {
    const oldSub = row.folder as string;
    const newSub = newName + oldSub.slice(oldName.length);
    await env.DB.prepare(`DELETE FROM folder_excludes WHERE folder = ?`).bind(oldSub).run();
    await env.DB.prepare(`INSERT INTO folder_excludes (folder, excluded_at) VALUES (?, ?)`).bind(newSub, row.excluded_at).run();
  }

  // 更新folder_share_meta
  const linkMeta = await env.DB.prepare(`SELECT * FROM folder_share_meta WHERE folder = ?`).bind(oldName).first();
  if (linkMeta) {
    await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(oldName).run();
    await env.DB.prepare(`INSERT INTO folder_share_meta (folder, token, password_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(newName, linkMeta.token, linkMeta.password_hash, linkMeta.expires_at).run();
  }
  const subLinkMetas = await env.DB.prepare(`SELECT folder, token, password_hash, expires_at FROM folder_share_meta WHERE folder LIKE ?`).bind(oldName + '/%').all();
  for (const row of subLinkMetas.results) {
    const oldSub = row.folder as string;
    const newSub = newName + oldSub.slice(oldName.length);
    await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(oldSub).run();
    await env.DB.prepare(`INSERT INTO folder_share_meta (folder, token, password_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(newSub, row.token, row.password_hash, row.expires_at).run();
  }

  // 更新files表中的folder路径（只更新已完成文件）
  const files = await env.DB.prepare(
    `SELECT id, key, folder FROM files WHERE (folder = ? OR folder LIKE ?) AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(oldName, oldName + '/%').all();
  for (const row of files.results) {
    const oldFolder = row.folder as string;
    const newFolder = newName + oldFolder.slice(oldName.length);
    const oldKey = row.key as string;
    const newKey = newFolder === 'root' ? oldKey.split('/').pop()! : newFolder + '/' + oldKey.split('/').pop()!;
    // 移动R2对象
    const obj = await env.VAULT_BUCKET.get(oldKey);
    if (obj) {
      await env.VAULT_BUCKET.put(newKey, obj.body, {
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
      });
      await env.VAULT_BUCKET.delete(oldKey);
    }
    await env.DB.prepare(
      `UPDATE files SET folder = ?, key = ? WHERE id = ?`
    ).bind(newFolder, newKey, row.id).run();
  }

  // 更新未完成的临时文件记录（只更新文件夹路径，不移动R2对象）
  await env.DB.prepare(
    `UPDATE files SET folder = ? WHERE folder = ? AND upload_status != 'done'`
  ).bind(newName, oldName).run();
  await env.DB.prepare(
    `UPDATE files SET folder = ? || substr(folder, ?) WHERE folder LIKE ? AND upload_status != 'done'`
  ).bind(newName, oldName.length + 1, oldName + '/%').run();

  return json({ folder: newName });
}

export async function listFolders(_request: Request, env: Env): Promise<Response> {
  // 获取所有文件夹路径（从folders表）
  const folderRows = await env.DB.prepare(`SELECT path FROM folders`).all();
  const folderSet = new Set<string>(folderRows.results.map(r => r.path as string));

  // 从files表中获取所有不同的folder（可能有一些文件夹没有在folders表中）
  const fileFolders = await env.DB.prepare(`SELECT DISTINCT folder FROM files WHERE folder != 'root'`).all();
  for (const row of fileFolders.results) {
    const folder = row.folder as string;
    folderSet.add(folder);
    // 添加所有父路径
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      folderSet.add(path);
    }
  }

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const folderList = Array.from(folderSet).sort().map(name => ({
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
    const meta = await getFileById(env, id);
    if (!meta) continue;
    if (meta.folder === targetFolder) continue;
    if (meta.uploadStatus && meta.uploadStatus !== 'done') continue; // 不能移动未完成的文件

    const newKey = targetFolder === 'root' ? meta.name : targetFolder + '/' + meta.name;

    const oldObject = await env.VAULT_BUCKET.get(meta.key);
    if (!oldObject) continue;

    await env.VAULT_BUCKET.put(newKey, oldObject.body, {
      httpMetadata: oldObject.httpMetadata,
      customMetadata: oldObject.customMetadata,
    });
    await env.VAULT_BUCKET.delete(meta.key);

    await env.DB.prepare(
      `UPDATE files SET folder = ?, key = ? WHERE id = ?`
    ).bind(targetFolder, newKey, id).run();
    moved++;
  }

  return json({ moved });
}

export async function thumbnail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFileById(env, id);
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

export async function preview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.indexOf('files') + 1];
  if (!id) return error('File ID required', 400);

  const meta = await getFileById(env, id);
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
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
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