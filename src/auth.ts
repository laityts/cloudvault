import type { Env } from './utils/types';
import { error, redirect } from './utils/response';
import { parsePassword } from './utils/validate';
import {
  getSession,
  putSession,
  deleteSession,
  purgeExpiredSessions,
  shouldOpportunisticPurge,
} from './db/sessions';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(input: string, storedHash: string): Promise<boolean> {
  const inputHash = await hashPassword(input);
  const encoder = new TextEncoder();
  const a = encoder.encode(inputHash);
  const b = encoder.encode(storedHash);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function createSession(env: Env): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  await putSession(env, {
    id: sessionId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  const cookie = `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`;
  return { sessionId, cookie };
}

export async function validateSession(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<boolean> {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return false;

  const sessionId = match[1]!;
  const session = await getSession(env, sessionId);
  if (!session) return false;

  if (new Date(session.expiresAt) < new Date()) {
    await deleteSession(env, sessionId);
    return false;
  }

  if (ctx && shouldOpportunisticPurge()) {
    ctx.waitUntil(purgeExpiredSessions(env));
  }

  return true;
}

function getSessionId(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  return match ? match[1]! : null;
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return error('Method not allowed', 405);

  const password = await parsePassword(request);
  if (!password) return error('Password required', 400);

  const storedHash = await hashPassword(env.ADMIN_PASSWORD);
  const valid = await verifyPassword(password, storedHash);

  if (!valid) return error('Invalid password', 401);

  const { cookie } = await createSession(env);

  return new Response(JSON.stringify({ message: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
      'Location': '/admin',
    },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sessionId = getSessionId(request);
  if (sessionId) {
    await deleteSession(env, sessionId);
  }
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

const PUBLIC_PREFIXES = ['/s/', '/auth/', '/login'];

export async function authMiddleware(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  for (const prefix of PUBLIC_PREFIXES) {
    if (url.pathname.startsWith(prefix)) return null;
  }
  if (url.pathname === '/login') return null;

  const valid = await validateSession(request, env, ctx);
  if (!valid) return redirect('/login');
  return null;
}

const WEBDAV_REALM = 'CloudVault WebDAV';

function unauthorizedDav(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${WEBDAV_REALM}"` },
  });
}

/**
 * Basic-Auth gate for the /dav endpoint. Returns a 401 Response when the
 * header is missing or password mismatches; returns null when authenticated.
 * OPTIONS preflight from WebDAV clients is allowed through unauthenticated
 * (matches the prior inline behavior in index.ts).
 */
export async function webdavBasicAuth(request: Request, env: Env): Promise<Response | null> {
  if (request.method === 'OPTIONS') return null;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return unauthorizedDav();
  }
  const decoded = atob(authHeader.slice(6));
  const colonIdx = decoded.indexOf(':');
  const inputPassword = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;

  const encoder = new TextEncoder();
  const inputHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(inputPassword))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const storedHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_PASSWORD))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const a = encoder.encode(inputHash);
  const b = encoder.encode(storedHash);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return unauthorizedDav();
  }
  return null;
}
