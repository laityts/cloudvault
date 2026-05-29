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
  sha1: string | null;
  sha256: string | null;
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
    sha1: row.sha1 ?? null,
    sha256: row.sha256 ?? null,
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
                          share_token, share_password, share_expires_at, downloads,
                          sha1, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         downloads = excluded.downloads,
         sha1 = excluded.sha1,
         sha256 = excluded.sha256`,
    )
    .bind(
      meta.id, meta.key, meta.name, meta.size, meta.type, meta.folder,
      meta.uploadedAt, meta.shareToken, meta.sharePassword,
      meta.shareExpiresAt, meta.downloads,
      meta.sha1, meta.sha256,
    )
    .run();
}

/** 单独更新文件的 sha1 / sha256 — 用于 /info 端点流式计算后的回写。 */
export async function updateFileHashes(
  env: Env,
  id: string,
  sha1: string,
  sha256: string,
): Promise<void> {
  await env.VAULT_DB
    .prepare('UPDATE files SET sha1 = ?, sha256 = ? WHERE id = ?')
    .bind(sha1, sha256, id)
    .run();
}

export async function deleteFile(env: Env, id: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
}

export async function listFilesInFolder(
  env: Env,
  folder: string,
  limit?: number,
): Promise<FileMeta[]> {
  const query = limit
    ? 'SELECT * FROM files WHERE folder = ? ORDER BY uploaded_at DESC LIMIT ?'
    : 'SELECT * FROM files WHERE folder = ? ORDER BY uploaded_at DESC';

  const stmt = env.VAULT_DB.prepare(query);
  const { results } = limit
    ? await stmt.bind(folder, limit).all<FileRow>()
    : await stmt.bind(folder).all<FileRow>();

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
  folder?: string | null,
  limit?: number,
): Promise<FileMeta[]> {
  const pattern = '%' + searchTerm.toLowerCase() + '%';
  // folder 与 limit 都下推到 SQL，避免「先按 limit 截断、再在内存按 folder 过滤」造成结果偏少。
  const conditions = ['LOWER(name) LIKE ?'];
  const binds: (string | number)[] = [pattern];
  if (folder) {
    conditions.push('folder = ?');
    binds.push(folder);
  }
  let query = `SELECT * FROM files WHERE ${conditions.join(' AND ')} ORDER BY uploaded_at DESC`;
  if (limit) {
    query += ' LIMIT ?';
    binds.push(limit);
  }

  const { results } = await env.VAULT_DB.prepare(query).bind(...binds).all<FileRow>();
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

/** 按 SHA-256 查找文件（用于内容去重）。 */
export async function findFileBySha256(env: Env, sha256: string): Promise<FileMeta | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM files WHERE sha256 = ? LIMIT 1')
    .bind(sha256)
    .first<FileRow>();
  return row ? rowToMeta(row) : null;
}

/** 列出所有 SHA-256 重复的文件，按 sha256 分组、组内按 uploaded_at 升序。 */
export async function listDuplicatesBySha256(env: Env): Promise<Array<{ sha256: string; files: FileMeta[] }>> {
  const { results } = await env.VAULT_DB
    .prepare(
      `SELECT * FROM files
       WHERE sha256 IS NOT NULL
         AND sha256 IN (
           SELECT sha256 FROM files
           WHERE sha256 IS NOT NULL
           GROUP BY sha256
           HAVING COUNT(*) > 1
         )
       ORDER BY sha256, uploaded_at`,
    )
    .all<FileRow>();

  const groups = new Map<string, FileMeta[]>();
  for (const row of results ?? []) {
    const meta = rowToMeta(row);
    if (!meta.sha256) continue;
    let arr = groups.get(meta.sha256);
    if (!arr) {
      arr = [];
      groups.set(meta.sha256, arr);
    }
    arr.push(meta);
  }
  return Array.from(groups, ([sha256, files]) => ({ sha256, files }));
}
