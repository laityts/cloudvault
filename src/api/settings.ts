import { Env, SiteSettings, DEFAULT_SETTINGS } from '../utils/types';
import { json, error } from '../utils/response';

const SETTINGS_KEY = 'site';

export async function getSettings(env: Env): Promise<SiteSettings> {
  const row = await env.DB.prepare(
    `SELECT value FROM settings WHERE key = ?`
  ).bind(SETTINGS_KEY).first<{ value: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  return json(await getSettings(env));
}

export async function handlePutSettings(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Partial<SiteSettings>>();
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

  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(SETTINGS_KEY, JSON.stringify(current)).run();

  return json(current);
}