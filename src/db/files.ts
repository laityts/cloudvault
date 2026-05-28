import type { Env, FileMeta } from '../utils/types';

interface FileRow {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploaded_at: string;
  share_token: string | null;
  share_password: string | null;
  share_expires_at: string | null;
  downloads: number;
}

function rowToMeta(row: FileRow): FileMeta {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    size: row.size,
    type: row.type,
    folder: row.folder,
    uploadedAt: row.uploaded_at,
    shareToken: row.share_token,
    sharePassword: row.share_password,
    shareExpiresAt: row.share_expires_at,
    downloads: row.downloads,
  };
}

export async function getFile(env: Env, id: string): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(id)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function getFileByShareToken(
  env: Env,
  token: string,
): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE share_token = ?')
    .bind(token)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function findFileByFolderAndName(
  env: Env,
  folder: string,
  name: string,
): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE folder = ? AND name = ?')
    .bind(folder, name)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

export async function putFile(env: Env, meta: FileMeta): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO files (id, key, name, size, type, folder, uploaded_at,
                          share_token, share_password, share_expires_at, downloads)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         key = excluded.key,
         name = excluded.name,
         size = excluded.size,
         type = excluded.type,
         folder = excluded.folder,
         uploaded_at = excluded.uploaded_at,
         share_token = excluded.share_token,
         share_password = excluded.share_password,
         share_expires_at = excluded.share_expires_at,
         downloads = excluded.downloads`,
    )
    .bind(
      meta.id, meta.key, meta.name, meta.size, meta.type, meta.folder,
      meta.uploadedAt, meta.shareToken, meta.sharePassword,
      meta.shareExpiresAt, meta.downloads,
    )
    .run();
}

export async function deleteFile(env: Env, id: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
}

export async function listFilesInFolder(
  env: Env,
  folder: string,
): Promise<FileMeta[]> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE folder = ? ORDER BY uploaded_at DESC')
    .bind(folder)
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function listFilesByFolderPrefix(
  env: Env,
  folderPrefix: string,
): Promise<FileMeta[]> {
  const { results } = await env.VAULT_DB
    .prepare(
      `SELECT * FROM files
       WHERE folder = ? OR folder LIKE ?
       ORDER BY uploaded_at DESC`,
    )
    .bind(folderPrefix, folderPrefix + '/%')
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function searchFiles(
  env: Env,
  searchTerm: string,
): Promise<FileMeta[]> {
  const pattern = '%' + searchTerm.toLowerCase() + '%';
  const { results } = await env.VAULT_DB
    .prepare(
      `SELECT * FROM files
       WHERE LOWER(name) LIKE ?
       ORDER BY uploaded_at DESC`,
    )
    .bind(pattern)
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function listSharedFiles(env: Env): Promise<FileMeta[]> {
  const { results } = await env.VAULT_DB
    .prepare(
      'SELECT * FROM files WHERE share_token IS NOT NULL ORDER BY uploaded_at DESC',
    )
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function listAllFiles(env: Env): Promise<FileMeta[]> {
  const { results } = await env.VAULT_DB
    .prepare('SELECT * FROM files ORDER BY uploaded_at DESC')
    .all<FileRow>();
  return (results || []).map(rowToMeta);
}

export async function incrementDownloads(env: Env, id: string): Promise<void> {
  await env.VAULT_DB
    .prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?')
    .bind(id)
    .run();
}
