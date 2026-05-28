import type { Env } from '../utils/types';

export interface FolderRecord {
  path: string;
  name: string;
  createdAt: string;
}

interface FolderRow {
  path: string;
  name: string;
  created_at: string;
}

function rowToRecord(row: FolderRow): FolderRecord {
  return { path: row.path, name: row.name, createdAt: row.created_at };
}

export async function getFolder(
  env: Env,
  path: string,
): Promise<FolderRecord | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM folders WHERE path = ?')
    .bind(path)
    .first<FolderRow>();
  return row ? rowToRecord(row) : null;
}

export async function putFolder(
  env: Env,
  path: string,
  name?: string,
): Promise<void> {
  const folderName = name ?? path;
  const createdAt = new Date().toISOString();
  await env.VAULT_DB
    .prepare(
      `INSERT INTO folders (path, name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         name = excluded.name`,
    )
    .bind(path, folderName, createdAt)
    .run();
}

export async function deleteFolder(env: Env, path: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM folders WHERE path = ?').bind(path).run();
}

export async function deleteFoldersByPrefix(
  env: Env,
  pathPrefix: string,
): Promise<number> {
  const result = await env.VAULT_DB
    .prepare('DELETE FROM folders WHERE path = ? OR path LIKE ?')
    .bind(pathPrefix, pathPrefix + '/%')
    .run();
  return result.meta.changes;
}

export async function listFoldersByPrefix(
  env: Env,
  pathPrefix: string,
): Promise<FolderRecord[]> {
  const { results } = await env.VAULT_DB
    .prepare(
      'SELECT * FROM folders WHERE path = ? OR path LIKE ? ORDER BY path',
    )
    .bind(pathPrefix, pathPrefix + '/%')
    .all<FolderRow>();
  return (results || []).map(rowToRecord);
}

export async function listAllFolders(env: Env): Promise<FolderRecord[]> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT * FROM folders ORDER BY path')
    .all<FolderRow>();
  return (results || []).map(rowToRecord);
}

export async function renameFolderRecord(
  env: Env,
  oldPath: string,
  newPath: string,
  newName?: string,
): Promise<void> {
  const finalName = newName ?? newPath;
  await env.VAULT_DB
    .prepare('UPDATE folders SET path = ?, name = ? WHERE path = ?')
    .bind(newPath, finalName, oldPath)
    .run();
}
