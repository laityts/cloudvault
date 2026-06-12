import type { Env, FileMeta } from '../utils/types';
import { json, error, getPreviewType, fetchAssetHtml, injectBranding } from '../utils/response';
import { parsePassword } from '../utils/validate';
import { extractPathParam } from '../utils/keys';
import { streamR2Object } from '../utils/r2';
import {
  verifySharePassword,
  resolveFolderShareToken,
  getSharedFolders,
  getExcludedFolders,
  isFolderShared,
} from './share';
import { getSettings } from './settings';
import {
  getFile,
  getFileByShareToken,
  putFile,
  listAllFiles,
  listFilesInFolder,
  listFilesByFolderPrefix,
} from '../db/files';
import { listFoldersByPrefix } from '../db/folders';

// ─── Internal helpers ─────────────────────────────────────────────────

function extractToken(url: URL): string | null {
  return extractPathParam(url, 's');
}

async function resolveShare(
  token: string,
  env: Env,
): Promise<{ meta: FileMeta; expired: boolean } | null> {
  const meta = await getFileByShareToken(env, token);
  if (!meta) return null;
  const expired = !!meta.shareExpiresAt && new Date(meta.shareExpiresAt) < new Date();
  return { meta, expired };
}

function hasValidShareCookie(request: Request, token: string): boolean {
  const cookies = request.headers.get('Cookie') || '';
  return cookies.includes('share_' + token + '=verified');
}

/**
 * Collect direct child names under `prefix` from a mixed list of file folder
 * paths and folder records. Used by both browseFolderShareLink and
 * browsePublicFolder.
 */
function collectShareChildren(
  prefix: string,
  fileFolders: ReadonlyArray<{ folder: string }>,
  folderPaths: ReadonlyArray<{ path: string }>,
): Set<string> {
  const result = new Set<string>();
  const collect = (s: string) => {
    if (!s.startsWith(prefix)) return;
    const rest = s.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
    if (childName) result.add(prefix + childName);
  };
  for (const f of fileFolders) collect(f.folder);
  for (const fr of folderPaths) collect(fr.path);
  return result;
}

async function browseFolderShareLink(
  folder: string,
  subpath: string,
  env: Env,
): Promise<{
  files: Array<{ id: string; name: string; size: number; type: string; folder: string; uploadedAt: string }>;
  subfolders: string[];
}> {
  const browsePath = subpath ? folder + '/' + subpath : folder;
  const prefix = browsePath + '/';

  const filesInFolder = await listFilesInFolder(env, browsePath);
  const folderFiles = filesInFolder
    .map(f => ({
      id: f.id, name: f.name, size: f.size, type: f.type,
      folder: f.folder, uploadedAt: f.uploadedAt,
    }))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  const descendantFiles = await listFilesByFolderPrefix(env, browsePath);
  const descendantFolders = await listFoldersByPrefix(env, browsePath);
  const subfolderSet = collectShareChildren(prefix, descendantFiles, descendantFolders);

  return { files: folderFiles, subfolders: Array.from(subfolderSet).sort() };
}

async function serveShareHtml(
  env: Env,
  request: Request,
  fileData: Record<string, unknown>,
): Promise<Response> {
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

// ─── Public Shared Listing (with folder inheritance) ──────────────────

export async function listPublicShared(_request: Request, env: Env): Promise<Response> {
  const [settings, sharedFolders, excludedFolders, allFiles] = await Promise.all([
    getSettings(env),
    getSharedFolders(env),
    getExcludedFolders(env),
    listAllFiles(env),
  ]);

  const visibleFolders = Array.from(sharedFolders).filter(sf => !excludedFolders.has(sf));

  const files: Array<{
    id: string; name: string; size: number; type: string;
    token: string | null; folder: string; uploadedAt: string;
  }> = [];

  for (const meta of allFiles) {
    const hasValidShareLink = !!meta.shareToken && !meta.sharePassword &&
      (!meta.shareExpiresAt || new Date(meta.shareExpiresAt) >= new Date());
    const inSharedFolder = isFolderShared(meta.folder, sharedFolders, excludedFolders);

    if (hasValidShareLink && !inSharedFolder) {
      files.push({
        id: meta.id, name: meta.name, size: meta.size, type: meta.type,
        token: meta.shareToken, folder: meta.folder, uploadedAt: meta.uploadedAt,
      });
    }
  }

  files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return json({
    files,
    sharedFolders: visibleFolders.sort(),
    settings: {
      showLoginButton: settings.showLoginButton,
      siteName: settings.siteName,
      siteIconUrl: settings.siteIconUrl,
    },
  });
}

// ─── Public Folder Browse ─────────────────────────────────────────────

export async function browsePublicFolder(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const [sharedFolders, excludedFolders] = await Promise.all([
    getSharedFolders(env),
    getExcludedFolders(env),
  ]);

  if (!path) {
    const visibleFolders = Array.from(sharedFolders).filter(sf => !excludedFolders.has(sf));
    return json({ files: [], subfolders: visibleFolders.sort(), currentFolder: '' });
  }

  const isSharedOrChild = isFolderShared(path, sharedFolders, excludedFolders);
  const isAncestorOfShared = !isSharedOrChild && Array.from(sharedFolders).some(
    sf => sf.startsWith(path + '/') && !excludedFolders.has(sf)
  );

  if (!isSharedOrChild && !isAncestorOfShared) {
    return error('Folder not shared', 403);
  }

  const prefix = path + '/';

  let folderFiles: Array<{
    id: string; name: string; size: number; type: string;
    token: string | null; folder: string; uploadedAt: string;
  }> = [];

  if (isSharedOrChild) {
    const filesInFolder = await listFilesInFolder(env, path);
    folderFiles = filesInFolder
      .map(f => ({
        id: f.id, name: f.name, size: f.size, type: f.type,
        token: f.shareToken || null, folder: f.folder, uploadedAt: f.uploadedAt,
      }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  let subfolderSet: Set<string>;

  if (isAncestorOfShared) {
    subfolderSet = new Set<string>();
    for (const sf of sharedFolders) {
      if (sf.startsWith(prefix)) {
        const rest = sf.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        if (childName) subfolderSet.add(prefix + childName);
      }
    }
  } else {
    const descendantFiles = await listFilesByFolderPrefix(env, path);
    const descendantFolders = await listFoldersByPrefix(env, path);
    subfolderSet = collectShareChildren(prefix, descendantFiles, descendantFolders);
  }

  for (const ex of excludedFolders) {
    subfolderSet.delete(ex);
    for (const sf of subfolderSet) {
      if (sf.startsWith(ex + '/')) subfolderSet.delete(sf);
    }
  }

  return json({ files: folderFiles, subfolders: Array.from(subfolderSet).sort(), currentFolder: path });
}

// ─── Public File Download (folder-shared files) ──────────────────────

export async function publicDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const fileId = parts[parts.length - 1];
  if (!fileId) return error('File ID required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);

  const [sharedFolders, excludedFolders] = await Promise.all([
    getSharedFolders(env),
    getExcludedFolders(env),
  ]);
  const hasPublicLink = !!meta.shareToken && !meta.sharePassword &&
    (!meta.shareExpiresAt || new Date(meta.shareExpiresAt) >= new Date());
  const inSharedFolder = isFolderShared(meta.folder, sharedFolders, excludedFolders);

  if (!hasPublicLink && !inSharedFolder) {
    return error('File not publicly accessible', 403);
  }

  // 公开下载的可见性取决于可变的分享状态，且 caches.default 是按数据中心隔离的、
  // 无法跨 colo 全局失效，因此不做共享边缘缓存，只允许浏览器短时私有缓存，
  // 保证撤销分享 / 取消文件夹分享后即时生效。
  const res = await streamR2Object(env.VAULT_BUCKET, meta.key, request, {
    cacheControl: 'private, max-age=300',
    headers: {
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(meta.name) + '"',
    },
  });
  if (!res) return error('File not found in storage', 404);

  meta.downloads++;
  await putFile(env, meta);

  return res;
}

// ─── Share Page (token-based, single file or folder) ─────────────────

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

// ─── Share Download / Preview (token-based, single file) ─────────────

export async function handleShareDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const result = await resolveShare(token, env);
  if (!result || result.expired) return error('Share link invalid or expired', 404);

  if (result.meta.sharePassword && !hasValidShareCookie(request, token)) {
    return error('Password required', 403);
  }

  const res = await streamR2Object(env.VAULT_BUCKET, result.meta.key, request, {
    cacheControl: 'public, max-age=14400, s-maxage=86400',
    acceptRanges: true,
    headers: {
      'Content-Disposition': 'attachment; filename="' + result.meta.name + '"',
    },
  });
  if (!res) return error('File not found in storage', 404);

  result.meta.downloads++;
  await putFile(env, result.meta);

  return res;
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

  const res = await streamR2Object(env.VAULT_BUCKET, result.meta.key, request, {
    cacheControl: 'public, max-age=14400, s-maxage=86400',
    acceptRanges: true,
    headers: {
      'Content-Type': result.meta.type || 'application/octet-stream',
      'Content-Disposition': 'inline',
    },
  });
  return res ?? error('File not found', 404);
}

// ─── Folder Share Download / Preview (token + fileId in query) ───────

async function resolveFolderShareFile(
  request: Request,
  env: Env,
): Promise<{ meta: FileMeta } | Response> {
  const url = new URL(request.url);
  const token = extractToken(url);
  if (!token) return error('Invalid share link', 400);

  const folderLink = await resolveFolderShareToken(token, env);
  if (!folderLink) return error('Share link invalid', 404);
  if (folderLink.expiresAt && new Date(folderLink.expiresAt) < new Date()) {
    return error('Share link expired', 404);
  }
  if (folderLink.passwordHash && !hasValidShareCookie(request, token)) {
    return error('Password required', 403);
  }

  const fileId = url.searchParams.get('fileId');
  if (!fileId) return error('fileId required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);
  if (!meta.folder.startsWith(folderLink.folder) && meta.folder !== folderLink.folder) {
    return error('File not in shared folder', 403);
  }
  return { meta };
}

export async function handleFolderShareDownload(request: Request, env: Env): Promise<Response> {
  const resolved = await resolveFolderShareFile(request, env);
  if (resolved instanceof Response) return resolved;
  const meta = resolved.meta;

  const res = await streamR2Object(env.VAULT_BUCKET, meta.key, request, {
    cacheControl: 'public, max-age=14400, s-maxage=86400',
    headers: {
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(meta.name) + '"',
    },
  });
  if (!res) return error('File not found in storage', 404);

  meta.downloads++;
  await putFile(env, meta);

  return res;
}

export async function handleFolderSharePreview(request: Request, env: Env): Promise<Response> {
  const resolved = await resolveFolderShareFile(request, env);
  if (resolved instanceof Response) return resolved;
  const meta = resolved.meta;

  const res = await streamR2Object(env.VAULT_BUCKET, meta.key, request, {
    cacheControl: 'public, max-age=14400, s-maxage=86400',
    headers: {
      'Content-Type': meta.type || 'application/octet-stream',
      'Content-Disposition': 'inline',
    },
  });
  return res ?? error('File not found in storage', 404);
}

// ─── Share Password Verify ────────────────────────────────────────────

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
    if (folderLink) storedPassword = folderLink.passwordHash;
  }

  if (!storedPassword) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/s/' + token },
    });
  }

  const password = await parsePassword(request);
  const valid = await verifySharePassword(password, storedPassword);
  if (!valid) return error('Invalid password', 401);

  const cookieMaxAge = 24 * 60 * 60;
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/s/' + token,
      'Set-Cookie': 'share_' + token + '=verified; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + cookieMaxAge,
    },
  });
}
