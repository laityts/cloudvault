import { Env } from '../utils/types';
import { json } from '../utils/response';

export async function listFileShares(request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, name, type, folder, share_token as shareToken, share_password as sharePassword, share_expires_at as shareExpiresAt, downloads
     FROM files
     WHERE share_token IS NOT NULL
     ORDER BY share_expires_at ASC, name ASC`
  ).all();

  const shares = rows.results.map(row => ({
    id: row.id,
    name: row.name,
    type: row.type,
    folder: row.folder,
    shareToken: row.shareToken,
    hasPassword: !!row.sharePassword,
    expiresAt: row.shareExpiresAt,
    downloads: row.downloads,
  }));

  return json(shares);
}

export async function listFolderShares(request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT token, folder, password_hash as passwordHash, expires_at as expiresAt, created_at as createdAt
     FROM folder_share_links
     ORDER BY expires_at ASC, folder ASC`
  ).all();

  const shares = rows.results.map(row => ({
    token: row.token,
    folder: row.folder,
    hasPassword: !!row.passwordHash,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));

  return json(shares);
}
