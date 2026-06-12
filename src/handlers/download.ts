import type { Env } from '../utils/types';
import { getMimeType } from '../utils/response';
import { getSharedFolders, getExcludedFolders, isFolderShared } from '../api/share';
import { findFileByFolderAndName, putFile } from '../db/files';

/**
 * Clean-URL fallback download: serves /<folder>/<file> for files that live in
 * a shared folder, bypassing the normal /api/* surface. Returns null when the
 * path doesn't resolve to a publicly accessible file so the caller can fall
 * through to other handlers (404, etc.).
 */
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

  const [sharedFolders, excludedFolders] = await Promise.all([
    getSharedFolders(env),
    getExcludedFolders(env),
  ]);
  if (!isFolderShared(folder, sharedFolders, excludedFolders)) return null;

  const meta = await findFileByFolderAndName(env, folder, fileName);
  if (!meta) return null;

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return null;

  meta.downloads++;
  await putFile(env, meta);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('Content-Length', String(object.size));
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', getMimeType(meta.name));
  }
  headers.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.name) + '"');

  return new Response(object.body, { headers });
}
