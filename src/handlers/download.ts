import { Env, FileMeta } from '../utils/types';
import { error, getPreviewType, fetchAssetHtml, injectBranding, getMimeType } from '../utils/response';
import { verifySharePassword, resolveFolderShareToken, browseFolderShareLink, getSharedFolders, getExcludedFolders, isFolderShared } from '../api/share';
import { getSettings } from '../api/settings';

function extractToken(url: URL): string | null {
  const parts = url.pathname.split('/');
  const sIdx = parts.indexOf('s');
  return sIdx >= 0 && parts[sIdx + 1] ? parts[sIdx + 1] : null;
}

// 修改：仅返回已完成上传的文件
async function getFileByShareToken(token: string, env: Env): Promise<FileMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
            share_token as shareToken, share_password as sharePassword, 
            share_expires_at as shareExpiresAt, downloads 
     FROM files 
     WHERE share_token = ? AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(token).first<{
    id: string; key: string; name: string; size: number; type: string; folder: string;
    uploadedAt: string; shareToken: string | null; sharePassword: string | null;
    shareExpiresAt: string | null; downloads: number;
  }>();
  if (!row) return null;
  return {
    ...row,
    uploadedAt: row.uploadedAt,
    shareToken: row.shareToken,
    sharePassword: row.sharePassword,
    shareExpiresAt: row.shareExpiresAt,
  };
}

async function resolveShare(token: string, env: Env): Promise<{ meta: FileMeta; expired: boolean } | null> {
  const meta = await getFileByShareToken(token, env);
  if (!meta) return null;
  const expired = !!meta.shareExpiresAt && new Date(meta.shareExpiresAt) < new Date();
  return { meta, expired };
}

function hasValidShareCookie(request: Request, token: string): boolean {
  const cookies = request.headers.get('Cookie') || '';
  return cookies.includes('share_' + token + '=verified');
}

export async function handleSharePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (result) {
    if (result.expired) {
      return serveShareHtml(env, request, { error: 'This share link has expired.' });
    }
    if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
      return serveShareHtml(env, request, { needsPassword: true });
    }
    return serveShareHtml(env, request, {
      name: result.meta.name,
      size: result.meta.size,
      type: result.meta.type,
      uploadedAt: result.meta.uploadedAt,
      downloads: result.meta.downloads,
      previewType: getPreviewType(result.meta.name, result.meta.type),
    });
  }

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) {
    return serveShareHtml(env, request, { error: 'This share link is invalid or has been revoked.' });
  }

  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) {
    return serveShareHtml(env, request, { error: 'This share link has expired.' });
  }

  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) {
    return serveShareHtml(env, request, { needsPassword: true, isFolder: true });
  }

  const subpath = url.searchParams.get('path') || '';
  const browseResult = await browseFolderShareLink(folderLink.folder, subpath, env);
  const folderName = folderLink.folder.split('/').pop() || folderLink.folder;

  return serveShareHtml(env, request, {
    isFolder: true,
    folderName,
    folder: folderLink.folder,
    subpath,
    files: browseResult.files,
    subfolders: browseResult.subfolders,
  });
}

export async function handleFolderShareDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) return error('Share link invalid', 404);
  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) return error('Share link expired', 404);
  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) return error('Password required', 403);

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  if (!meta.folder.startsWith(folderLink.folder) && meta.folder !== folderLink.folder) {
    return error('File not in shared folder', 403);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  await env.DB.prepare(
    `UPDATE files SET downloads = downloads + 1 WHERE id = ?`
  ).bind(meta.id).run();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}

export async function handleFolderSharePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) return error('Share link invalid', 404);
  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) return error('Share link expired', 404);
  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) return error('Password required', 403);

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  if (!meta.folder.startsWith(folderLink.folder) && meta.folder !== folderLink.folder) {
    return error('File not in shared folder', 403);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', meta.type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');

  return new Response(object.body, { headers });
}

async function serveShareHtml(env: Env, request: Request, fileData: Record<string, unknown>): Promise<Response> {
  const settings = await getSettings(env);
  let html = await fetchAssetHtml(env.ASSETS, request.url, '/share.html');

  html = injectBranding(html, { siteName: settings.siteName, siteIconUrl: settings.siteIconUrl });
  html = html.replace(
    '<script id="file-data" type="application/json">{}</script>',
    '<script id="file-data" type="application/json">' + JSON.stringify(fileData) + '</script>'
  );

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function handleShareDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (!result || result.expired) return error('Share link invalid or expired', 404);

  if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
    return error('Password required', 403);
  }

  const object = await env.VAULT_BUCKET.get(result.meta.key);
  if (!object) return error('File not found in storage', 404);

  await env.DB.prepare(
    `UPDATE files SET downloads = downloads + 1 WHERE id = ?`
  ).bind(result.meta.id).run();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Disposition', 'attachment; filename="' + result.meta.name + '"');
  headers.set('Content-Length', String(object.size));

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    return handleRangeRequest(request, env, result.meta, object, headers);
  }

  return new Response(object.body, { headers });
}

export async function handlePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (!result || result.expired) return error('Share link invalid or expired', 404);

  if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
    return error('Password required', 403);
  }

  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    const object = await env.VAULT_BUCKET.get(result.meta.key);
    if (!object) return error('File not found', 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Type', result.meta.type || 'application/octet-stream');
    headers.set('Accept-Ranges', 'bytes');

    return handleRangeRequest(request, env, result.meta, object, headers);
  }

  const object = await env.VAULT_BUCKET.get(result.meta.key);
  if (!object) return error('File not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', result.meta.type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Accept-Ranges', 'bytes');

  return new Response(object.body, { headers });
}

function handleRangeRequest(
  request: Request,
  env: Env,
  meta: FileMeta,
  object: R2ObjectBody,
  headers: Headers,
): Response {
  const rangeHeader = request.headers.get('Range') || '';
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);

  if (!match) {
    return new Response(object.body, { headers });
  }

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
  headers.set('Accept-Ranges', 'bytes');

  return new Response(object.body, { status: 206, headers });
}

export async function handleSharePassword(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  let storedPassword: string | null = null;

  const result = await resolveShare(token, env);
  if (result) {
    storedPassword = result.meta.sharePassword;
  } else {
    const folderLink = await resolveFolderShareToken(token, env);
    if (folderLink) {
      storedPassword = folderLink.passwordHash;
    }
  }

  if (!storedPassword) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/s/' + token },
    });
  }

  const contentType = request.headers.get('Content-Type') || '';
  let password: string;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    password = formData.get('password') as string || '';
  } else if (contentType.includes('application/json')) {
    const body = await request.json<{ password: string }>();
    password = body.password || '';
  } else {
    return error('Unsupported content type', 415);
  }

  const valid = await verifySharePassword(password, storedPassword);
  if (!valid) return error('Invalid password', 401);

  const cookieMaxAge = 24 * 60 * 60;
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/s/' + token,
      'Set-Cookie': 'share_' + token + '=verified; Path=/s/' + token + '; HttpOnly; Secure; SameSite=Lax; Max-Age=' + cookieMaxAge,
    },
  });
}

export async function handleCleanDownload(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }

  if (!decodedPath || !decodedPath.includes('/')) return null;

  const lastSlash = decodedPath.lastIndexOf('/');
  const folder = decodedPath.substring(0, lastSlash);
  const fileName = decodedPath.substring(lastSlash + 1);
  if (!folder || !fileName) return null;

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  if (!isFolderShared(folder, sharedFolders, excludedFolders)) return null;

  const meta = await findFileByPath(env, folder, fileName);
  if (!meta) return null;

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return null;

  await env.DB.prepare(
    `UPDATE files SET downloads = downloads + 1 WHERE id = ?`
  ).bind(meta.id).run();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Length', String(object.size));
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', getMimeType(meta.name));
  }
  headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');

  return new Response(object.body, { headers });
}

// 修改：仅返回已完成上传的文件
async function findFileByPath(env: Env, folder: string, fileName: string): Promise<FileMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
            share_token as shareToken, share_password as sharePassword, 
            share_expires_at as shareExpiresAt, downloads 
     FROM files 
     WHERE folder = ? AND name = ? AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(folder, fileName).first<{
    id: string; key: string; name: string; size: number; type: string; folder: string;
    uploadedAt: string; shareToken: string | null; sharePassword: string | null;
    shareExpiresAt: string | null; downloads: number;
  }>();
  if (!row) return null;
  return {
    ...row,
    uploadedAt: row.uploadedAt,
    shareToken: row.shareToken,
    sharePassword: row.sharePassword,
    shareExpiresAt: row.shareExpiresAt,
  };
}

// 辅助函数：通过ID获取文件（也用于内部调用，同样过滤）
async function getFileById(env: Env, id: string): Promise<FileMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, 
            share_token as shareToken, share_password as sharePassword, 
            share_expires_at as shareExpiresAt, downloads 
     FROM files 
     WHERE id = ? AND (upload_status = 'done' OR upload_status IS NULL)`
  ).bind(id).first<{
    id: string; key: string; name: string; size: number; type: string; folder: string;
    uploadedAt: string; shareToken: string | null; sharePassword: string | null;
    shareExpiresAt: string | null; downloads: number;
  }>();
  if (!row) return null;
  return {
    ...row,
    uploadedAt: row.uploadedAt,
    shareToken: row.shareToken,
    sharePassword: row.sharePassword,
    shareExpiresAt: row.shareExpiresAt,
  };
}