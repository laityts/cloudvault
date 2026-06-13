import type { Env, FileMeta } from '../utils/types';
import { json, error } from '../utils/response';
import { parseJson } from '../utils/validate';
import { extractPathParam } from '../utils/keys';
import { streamR2Object } from '../utils/r2';
import { getFile } from '../db/files';

export async function thumbnail(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);
  if (!meta.type.startsWith('image/')) return error('Not an image', 400);

  const res = await streamR2Object(env.VAULT_BUCKET, meta.key, request, {
    // session 认证内容不应进共享缓存;仅允许浏览器私有缓存
    cacheControl: 'private, max-age=14400',
  });
  return res ?? error('File not found in storage', 404);
}

export async function preview(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  const res = await streamR2Object(env.VAULT_BUCKET, meta.key, request, {
    cacheControl: 'private, max-age=3600',
    acceptRanges: true,
    headers: {
      'Content-Type': meta.type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(meta.name)}"`,
    },
  });
  return res ?? error('File not found in storage', 404);
}

