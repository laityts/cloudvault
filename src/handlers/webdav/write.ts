import type { Env } from '../../utils/types';
import { getMimeType } from '../../utils/response';
import { buildR2Key } from '../../utils/keys';
import { createFileMeta } from '../../utils/file-meta';
import {
  putFile,
  deleteFile,
  listFilesByFolderPrefix,
} from '../../db/files';
import {
  getFolder,
  putFolder,
  deleteFolder as dbDeleteFolder,
  deleteFoldersByPrefix,
} from '../../db/folders';
import {
  parseDavPath,
  toFolder,
  toFileName,
  findFileByDavPath,
  ensureFolderChain,
} from './shared';

export async function handlePut(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot PUT to root', { status: 405 });
  if (davPath.includes('..')) return new Response('Invalid path', { status: 400 });

  const folder = toFolder(davPath);
  const fileName = toFileName(davPath);
  const contentType = request.headers.get('Content-Type') || getMimeType(fileName);
  const key = buildR2Key(folder, fileName);

  const existingFile = await findFileByDavPath(env, davPath);

  if (existingFile) {
    await env.VAULT_BUCKET.delete(existingFile.key);
    const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
      httpMetadata: {
        contentType,
        contentDisposition: 'attachment; filename="' + fileName + '"',
      },
      customMetadata: { fileId: existingFile.id },
    });
    if (!r2Object) return new Response('Upload failed', { status: 500 });

    existingFile.key = key;
    existingFile.size = r2Object.size;
    existingFile.type = contentType;
    existingFile.uploadedAt = new Date().toISOString();
    await putFile(env, existingFile);

    return new Response(null, { status: 204 });
  }

  if (folder !== 'root') await ensureFolderChain(env, folder);

  const id = crypto.randomUUID();
  const r2Object = await env.VAULT_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType,
      contentDisposition: 'attachment; filename="' + fileName + '"',
    },
    customMetadata: { fileId: id },
  });
  if (!r2Object) return new Response('Upload failed', { status: 500 });

  const meta = createFileMeta({
    id,
    key,
    name: fileName,
    size: r2Object.size,
    type: contentType,
    folder,
  });
  await putFile(env, meta);

  return new Response(null, { status: 201 });
}

export async function handleDelete(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot DELETE root', { status: 403 });

  const file = await findFileByDavPath(env, davPath);
  if (file) {
    await env.VAULT_BUCKET.delete(file.key);
    await deleteFile(env, file.id);
    return new Response(null, { status: 204 });
  }

  const folderRecord = await getFolder(env, davPath);
  const filesUnder = await listFilesByFolderPrefix(env, davPath);
  const isFolder = !!folderRecord || filesUnder.some((f) => f.folder === davPath || f.folder.startsWith(davPath + '/'));

  if (!isFolder) return new Response('Not Found', { status: 404 });

  await dbDeleteFolder(env, davPath);
  await deleteFoldersByPrefix(env, davPath + '/');

  for (const f of filesUnder) {
    if (f.folder === davPath || f.folder.startsWith(davPath + '/')) {
      await env.VAULT_BUCKET.delete(f.key);
      await deleteFile(env, f.id);
    }
  }

  return new Response(null, { status: 204 });
}

export async function handleMkcol(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot MKCOL root', { status: 405 });

  const body = await request.text();
  if (body) return new Response('Unsupported Media Type', { status: 415 });

  const existingFile = await findFileByDavPath(env, davPath);
  if (existingFile) return new Response('Conflict', { status: 409 });

  const existingFolder = await getFolder(env, davPath);
  if (existingFolder) return new Response('Method Not Allowed', { status: 405 });

  const parentPath = davPath.includes('/') ? davPath.substring(0, davPath.lastIndexOf('/')) : '';
  if (parentPath) {
    const parentFolder = await getFolder(env, parentPath);
    if (!parentFolder) {
      const filesUnderParent = await listFilesByFolderPrefix(env, parentPath);
      const parentExists = filesUnderParent.some((f) => f.folder === parentPath || f.folder.startsWith(parentPath + '/'));
      if (!parentExists) return new Response('Conflict', { status: 409 });
    }
  }

  await putFolder(env, davPath, davPath);
  return new Response('Created', { status: 201 });
}
