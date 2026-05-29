import type { Env } from '../utils/types';
import { json, error } from '../utils/response';
import { parseJson } from '../utils/validate';
import { buildR2Key } from '../utils/keys';
import { getSharedFolders, getExcludedFolders, isFolderShared } from './share';
import {
  putFile,
  deleteFile,
  listFilesByFolderPrefix,
  listAllFiles,
} from '../db/files';
import {
  getFolder,
  putFolder,
  deleteFolder as dbDeleteFolder,
  deleteFoldersByPrefix,
  listAllFolders,
  listFoldersByPrefix,
  renameFolderRecord,
} from '../db/folders';
import {
  isFolderShareMarked,
  addFolderShare,
  removeFolderShare,
  isFolderExcluded,
  addFolderExclude,
  removeFolderExclude,
  deleteFolderShareLinkByFolder,
  deleteFolderShareLinksByFolderPrefix,
} from '../db/shares';

export async function createFolder(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ name: string; parent: string }>(request);
  if (!body.name?.trim()) return error('Folder name required', 400);

  const folderName = body.parent === 'root' ? body.name.trim() : body.parent + '/' + body.name.trim();
  await putFolder(env, folderName, folderName);

  return json({ folder: folderName }, 201);
}

export async function deleteFolder(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ folder: string }>(request);
  if (!body.folder?.trim()) return error('Folder name required', 400);
  const folder = body.folder.trim();

  // Folder-level cleanup (independent operations) + files listing all run in parallel.
  const [deletedSubfolders, , , , , filesToDelete] = await Promise.all([
    deleteFoldersByPrefix(env, folder + '/'),
    dbDeleteFolder(env, folder),
    removeFolderShare(env, folder),
    removeFolderExclude(env, folder),
    deleteFolderShareLinkByFolder(env, folder),
    listFilesByFolderPrefix(env, folder),
    deleteFolderShareLinksByFolderPrefix(env, folder + '/'),
  ]);

  const targets = filesToDelete.filter(
    (f) => f.folder === folder || f.folder.startsWith(folder + '/'),
  );
  await Promise.all(
    targets.map((file) =>
      Promise.all([
        env.VAULT_BUCKET.delete(file.key),
        deleteFile(env, file.id),
      ]),
    ),
  );

  return json({ deleted: folder, deletedFiles: targets.length, deletedSubfolders });
}

export async function renameFolder(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ oldName: string; newName: string }>(request);
  if (!body.oldName?.trim() || !body.newName?.trim()) return error('Both old and new names required', 400);
  const oldName = body.oldName.trim();
  const newName = body.newName.trim();
  if (oldName === newName) return json({ folder: newName });

  // Up-front parallel reads.
  const [existing, subFolders, isShared, isExcluded, allMovingFiles] = await Promise.all([
    getFolder(env, oldName),
    listFoldersByPrefix(env, oldName + '/'),
    isFolderShareMarked(env, oldName),
    isFolderExcluded(env, oldName),
    listFilesByFolderPrefix(env, oldName),
  ]);

  // Top-level folder rename (or create-if-missing).
  const topRename = existing
    ? renameFolderRecord(env, oldName, newName, newName)
    : putFolder(env, newName, newName);

  // Subfolder renames are mutually independent.
  const subRenames = subFolders
    .filter((sf) => sf.path !== oldName)
    .map((sf) => {
      const newPath = newName + sf.path.slice(oldName.length);
      return renameFolderRecord(env, sf.path, newPath, newPath);
    });

  const shareTransfers: Promise<unknown>[] = [];
  if (isShared) {
    shareTransfers.push(removeFolderShare(env, oldName), addFolderShare(env, newName));
  }
  if (isExcluded) {
    shareTransfers.push(removeFolderExclude(env, oldName), addFolderExclude(env, newName));
  }

  await Promise.all([topRename, ...subRenames, ...shareTransfers]);

  // File moves: each file is independent.
  const moves = allMovingFiles
    .filter((f) => f.folder === oldName || f.folder.startsWith(oldName + '/'))
    .map(async (file) => {
      const newFolder = newName + file.folder.slice(oldName.length);
      const newKey = buildR2Key(newFolder, file.name);
      const obj = await env.VAULT_BUCKET.get(file.key);
      if (obj) {
        await env.VAULT_BUCKET.put(newKey, obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: obj.customMetadata,
        });
        await env.VAULT_BUCKET.delete(file.key);
      }
      file.key = newKey;
      file.folder = newFolder;
      await putFile(env, file);
    });
  await Promise.all(moves);

  return json({ folder: newName });
}

export async function listFolders(_request: Request, env: Env): Promise<Response> {
  const folderSet = new Set<string>();

  const [folderRecords, sharedFolders, excludedFolders] = await Promise.all([
    listAllFolders(env),
    getSharedFolders(env),
    getExcludedFolders(env),
  ]);

  // 使用 SQL 聚合查询直接计算文件数统计，避免加载所有文件
  const fileCountQuery = await env.VAULT_DB
    .prepare('SELECT folder, COUNT(*) as count FROM files GROUP BY folder')
    .all<{ folder: string; count: number }>();

  const fileCountMap = new Map<string, number>();
  for (const row of fileCountQuery.results || []) {
    fileCountMap.set(row.folder, row.count);
  }

  for (const fr of folderRecords) {
    if (fr.path) folderSet.add(fr.path);
  }

  // 从文件记录中提取文件夹路径（用于发现未在 folders 表中的文件夹）
  const foldersFromFiles = await env.VAULT_DB
    .prepare('SELECT DISTINCT folder FROM files WHERE folder != ?')
    .bind('root')
    .all<{ folder: string }>();

  for (const row of foldersFromFiles.results || []) {
    if (row.folder) folderSet.add(row.folder);
  }

  for (const folder of [...folderSet]) {
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      path = path ? path + '/' + part : part;
      folderSet.add(path);
    }
  }

  // 统计每个文件夹的直接子文件夹数
  const subfolderCountMap = new Map<string, number>();
  for (const folderPath of folderSet) {
    const parentPath = folderPath.includes('/')
      ? folderPath.substring(0, folderPath.lastIndexOf('/'))
      : 'root';
    subfolderCountMap.set(parentPath, (subfolderCountMap.get(parentPath) || 0) + 1);
  }

  const folderList = Array.from(folderSet).sort().map((name) => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
    subfolderCount: subfolderCountMap.get(name) || 0,
    fileCount: fileCountMap.get(name) || 0,
  }));

  return json({ folders: folderList });
}
