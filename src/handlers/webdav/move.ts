import type { Env } from '../../utils/types';
import { buildR2Key } from '../../utils/keys';
import { createFileMeta } from '../../utils/file-meta';
import {
  putFile,
  deleteFile,
} from '../../db/files';
import {
  parseDavPath,
  toFolder,
  toFileName,
  findFileByDavPath,
  ensureFolderChain,
  parseDestination,
} from './shared';

export async function handleMove(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot MOVE root', { status: 403 });

  const destination = parseDestination(request);
  if (!destination) return new Response('Bad Request', { status: 400 });

  const overwrite = request.headers.get('Overwrite') !== 'F';

  const file = await findFileByDavPath(env, davPath);
  if (!file) return new Response('Not Found', { status: 404 });

  const destFile = await findFileByDavPath(env, destination);
  if (destFile && !overwrite) return new Response('Precondition Failed', { status: 412 });

  if (destFile) {
    await env.VAULT_BUCKET.delete(destFile.key);
    await deleteFile(env, destFile.id);
  }

  const newFolder = toFolder(destination);
  const newName = toFileName(destination);
  const newKey = buildR2Key(newFolder, newName);

  if (newFolder !== 'root') await ensureFolderChain(env, newFolder);

  const object = await env.VAULT_BUCKET.get(file.key);
  if (!object) return new Response('Not Found', { status: 404 });

  await env.VAULT_BUCKET.put(newKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
  await env.VAULT_BUCKET.delete(file.key);

  file.key = newKey;
  file.folder = newFolder;
  file.name = newName;
  await putFile(env, file);

  return new Response(null, { status: destFile ? 204 : 201 });
}

export async function handleCopy(request: Request, env: Env): Promise<Response> {
  const davPath = parseDavPath(request);
  if (!davPath) return new Response('Cannot COPY root', { status: 403 });

  const destination = parseDestination(request);
  if (!destination) return new Response('Bad Request', { status: 400 });

  const overwrite = request.headers.get('Overwrite') !== 'F';

  const file = await findFileByDavPath(env, davPath);
  if (!file) return new Response('Not Found', { status: 404 });

  const destFile = await findFileByDavPath(env, destination);
  if (destFile && !overwrite) return new Response('Precondition Failed', { status: 412 });

  if (destFile) {
    await env.VAULT_BUCKET.delete(destFile.key);
    await deleteFile(env, destFile.id);
  }

  const newFolder = toFolder(destination);
  const newName = toFileName(destination);
  const newKey = buildR2Key(newFolder, newName);
  const newId = crypto.randomUUID();

  if (newFolder !== 'root') await ensureFolderChain(env, newFolder);

  const object = await env.VAULT_BUCKET.get(file.key);
  if (!object) return new Response('Not Found', { status: 404 });

  await env.VAULT_BUCKET.put(newKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: { fileId: newId },
  });

  const meta = createFileMeta({
    id: newId,
    key: newKey,
    name: newName,
    size: file.size,
    type: file.type,
    folder: newFolder,
  });
  await putFile(env, meta);

  return new Response(null, { status: destFile ? 204 : 201 });
}
