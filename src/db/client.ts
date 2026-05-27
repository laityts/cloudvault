import type { Env } from '../utils/types';

export const db = (env: Env): D1Database => env.VAULT_DB;

export async function batch(
  env: Env,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  return env.VAULT_DB.batch(statements);
}
