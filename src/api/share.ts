import { Env, FileMeta } from '../utils/types';
import { json, error } from '../utils/response';
import { getSettings } from './settings';

function extractFileId(url: URL): string | null {
  const parts = url.pathname.split('/');
  const idx = parts.indexOf('share');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
}

async function hashSharePassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + ':cloudvault-share-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySharePassword(input: string, storedHash: string): Promise<boolean> {
  const inputHash = await hashSharePassword(input);
  const encoder = new TextEncoder();
  const a = encoder.encode(inputHash);
  const b = encoder.encode(storedHash);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function getSharedFolders(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(`SELECT folder FROM folder_shares`).all();
  return new Set(rows.results.map(r => r.folder as string));
}

export async function getExcludedFolders(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(`SELECT folder FROM folder_excludes`).all();
  return new Set(rows.results.map(r => r.folder as string));
}

export function isFolderShared(folderPath: string, sharedFolders: Set<string>, excludedFolders?: Set<string>): boolean {
  if (!folderPath || folderPath === 'root') return false;
  if (excludedFolders?.has(folderPath)) return false;
  let current = folderPath;
  while (current) {
    if (sharedFolders.has(current)) return true;
    const lastSlash = current.lastIndexOf('/');
    if (lastSlash < 0) break;
    current = current.substring(0, lastSlash);
  }
  return false;
}

async function getFileById(env: Env, id: string): Promise<FileMeta | null> {
  const row = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, share_token as shareToken, share_password as sharePassword, share_expires_at as shareExpiresAt, downloads FROM files WHERE id = ?`
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

async function getAllFiles(env: Env): Promise<FileMeta[]> {
  const rows = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, share_token as shareToken, share_password as sharePassword, share_expires_at as shareExpiresAt, downloads FROM files`
  ).all();
  return rows.results.map(r => ({
    id: r.id, key: r.key, name: r.name, size: r.size, type: r.type, folder: r.folder,
    uploadedAt: r.uploadedAt, shareToken: r.shareToken, sharePassword: r.sharePassword,
    shareExpiresAt: r.shareExpiresAt, downloads: r.downloads,
  }));
}

export async function createShare(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    fileId: string;
    password?: string;
    expiresInDays?: number;
  }>();

  if (!body.fileId) return error('fileId required', 400);

  const meta = await getFileById(env, body.fileId);
  if (!meta) return error('File not found', 404);

  const token = crypto.randomUUID();
  let passwordHash: string | null = null;
  if (body.password) {
    passwordHash = await hashSharePassword(body.password);
  }

  let expiresAt: string | null = null;
  if (body.expiresInDays && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  await env.DB.prepare(
    `UPDATE files SET share_token = ?, share_password = ?, share_expires_at = ? WHERE id = ?`
  ).bind(token, passwordHash, expiresAt, body.fileId).run();

  return json({
    token,
    url: '/s/' + token,
    expiresAt,
    hasPassword: !!passwordHash,
  });
}

export async function revokeShare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fileId = extractFileId(url);
  if (!fileId) return error('File ID required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  await env.DB.prepare(
    `UPDATE files SET share_token = NULL, share_password = NULL, share_expires_at = NULL WHERE id = ?`
  ).bind(fileId).run();

  return json({ message: 'Share revoked' });
}

export async function getShareInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fileId = extractFileId(url);
  if (!fileId) return error('File ID required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  return json({
    fileId: meta.id,
    token: meta.shareToken,
    hasPassword: !!meta.sharePassword,
    expiresAt: meta.shareExpiresAt,
    downloads: meta.downloads,
  });
}

export async function shareFolderToggle(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);

  const folder = body.folder.trim();
  const existing = await env.DB.prepare(`SELECT folder FROM folder_shares WHERE folder = ?`).bind(folder).first();

  if (existing) {
    await env.DB.prepare(`DELETE FROM folder_shares WHERE folder = ?`).bind(folder).run();
    return json({ shared: false, folder });
  }

  await env.DB.prepare(
    `INSERT INTO folder_shares (folder, shared_at) VALUES (?, ?)`
  ).bind(folder, new Date().toISOString()).run();
  return json({ shared: true, folder });
}

export async function listSharedFolders(_request: Request, env: Env): Promise<Response> {
  const folders = await getSharedFolders(env);
  return json({ folders: Array.from(folders).sort() });
}

export async function toggleFolderExclude(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ folder: string }>();
  if (!body.folder?.trim()) return error('Folder name required', 400);

  const folder = body.folder.trim();
  const existing = await env.DB.prepare(`SELECT folder FROM folder_excludes WHERE folder = ?`).bind(folder).first();

  if (existing) {
    await env.DB.prepare(`DELETE FROM folder_excludes WHERE folder = ?`).bind(folder).run();
    return json({ excluded: false, folder });
  }

  await env.DB.prepare(
    `INSERT INTO folder_excludes (folder, excluded_at) VALUES (?, ?)`
  ).bind(folder, new Date().toISOString()).run();
  return json({ excluded: true, folder });
}

export async function createFolderShareLink(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    folder: string;
    password?: string;
    expiresInDays?: number;
  }>();

  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  const existing = await env.DB.prepare(`SELECT token FROM folder_share_meta WHERE folder = ?`).bind(folder).first<{ token: string }>();
  if (existing) {
    await env.DB.prepare(`DELETE FROM folder_share_links WHERE token = ?`).bind(existing.token).run();
    await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(folder).run();
  }

  const token = crypto.randomUUID();
  let passwordHash: string | null = null;
  if (body.password) {
    passwordHash = await hashSharePassword(body.password);
  }

  let expiresAt: string | null = null;
  if (body.expiresInDays && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const linkData = { folder, passwordHash, expiresAt, createdAt: new Date().toISOString() };

  await env.DB.prepare(
    `INSERT INTO folder_share_links (token, folder, password_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(token, folder, passwordHash, expiresAt, linkData.createdAt).run();

  await env.DB.prepare(
    `INSERT INTO folder_share_meta (folder, token, password_hash, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(folder, token, passwordHash, expiresAt).run();

  return json({
    token,
    url: '/s/' + token,
    expiresAt,
    hasPassword: !!passwordHash,
  });
}

export async function revokeFolderShareLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
  if (!folder) return error('Folder path required', 400);

  const existing = await env.DB.prepare(`SELECT token FROM folder_share_meta WHERE folder = ?`).bind(folder).first<{ token: string }>();
  if (!existing) return error('No share link found for this folder', 404);

  await env.DB.prepare(`DELETE FROM folder_share_links WHERE token = ?`).bind(existing.token).run();
  await env.DB.prepare(`DELETE FROM folder_share_meta WHERE folder = ?`).bind(folder).run();

  return json({ message: 'Folder share link revoked' });
}

export async function getFolderShareLinkInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
  if (!folder) return error('Folder path required', 400);

  const meta = await env.DB.prepare(`SELECT token, password_hash, expires_at FROM folder_share_meta WHERE folder = ?`).bind(folder).first<{ token: string; password_hash: string | null; expires_at: string | null }>();
  if (!meta) return json({ token: null });

  return json({
    folder,
    token: meta.token,
    hasPassword: !!meta.password_hash,
    expiresAt: meta.expires_at,
  });
}

export async function resolveFolderShareToken(token: string, env: Env): Promise<{ folder: string; passwordHash: string | null; expiresAt: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT folder, password_hash, expires_at FROM folder_share_links WHERE token = ?`
  ).bind(token).first<{ folder: string; password_hash: string | null; expires_at: string | null }>();
  if (!row) return null;
  return {
    folder: row.folder,
    passwordHash: row.password_hash,
    expiresAt: row.expires_at,
  };
}

export async function browseFolderShareLink(folder: string, subpath: string, env: Env): Promise<{ files: Array<{ id: string; name: string; size: number; type: string; folder: string; uploadedAt: string }>; subfolders: string[] }> {
  const browsePath = subpath ? folder + '/' + subpath : folder;
  const prefix = browsePath + '/';

  const fileRows = await env.DB.prepare(
    `SELECT id, name, size, type, folder, uploaded_at as uploadedAt FROM files WHERE folder = ?`
  ).bind(browsePath).all();
  const files = fileRows.results.map(r => ({
    id: r.id as string,
    name: r.name as string,
    size: r.size as number,
    type: r.type as string,
    folder: r.folder as string,
    uploadedAt: r.uploadedAt as string,
  })).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  const subRows = await env.DB.prepare(
    `SELECT DISTINCT folder FROM files WHERE folder LIKE ?`
  ).bind(prefix + '%').all();
  const subfolderSet = new Set<string>();
  for (const row of subRows.results) {
    const f = row.folder as string;
    const rest = f.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
    if (childName) subfolderSet.add(prefix + childName);
  }

  const folderRows = await env.DB.prepare(
    `SELECT path FROM folders WHERE path LIKE ?`
  ).bind(prefix + '%').all();
  for (const row of folderRows.results) {
    const f = row.path as string;
    const rest = f.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
    if (childName) subfolderSet.add(prefix + childName);
  }

  return { files, subfolders: Array.from(subfolderSet).sort() };
}

export async function listPublicShared(request: Request, env: Env): Promise<Response> {
  const settings = await getSettings(env);
  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const allFiles = await getAllFiles(env);

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
    settings: { showLoginButton: settings.showLoginButton, siteName: settings.siteName, siteIconUrl: settings.siteIconUrl },
  });
}

export async function browsePublicFolder(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);

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

  const allFiles = await getAllFiles(env);
  const prefix = path + '/';

  let folderFiles: Array<{
    id: string; name: string; size: number; type: string;
    token: string | null; folder: string; uploadedAt: string;
  }> = [];

  if (isSharedOrChild) {
    folderFiles = allFiles
      .filter(f => f.folder === path)
      .map(f => ({
        id: f.id, name: f.name, size: f.size, type: f.type,
        token: f.shareToken || null, folder: f.folder, uploadedAt: f.uploadedAt,
      }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  const subfolderSet = new Set<string>();

  if (isAncestorOfShared) {
    for (const sf of sharedFolders) {
      if (sf.startsWith(prefix)) {
        const rest = sf.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        if (childName) subfolderSet.add(prefix + childName);
      }
    }
  } else {
    for (const f of allFiles) {
      if (f.folder.startsWith(prefix)) {
        const rest = f.folder.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        if (childName) subfolderSet.add(prefix + childName);
      }
    }
    const folderRows = await env.DB.prepare(
      `SELECT path FROM folders WHERE path LIKE ?`
    ).bind(prefix + '%').all();
    for (const row of folderRows.results) {
      const f = row.path as string;
      const rest = f.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const childName = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
      if (childName) subfolderSet.add(prefix + childName);
    }
  }

  for (const ex of excludedFolders) {
    subfolderSet.delete(ex);
    for (const sf of subfolderSet) {
      if (sf.startsWith(ex + '/')) subfolderSet.delete(sf);
    }
  }

  return json({ files: folderFiles, subfolders: Array.from(subfolderSet).sort(), currentFolder: path });
}

export async function publicDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const fileId = parts[parts.length - 1];
  if (!fileId) return error('File ID required', 400);

  const meta = await getFileById(env, fileId);
  if (!meta) return error('File not found', 404);

  const hasPublicLink = !!meta.shareToken && !meta.sharePassword &&
    (!meta.shareExpiresAt || new Date(meta.shareExpiresAt) >= new Date());
  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const inSharedFolder = isFolderShared(meta.folder, sharedFolders, excludedFolders);

  if (!hasPublicLink && !inSharedFolder) {
    return error('File not publicly accessible', 403);
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