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

  await dbDeleteFolder(env, folder);
  const deletedSubfolders = await deleteFoldersByPrefix(env, folder + '/');
  await removeFolderShare(env, folder);
  await removeFolderExclude(env, folder);
  await deleteFolderShareLinkByFolder(env, folder);
  await deleteFolderShareLinksByFolderPrefix(env, folder + '/');

  const filesToDelete = await listFilesByFolderPrefix(env, folder);
  let deletedFiles = 0;
  for (const file of filesToDelete) {
    if (file.folder === folder || file.folder.startsWith(folder + '/')) {
      await env.VAULT_BUCKET.delete(file.key);
      await deleteFile(env, file.id);
      deletedFiles++;
    }
  }

  return json({ deleted: folder, deletedFiles, deletedSubfolders });
}

export async function renameFolder(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ oldName: string; newName: string }>(request);
  if (!body.oldName?.trim() || !body.newName?.trim()) return error('Both old and new names required', 400);
  const oldName = body.oldName.trim();
  const newName = body.newName.trim();
  if (oldName === newName) return json({ folder: newName });

  const existing = await getFolder(env, oldName);
  if (existing) {
    await renameFolderRecord(env, oldName, newName, newName);
  } else {
    await putFolder(env, newName, newName);
  }

  const subFolders = await listFoldersByPrefix(env, oldName + '/');
  for (const sf of subFolders) {
    if (sf.path === oldName) continue;
    const newPath = newName + sf.path.slice(oldName.length);
    await renameFolderRecord(env, sf.path, newPath, newPath);
  }

  if (await isFolderShareMarked(env, oldName)) {
    await removeFolderShare(env, oldName);
    await addFolderShare(env, newName);
  }
  if (await isFolderExcluded(env, oldName)) {
    await removeFolderExclude(env, oldName);
    await addFolderExclude(env, newName);
  }

  const allMovingFiles = await listFilesByFolderPrefix(env, oldName);
  for (const file of allMovingFiles) {
    if (file.folder !== oldName && !file.folder.startsWith(oldName + '/')) continue;
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
  }

  return json({ folder: newName });
}

export async function listFolders(_request: Request, env: Env): Promise<Response> {
  const folderSet = new Set<string>();

  const allFiles = await listAllFiles(env);
  for (const file of allFiles) {
    if (file.folder && file.folder !== 'root') {
      folderSet.add(file.folder);
    }
  }

  const folderRecords = await listAllFolders(env);
  for (const fr of folderRecords) {
    if (fr.path) folderSet.add(fr.path);
  }

  for (const folder of [...folderSet]) {
    const parts = folder.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? path + '/' + parts[i] : parts[i];
      folderSet.add(path);
    }
  }

  const sharedFolders = await getSharedFolders(env);
  const excludedFolders = await getExcludedFolders(env);
  const folderList = Array.from(folderSet).sort().map((name) => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
  }));

  return json({ folders: folderList });
}
