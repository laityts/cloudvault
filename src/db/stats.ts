import type { Env, FileMeta, StatsResponse } from '../utils/types';

interface FileRow {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploaded_at: string;
  share_token: string | null;
  share_password: string | null;
  share_expires_at: string | null;
  downloads: number;
}

function rowToMeta(row: FileRow): FileMeta {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    size: row.size,
    type: row.type,
    folder: row.folder,
    uploadedAt: row.uploaded_at,
    shareToken: row.share_token,
    sharePassword: row.share_password,
    shareExpiresAt: row.share_expires_at,
    downloads: row.downloads,
  };
}

export async function computeStats(env: Env): Promise<StatsResponse> {
  const [totalsResult, recentResult, topResult] = await env.VAULT_DB.batch([
    env.VAULT_DB.prepare(
      `SELECT COUNT(*) AS totalFiles,
              COALESCE(SUM(size), 0) AS totalSize,
              COALESCE(SUM(downloads), 0) AS totalDownloads
       FROM files`,
    ),
    env.VAULT_DB.prepare(
      'SELECT * FROM files ORDER BY uploaded_at DESC LIMIT 5',
    ),
    env.VAULT_DB.prepare(
      'SELECT * FROM files WHERE downloads > 0 ORDER BY downloads DESC LIMIT 5',
    ),
  ]) as [D1Result, D1Result, D1Result];

  const totals = (totalsResult.results?.[0] ?? {
    totalFiles: 0,
    totalSize: 0,
    totalDownloads: 0,
  }) as { totalFiles: number; totalSize: number; totalDownloads: number };

  const recentRows = (recentResult.results || []) as unknown as FileRow[];
  const topRows = (topResult.results || []) as unknown as FileRow[];

  return {
    totalFiles: totals.totalFiles,
    totalSize: totals.totalSize,
    totalDownloads: totals.totalDownloads,
    recentUploads: recentRows.map(rowToMeta),
    topDownloaded: topRows.map(rowToMeta),
  };
}
