import type { Env } from '../utils/types';
import { fetchAssetHtml, injectBranding, redirect, html } from '../utils/response';
import { getSettings } from '../api/settings';
import { validateSession } from '../auth';

async function renderPage(
  request: Request,
  env: Env,
  assetPath: string,
  status = 200,
): Promise<Response> {
  const settings = await getSettings(env);
  let body = await fetchAssetHtml(env.ASSETS, request.url, assetPath);
  body = injectBranding(body, { siteName: settings.siteName, siteIconUrl: settings.siteIconUrl });
  return html(body, status);
}

export async function handleRootPage(request: Request, env: Env): Promise<Response> {
  const settings = await getSettings(env);
  if (!settings.guestPageEnabled) {
    const isAuth = await validateSession(request, env);
    if (isAuth) return redirect('/admin');
    return redirect('/login');
  }
  return renderPage(request, env, '/guest.html');
}

export async function handleLoginPage(request: Request, env: Env): Promise<Response> {
  return renderPage(request, env, '/login.html');
}

export async function handleAdminPage(request: Request, env: Env): Promise<Response> {
  return renderPage(request, env, '/dashboard.html');
}

export async function serve404Page(request: Request, env: Env): Promise<Response> {
  return renderPage(request, env, '/404.html', 404);
}
