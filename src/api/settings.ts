import type { Env, SiteSettings } from '../utils/types';
import { json } from '../utils/response';
import { getSiteSettings, putSiteSettings } from '../db/settings';

export async function getSettings(env: Env): Promise<SiteSettings> {
  return getSiteSettings(env);
}

export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  return json(await getSiteSettings(env));
}

export async function handlePutSettings(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Partial<SiteSettings>>();
  const current = await getSiteSettings(env);

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

  await putSiteSettings(env, current);
  return json(current);
}
