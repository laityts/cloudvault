import type { Env } from '../utils/types';
import { json, error } from '../utils/response';
import { parseJson } from '../utils/validate';
import { extractPathParam } from '../utils/keys';
import {
  getFile,
  putFile,
} from '../db/files';
import {
  isFolderShareMarked,
  addFolderShare,
  removeFolderShare,
  listSharedFolders as dbListSharedFolders,
  isFolderExcluded,
  addFolderExclude,
  removeFolderExclude,
  listExcludedFolders as dbListExcludedFolders,
  getFolderShareLinkByToken,
  getFolderShareLinkByFolder,
  upsertFolderShareLink,
  deleteFolderShareLinkByFolder,
} from '../db/shares';

// ─── Password Hashing (shared with public + download flows) ──────────

export async function hashSharePassword(password: string): Promise<string> {
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

// ─── Folder Sharing Helpers (shared) ─────────────────────────────────

export async function getSharedFolders(env: Env): Promise<Set<string>> {
  return dbListSharedFolders(env);
}

export async function getExcludedFolders(env: Env): Promise<Set<string>> {
  return dbListExcludedFolders(env);
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

export async function resolveFolderShareToken(
  token: string,
  env: Env,
): Promise<{ folder: string; passwordHash: string | null; expiresAt: string | null } | null> {
  const link = await getFolderShareLinkByToken(env, token);
  if (!link) return null;
  return { folder: link.folder, passwordHash: link.passwordHash, expiresAt: link.expiresAt };
}

// ─── File Share CRUD (admin) ──────────────────────────────────────────

export async function createShare(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{
    fileId: string;
    password?: string;
    expiresInDays?: number;
  }>(request);

  if (!body.fileId) return error('fileId required', 400);

  const meta = await getFile(env, body.fileId);
  if (!meta) return error('File not found', 404);

  const token = crypto.randomUUID();
  let passwordHash: string | null = null;
  if (body.password) passwordHash = await hashSharePassword(body.password);

  let expiresAt: string | null = null;
  if (body.expiresInDays && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  meta.shareToken = token;
  meta.sharePassword = passwordHash;
  meta.shareExpiresAt = expiresAt;

  await putFile(env, meta);

  return json({
    token,
    url: '/s/' + token,
    expiresAt,
    hasPassword: !!passwordHash,
  });
}

export async function revokeShare(request: Request, env: Env): Promise<Response> {
  const fileId = extractPathParam(new URL(request.url), 'share');
  if (!fileId) return error('File ID required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);

  meta.shareToken = null;
  meta.sharePassword = null;
  meta.shareExpiresAt = null;

  await putFile(env, meta);

  return json({ message: 'Share revoked' });
}

export async function getShareInfo(request: Request, env: Env): Promise<Response> {
  const fileId = extractPathParam(new URL(request.url), 'share');
  if (!fileId) return error('File ID required', 400);

  const meta = await getFile(env, fileId);
  if (!meta) return error('File not found', 404);

  return json({
    fileId: meta.id,
    token: meta.shareToken,
    hasPassword: !!meta.sharePassword,
    expiresAt: meta.shareExpiresAt,
    downloads: meta.downloads,
  });
}

// ─── Folder Share Toggle (admin) ──────────────────────────────────────

export async function shareFolderToggle(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ folder: string }>(request);
  if (!body.folder?.trim()) return error('Folder name required', 400);

  const folder = body.folder.trim();
  if (await isFolderShareMarked(env, folder)) {
    await removeFolderShare(env, folder);
    return json({ shared: false, folder });
  }

  await addFolderShare(env, folder);
  return json({ shared: true, folder });
}

export async function listSharedFolders(_request: Request, env: Env): Promise<Response> {
  const folders = await getSharedFolders(env);
  return json({ folders: Array.from(folders).sort() });
}

export async function toggleFolderExclude(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ folder: string }>(request);
  if (!body.folder?.trim()) return error('Folder name required', 400);

  const folder = body.folder.trim();
  if (await isFolderExcluded(env, folder)) {
    await removeFolderExclude(env, folder);
    return json({ excluded: false, folder });
  }

  await addFolderExclude(env, folder);
  return json({ excluded: true, folder });
}

// ─── Folder Share Link CRUD (admin) ────────────────────────────────────

export async function createFolderShareLink(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{
    folder: string;
    password?: string;
    expiresInDays?: number;
  }>(request);

  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  const token = crypto.randomUUID();
  let passwordHash: string | null = null;
  if (body.password) passwordHash = await hashSharePassword(body.password);

  let expiresAt: string | null = null;
  if (body.expiresInDays && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  await upsertFolderShareLink(env, {
    token,
    folder,
    passwordHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

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

  const link = await getFolderShareLinkByFolder(env, folder);
  if (!link) return error('No share link found for this folder', 404);

  await deleteFolderShareLinkByFolder(env, folder);
  return json({ message: 'Folder share link revoked' });
}

export async function getFolderShareLinkInfo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const folder = decodeURIComponent(url.pathname.split('/').slice(3).join('/'));
  if (!folder) return error('Folder path required', 400);

  const link = await getFolderShareLinkByFolder(env, folder);
  if (!link) return json({ token: null });

  return json({
    folder,
    token: link.token,
    hasPassword: !!link.passwordHash,
    expiresAt: link.expiresAt,
  });
}
