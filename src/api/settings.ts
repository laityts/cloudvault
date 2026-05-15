import { Env, SiteSettings, DEFAULT_SETTINGS, ResetAllDataResponse } from '../utils/types';
import { json, error } from '../utils/response';

const SETTINGS_KEY = 'site';
const EXTENSION_SPLIT_RE = /[\s,，;；、]+/;
const EXTENSION_RE = /^\.[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeAllowedUploadExtensions(value: unknown): string {
  const rawTokens = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(EXTENSION_SPLIT_RE) : []);
  const extensions: string[] = [];
  const seen = new Set<string>();

  for (const token of rawTokens) {
    if (typeof token !== 'string') continue;
    const raw = token.trim().toLowerCase();
    if (!raw) continue;
    const ext = raw.startsWith('.') ? raw : '.' + raw;
    if (!EXTENSION_RE.test(ext) || ext.endsWith('.')) continue;
    if (seen.has(ext)) continue;
    seen.add(ext);
    extensions.push(ext);
    if (extensions.length >= 100) break;
  }

  return extensions.join(', ');
}

export function getAllowedUploadExtensionList(settings: Pick<SiteSettings, 'allowedUploadExtensions'>): string[] {
  const normalized = normalizeAllowedUploadExtensions(settings.allowedUploadExtensions);
  return normalized ? normalized.split(', ') : [];
}

async function readSettingsBody(request: Request): Promise<Partial<SiteSettings> | null> {
  try {
    // 防止 `null`、数组或坏 JSON 直接把设置接口打成 500。
    const body = await request.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Partial<SiteSettings>;
  } catch {
    return null;
  }
}

export async function getSettings(env: Env): Promise<SiteSettings> {
  const row = await env.DB.prepare(
    `SELECT value FROM settings WHERE key = ?`
  ).bind(SETTINGS_KEY).first<{ value: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value);
    const settings = { ...DEFAULT_SETTINGS, ...parsed };
    settings.allowedUploadExtensions = normalizeAllowedUploadExtensions(settings.allowedUploadExtensions);
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  return json(await getSettings(env));
}

export async function handlePutSettings(request: Request, env: Env): Promise<Response> {
  const body = await readSettingsBody(request);
  if (!body) return error('Invalid settings payload', 400);
  const current = await getSettings(env);

  if (typeof body.guestPageEnabled === 'boolean') {
    current.guestPageEnabled = body.guestPageEnabled;
  }
  if (typeof body.showLoginButton === 'boolean') {
    current.showLoginButton = body.showLoginButton;
  }
  if (typeof body.siteName === 'string') {
    current.siteName = body.siteName.trim().slice(0, 50) || 'CloudVault';
  }
  if (typeof body.siteIconUrl === 'string') {
    current.siteIconUrl = body.siteIconUrl.trim().slice(0, 500);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'allowedUploadExtensions')) {
    current.allowedUploadExtensions = normalizeAllowedUploadExtensions(body.allowedUploadExtensions);
  }

  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(SETTINGS_KEY, JSON.stringify(current)).run();

  return json(current);
}

async function deleteAllBucketObjects(env: Env): Promise<number> {
  let deletedObjects = 0;
  let cursor: string | undefined;

  while (true) {
    // R2 列表默认分页，重置时必须把整桶对象遍历完，否则数据库清空后会遗留孤儿文件。
    const listed = await env.VAULT_BUCKET.list({
      cursor,
      limit: 1000,
    });
    const keys = Array.isArray(listed.objects)
      ? listed.objects
          .map(object => typeof object?.key === 'string' ? object.key : '')
          .filter(Boolean)
      : [];

    if (keys.length > 0) {
      await env.VAULT_BUCKET.delete(keys);
      deletedObjects += keys.length;
    }

    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  return deletedObjects;
}

export async function handleResetAllData(_request: Request, env: Env): Promise<Response> {
  const deletedObjects = await deleteAllBucketObjects(env);
  const resetTables = [
    'files',
    'folders',
    'folder_shares',
    'folder_excludes',
    'folder_share_links',
    'folder_share_meta',
    'sessions',
    'settings',
    'stats',
  ];

  // 只重置业务数据，管理员密码和密钥来自环境变量，不在数据库里。
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM files`),
    env.DB.prepare(`DELETE FROM folders`),
    env.DB.prepare(`DELETE FROM folder_shares`),
    env.DB.prepare(`DELETE FROM folder_excludes`),
    env.DB.prepare(`DELETE FROM folder_share_links`),
    env.DB.prepare(`DELETE FROM folder_share_meta`),
    env.DB.prepare(`DELETE FROM sessions`),
    env.DB.prepare(`DELETE FROM settings`),
    env.DB.prepare(`DELETE FROM stats`),
    env.DB.prepare(`INSERT INTO stats (id, total_files, total_size) VALUES (1, 0, 0)`),
  ]);

  return json<ResetAllDataResponse>({
    deletedObjects,
    resetTables,
  });
}
