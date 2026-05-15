import { Env, FileMeta } from '../utils/types';
import { error, getPreviewType, fetchAssetHtml, injectBranding, getMimeType, stringifyForHtmlScript, contentDispositionFilename } from '../utils/response';
import { verifySharePassword, resolveFolderShareToken, browseFolderShareLink, getSharedFolders, getExcludedFolders, isFolderShared } from '../api/share';
import { getSettings } from '../api/settings';

type ByteRange = {
  start: number;
  end: number;
};

function extractToken(url: URL): string | null {
  const parts = url.pathname.split('/');
  const sIdx = parts.indexOf('s');
  return sIdx >= 0 && parts[sIdx + 1] ? parts[sIdx + 1] : null;
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

function getStoredContentType(meta: Pick<FileMeta, 'name' | 'type'>): string {
  const type = typeof meta.type === 'string' ? meta.type : '';
  if (type && type !== 'application/octet-stream') return type;
  return getMimeType(meta.name);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function signShareCookiePayload(env: Env, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

function getCookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie') || '';
  for (const part of cookies.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

async function createShareCookieValue(token: string, env: Env, maxAgeSeconds: number): Promise<string> {
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const payload = token + '.' + expiresAt;
  const signature = await signShareCookiePayload(env, payload);
  return payload + '.' + signature;
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

async function hasValidShareCookie(request: Request, token: string, env: Env): Promise<boolean> {
  const rawValue = getCookieValue(request, 'share_' + token);
  if (!rawValue) return false;

  let value: string;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    return false;
  }

  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== token) return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const payload = parts[0] + '.' + parts[1];
  const expected = await signShareCookiePayload(env, payload);
  return constantTimeEqual(expected, parts[2]);
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
    if (result.meta.sharePassword && !(await hasValidShareCookie(request, token, env))) {
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

  if (folderLink.passwordHash && !(await hasValidShareCookie(request, token, env))) {
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
  if (folderLink.passwordHash && !(await hasValidShareCookie(request, token, env))) return error('Password required', 403);

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  if (!isFolderShareMember(meta.folder, folderLink.folder)) {
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
  headers.set('Content-Disposition', 'attachment; ' + contentDispositionFilename(meta.name));
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
  if (folderLink.passwordHash && !(await hasValidShareCookie(request, token, env))) return error('Password required', 403);

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  if (!isFolderShareMember(meta.folder, folderLink.folder)) {
    return error('File not in shared folder', 403);
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    return handleInlinePreviewRange(request, env, meta, 'public, max-age=14400, s-maxage=86400');
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', getStoredContentType(meta));
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}

async function handleInlinePreviewRange(
  request: Request,
  env: Env,
  meta: FileMeta,
  cacheControl: string,
): Promise<Response> {
  const rangeHeader = request.headers.get('Range') || '';
  const head = await env.VAULT_BUCKET.head(meta.key);
  if (!head) return error('File not found in storage', 404);

  const parsedRange = parseByteRange(rangeHeader, head.size);
  if (parsedRange === 'unsatisfiable') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + head.size },
    });
  }
  if (!parsedRange) {
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) return error('File not found in storage', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Type', getStoredContentType(meta));
    headers.set('Content-Disposition', 'inline');
    headers.set('Cache-Control', cacheControl);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  const length = parsedRange.end - parsedRange.start + 1;
  const object = await env.VAULT_BUCKET.get(meta.key, {
    range: { offset: parsedRange.start, length },
  });
  if (!object) return error('File not found in storage', 404);

  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set('etag', head.httpEtag);
  headers.set('Content-Type', getStoredContentType(meta));
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', cacheControl);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', 'bytes ' + parsedRange.start + '-' + parsedRange.end + '/' + head.size);
  headers.set('Content-Length', String(length));
  return new Response(object.body, { status: 206, headers });
}

async function serveShareHtml(env: Env, request: Request, fileData: Record<string, unknown>): Promise<Response> {
  const settings = await getSettings(env);
  let html = await fetchAssetHtml(env.ASSETS, request.url, '/share.html');

  html = injectBranding(html, { siteName: settings.siteName, siteIconUrl: settings.siteIconUrl });
  html = html.replace(
    '<script id="file-data" type="application/json">{}</script>',
    '<script id="file-data" type="application/json">' + stringifyForHtmlScript(fileData) + '</script>'
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

  if (result.meta.sharePassword && !(await hasValidShareCookie(request, token, env))) {
    return error('Password required', 403);
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const rangeResponse = await handleRangeRequest(request, env, result.meta);
    if (rangeResponse.ok) {
      await env.DB.prepare(
        `UPDATE files SET downloads = downloads + 1 WHERE id = ?`
      ).bind(result.meta.id).run();
    }
    return rangeResponse;
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
  headers.set('Content-Disposition', 'attachment; ' + contentDispositionFilename(result.meta.name));
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}

export async function handlePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (!result || result.expired) return error('Share link invalid or expired', 404);

  if (result.meta.sharePassword && !(await hasValidShareCookie(request, token, env))) {
    return error('Password required', 403);
  }

  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    return handleInlinePreviewRange(request, env, result.meta, 'public, max-age=14400, s-maxage=86400');
  }

  const object = await env.VAULT_BUCKET.get(result.meta.key);
  if (!object) return error('File not found', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', getStoredContentType(result.meta));
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { headers });
}

function isFolderShareMember(fileFolder: string, sharedFolder: string): boolean {
  return fileFolder === sharedFolder || fileFolder.startsWith(sharedFolder + '/');
}

async function handleRangeRequest(
  request: Request,
  env: Env,
  meta: FileMeta,
): Promise<Response> {
  const rangeHeader = request.headers.get('Range') || '';
  const head = await env.VAULT_BUCKET.head(meta.key);
  if (!head) return error('File not found in storage', 404);

  const parsedRange = parseByteRange(rangeHeader, head.size);

  if (!parsedRange) {
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) return error('File not found in storage', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
    headers.set('Content-Disposition', 'attachment; ' + contentDispositionFilename(meta.name));
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }

  if (parsedRange === 'unsatisfiable') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + head.size },
    });
  }

  const length = parsedRange.end - parsedRange.start + 1;
  const rangedObject = await env.VAULT_BUCKET.get(meta.key, {
    range: { offset: parsedRange.start, length },
  });
  if (!rangedObject) return error('File not found in storage', 404);

  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set('etag', head.httpEtag);
  headers.set('Cache-Control', 'public, max-age=14400, s-maxage=86400');
  headers.set('Content-Disposition', 'attachment; ' + contentDispositionFilename(meta.name));
  headers.set('Content-Range', 'bytes ' + parsedRange.start + '-' + parsedRange.end + '/' + head.size);
  headers.set('Content-Length', String(length));
  headers.set('Accept-Ranges', 'bytes');

  return new Response(rangedObject.body, { status: 206, headers });
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
    const value = formData.get('password');
    password = typeof value === 'string' ? value : '';
  } else if (contentType.includes('application/json')) {
    let body: { password?: unknown };
    try {
      body = await request.json<{ password?: unknown }>();
    } catch {
      return error('Invalid password payload', 400);
    }
    password = typeof body.password === 'string' ? body.password : '';
  } else {
    return error('Unsupported content type', 415);
  }

  const valid = await verifySharePassword(password, storedPassword);
  if (!valid) return error('Invalid password', 401);

  const cookieMaxAge = 24 * 60 * 60;
  const cookieValue = await createShareCookieValue(token, env, cookieMaxAge);
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/s/' + token,
      'Set-Cookie': 'share_' + token + '=' + encodeURIComponent(cookieValue) + '; Path=/s/' + token + '; HttpOnly; Secure; SameSite=Lax; Max-Age=' + cookieMaxAge,
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
  headers.set('Content-Disposition', 'attachment; ' + contentDispositionFilename(meta.name));

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
