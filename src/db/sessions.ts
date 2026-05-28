import type { Env, Session } from '../utils/types';

interface SessionRow {
  id: string;
  created_at: string;
  expires_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function getSession(
  env: Env,
  id: string,
): Promise<Session | null> {
  const row = await env.VAULT_DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>();
  return row ? rowToSession(row) : null;
}

export async function putSession(env: Env, session: Session): Promise<void> {
  await env.VAULT_DB
    .prepare(
      `INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    )
    .bind(session.id, session.createdAt, session.expiresAt)
    .run();
}

export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.VAULT_DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

// 机会性清理：删除所有已过期会话；调用方应在 ctx.waitUntil 中触发以不阻塞响应
export async function purgeExpiredSessions(env: Env): Promise<void> {
  await env.VAULT_DB
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run();
}

export function shouldOpportunisticPurge(): boolean {
  return Math.random() < 0.01;
}
