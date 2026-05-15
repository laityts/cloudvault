import { Env } from '../utils/types';
import { json } from '../utils/response';

export async function getStats(_request: Request, env: Env): Promise<Response> {
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) as totalFiles, SUM(size) as totalSize, SUM(downloads) as totalDownloads
     FROM files
     WHERE (upload_status = 'done' OR upload_status IS NULL)`
  ).first<{ totalFiles: number; totalSize: number; totalDownloads: number }>();
  const totalFiles = agg?.totalFiles || 0;
  const totalSize = agg?.totalSize || 0;
  const totalDownloads = agg?.totalDownloads || 0;

  const recentRows = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, share_token as shareToken, share_password as sharePassword, share_expires_at as shareExpiresAt, downloads
     FROM files
     WHERE (upload_status = 'done' OR upload_status IS NULL)
     ORDER BY uploaded_at DESC
     LIMIT 5`
  ).all();
  const recentUploads = recentRows.results.map(r => ({
    id: r.id, key: r.key, name: r.name, size: r.size, type: r.type, folder: r.folder,
    uploadedAt: r.uploadedAt, shareToken: r.shareToken, sharePassword: r.sharePassword,
    shareExpiresAt: r.shareExpiresAt, downloads: r.downloads,
  }));

  const topRows = await env.DB.prepare(
    `SELECT id, key, name, size, type, folder, uploaded_at as uploadedAt, share_token as shareToken, share_password as sharePassword, share_expires_at as shareExpiresAt, downloads
     FROM files
     WHERE downloads > 0
       AND (upload_status = 'done' OR upload_status IS NULL)
     ORDER BY downloads DESC
     LIMIT 5`
  ).all();
  const topDownloaded = topRows.results.map(r => ({
    id: r.id, key: r.key, name: r.name, size: r.size, type: r.type, folder: r.folder,
    uploadedAt: r.uploadedAt, shareToken: r.shareToken, sharePassword: r.sharePassword,
    shareExpiresAt: r.shareExpiresAt, downloads: r.downloads,
  }));

  return json({
    totalFiles,
    totalSize,
    totalDownloads,
    recentUploads,
    topDownloaded,
  });
}
