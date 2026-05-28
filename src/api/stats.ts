import type { Env } from '../utils/types';
import { json } from '../utils/response';
import { computeStats } from '../db/stats';

export async function getStats(request: Request, env: Env): Promise<Response> {
  return json(await computeStats(env));
}
