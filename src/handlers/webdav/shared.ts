import type { Env, FileMeta } from '../../utils/types';
import {
  findFileByFolderAndName,
  listAllFiles,
} from '../../db/files';
import {
  getFolder,
  putFolder,
  listAllFolders,
} from '../../db/folders';

export const DAV_PREFIX = '/dav/';
export const DAV_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY';

export function parseDavPath(request: Request): string {
  const url = new URL(request.url);
  const raw = decodeURIComponent(url.pathname.slice(DAV_PREFIX.length));
  return raw.replace(/\/+$/, '');
}

export function toFolder(davPath: string): string {
  const idx = davPath.lastIndexOf('/');
  return idx < 0 ? 'root' : davPath.substring(0, idx);
}

export function toFileName(davPath: string): string {
  return davPath.split('/').pop() || davPath;
}

export async function getFoldersMap(env: Env): Promise<Map<string, string>> {
  const records = await listAllFolders(env);
  const map = new Map<string, string>();
  for (const r of records) map.set(r.path, r.createdAt);
  return map;
}

export async function findFileByDavPath(env: Env, davPath: string): Promise<FileMeta | null> {
  const folder = toFolder(davPath);
  const name = toFileName(davPath);
  return findFileByFolderAndName(env, folder, name);
}

export function isDirPath(davPath: string, folders: Map<string, string>, allFiles: FileMeta[]): boolean {
  if (!davPath) return true;
  return folders.has(davPath) || allFiles.some(f => f.folder === davPath || f.folder.startsWith(davPath + '/'));
}

export function collectChildFolders(davPath: string, folders: Map<string, string>, allFiles: FileMeta[]): string[] {
  const childSet = new Set<string>();
  const prefix = davPath ? davPath + '/' : '';

  if (!davPath) {
    for (const [name] of folders) { childSet.add(name.split('/')[0]!); }
    for (const f of allFiles) { if (f.folder !== 'root') childSet.add(f.folder.split('/')[0]!); }
  } else {
    for (const [name] of folders) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) {
        childSet.add(name.slice(prefix.length));
      }
    }
    for (const f of allFiles) {
      if (f.folder.startsWith(prefix) && !f.folder.slice(prefix.length).includes('/')) {
        childSet.add(f.folder.slice(prefix.length));
      }
    }
  }

  return [...childSet].sort();
}

export async function ensureFolderChain(env: Env, folderPath: string): Promise<void> {
  const parts = folderPath.split('/');
  let path = '';
  for (const part of parts) {
    path = path ? path + '/' + part : part;
    const existing = await getFolder(env, path);
    if (!existing) {
      await putFolder(env, path, path);
    }
  }
}

export function parseDestination(request: Request): string | null {
  const dest = request.headers.get('Destination');
  if (!dest) return null;

  try {
    const url = new URL(dest);
    const decoded = decodeURIComponent(url.pathname);
    if (!decoded.startsWith(DAV_PREFIX)) return null;
    return decoded.slice(DAV_PREFIX.length).replace(/\/+$/, '');
  } catch {
    const decoded = decodeURIComponent(dest);
    if (!decoded.startsWith(DAV_PREFIX)) return null;
    return decoded.slice(DAV_PREFIX.length).replace(/\/+$/, '');
  }
}

/** Re-export listAllFiles for handler convenience. */
export { listAllFiles };
