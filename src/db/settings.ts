import type { Env, SiteSettings } from '../utils/types';
import { DEFAULT_SETTINGS } from '../utils/types';

const SITE_KEY = 'site';

export async function getSiteSettings(env: Env): Promise<SiteSettings> {
  const row = await env.VAULT_DB
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(SITE_KEY)
    .first<{ value: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function putSiteSettings(
  env: Env,
  settings: SiteSettings,
): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(SITE_KEY, JSON.stringify(settings))
    .run();
}
