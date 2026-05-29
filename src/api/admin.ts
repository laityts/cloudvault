import type { Env } from '../utils/types';
import { json, error } from '../utils/response';

export async function resetAll(_request: Request, env: Env): Promise<Response> {
  let deletedFiles = 0;
  let cursor: string | undefined;

  try {
    do {
      const listed = await env.VAULT_BUCKET.list({ cursor, limit: 1000 });
      if (listed.objects.length > 0) {
        await env.VAULT_BUCKET.delete(listed.objects.map((o) => o.key));
        deletedFiles += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    await env.VAULT_DB.batch([
      env.VAULT_DB.prepare('DELETE FROM files'),
      env.VAULT_DB.prepare('DELETE FROM folders'),
      env.VAULT_DB.prepare('DELETE FROM folder_shares'),
      env.VAULT_DB.prepare('DELETE FROM folder_share_excludes'),
      env.VAULT_DB.prepare('DELETE FROM folder_share_links'),
    ]);

    return json({ success: true, deletedFiles });
  } catch (e) {
    return error(
      e instanceof Error ? e.message : 'Reset failed',
      500,
    );
  }
}
