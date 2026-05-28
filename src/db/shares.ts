import type { Env } from '../utils/types';

// ── folder_shares（文件夹分享标记） ──

export async function isFolderShareMarked(
  env: Env,
  folder: string,
): Promise<boolean> {
  const row = await env.VAULT_DB
    .prepare('SELECT 1 FROM folder_shares WHERE folder = ?')
    .bind(folder)
    .first<{ '1': number }>();
  return row !== null;
}

export async function addFolderShare(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO folder_shares (folder, shared_at) VALUES (?, ?)
       ON CONFLICT(folder) DO NOTHING`,
    )
    .bind(folder, new Date().toISOString())
    .run();
}

export async function removeFolderShare(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM folder_shares WHERE folder = ?')
    .bind(folder)
    .run();
}

export async function listSharedFolders(env: Env): Promise<Set<string>> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT folder FROM folder_shares')
    .all<{ folder: string }>();
  return new Set((results || []).map((r) => r.folder));
}

// ── folder_share_excludes ──

export async function isFolderExcluded(
  env: Env,
  folder: string,
): Promise<boolean> {
  const row = await env.VAULT_DB
    .prepare('SELECT 1 FROM folder_share_excludes WHERE folder = ?')
    .bind(folder)
    .first<{ '1': number }>();
  return row !== null;
}

export async function addFolderExclude(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO folder_share_excludes (folder, excluded_at) VALUES (?, ?)
       ON CONFLICT(folder) DO NOTHING`,
    )
    .bind(folder, new Date().toISOString())
    .run();
}

export async function removeFolderExclude(env: Env, folder: string): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM folder_share_excludes WHERE folder = ?')
    .bind(folder)
    .run();
}

export async function listExcludedFolders(env: Env): Promise<Set<string>> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT folder FROM folder_share_excludes')
    .all<{ folder: string }>();
  return new Set((results || []).map((r) => r.folder));
}

// ── folder_share_links ──

export interface FolderShareLink {
  token: string;
  folder: string;
  passwordHash: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface FolderShareLinkRow {
  token: string;
  folder: string;
  password_hash: string | null;
  expires_at: string | null;
  created_at: string;
}

function linkRowToObj(row: FolderShareLinkRow): FolderShareLink {
  return {
    token: row.token,
    folder: row.folder,
    passwordHash: row.password_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function getFolderShareLinkByToken(
  env: Env,
  token: string,
): Promise<FolderShareLink | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM folder_share_links WHERE token = ?')
    .bind(token)
    .first<FolderShareLinkRow>();
  return row ? linkRowToObj(row) : null;
}

export async function getFolderShareLinkByFolder(
  env: Env,
  folder: string,
): Promise<FolderShareLink | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM folder_share_links WHERE folder = ?')
    .bind(folder)
    .first<FolderShareLinkRow>();
  return row ? linkRowToObj(row) : null;
}

export async function upsertFolderShareLink(
  env: Env,
  link: FolderShareLink,
): Promise<void> {
  // 由于 folder 上有 UNIQUE，先删除旧记录再插入新 token
  await env.VAULT_DB.batch([
    env.VAULT_DB.prepare('DELETE FROM folder_share_links WHERE folder = ?').bind(link.folder),
    env.VAULT_DB
      .prepare(
        `INSERT INTO folder_share_links (token, folder, password_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(link.token, link.folder, link.passwordHash, link.expiresAt, link.createdAt),
  ]);
}

export async function deleteFolderShareLinkByFolder(
  env: Env,
  folder: string,
): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM folder_share_links WHERE folder = ?')
    .bind(folder)
    .run();
}

export async function deleteFolderShareLinksByFolderPrefix(
  env: Env,
  folderPrefix: string,
): Promise<void> {
  await env.VAULT_DB
    .prepare(
      'DELETE FROM folder_share_links WHERE folder = ? OR folder LIKE ?',
    )
    .bind(folderPrefix, folderPrefix + '/%')
    .run();
}
