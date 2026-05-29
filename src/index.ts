import type { Env } from './utils/types';
import { error, corsPreflightResponse } from './utils/response';
import { createRouter } from './router';
import { handleLogin, handleLogout, authMiddleware, validateSession, webdavBasicAuth } from './auth';
import * as files from './api/files';
import * as folders from './api/folders';
import * as media from './api/media';
import * as share from './api/share';
import * as pub from './api/public';
import * as stats from './api/stats';
import * as settings from './api/settings';
import * as admin from './api/admin';
import * as download from './handlers/download';
import { handleRootPage, handleLoginPage, handleAdminPage, serve404Page } from './handlers/pages';
import { handleWebDav } from './handlers/webdav';
import { serveWithEdgeCache, isStaticAsset } from './utils/cache';

const router = createRouter([
  // ── Auth ──────────────────────────────────────────────────────────
  { method: 'POST', pattern: '/auth/login', handler: handleLogin },
  { method: '*', pattern: '/auth/logout', handler: handleLogout },

  // ── Public pages ──────────────────────────────────────────────────
  { method: 'GET', pattern: '/', handler: handleRootPage },
  { method: 'GET', pattern: '/login', handler: handleLoginPage },

  // ── Public API (no auth) ──────────────────────────────────────────
  { method: 'GET', pattern: '/api/public/shared', handler: pub.listPublicShared },
  { method: 'GET', pattern: '/api/public/folder', handler: pub.browsePublicFolder },
  {
    method: 'GET',
    pattern: '/api/public/download/*',
    handler: async (req, env, ctx) =>
      (await serveWithEdgeCache(req, ctx, () => pub.publicDownload(req, env)))!,
  },

  // ── Share routes (token-based, no session) ────────────────────────
  { method: 'GET', pattern: '/s/:token', handler: pub.handleSharePage },
  { method: 'GET', pattern: '/s/:token/download', handler: pub.handleShareDownload },
  { method: 'GET', pattern: '/s/:token/preview', handler: pub.handlePreview },
  { method: 'GET', pattern: '/s/:token/folder-download', handler: pub.handleFolderShareDownload },
  { method: 'GET', pattern: '/s/:token/folder-preview', handler: pub.handleFolderSharePreview },
  { method: 'POST', pattern: '/s/:token/verify', handler: pub.handleSharePassword },

  // ── Admin page (session auth) ─────────────────────────────────────
  { method: 'GET', pattern: '/admin', middleware: [authMiddleware], handler: handleAdminPage },

  // ── Files API (session auth) ──────────────────────────────────────
  { method: 'GET', pattern: '/api/files', middleware: [authMiddleware], handler: files.list },
  { method: 'POST', pattern: '/api/files/upload', middleware: [authMiddleware], handler: files.upload },
  { method: 'PUT', pattern: '/api/files/upload', middleware: [authMiddleware], handler: files.upload },
  { method: 'POST', pattern: '/api/files/delete', middleware: [authMiddleware], handler: files.deleteFiles },
  { method: 'POST', pattern: '/api/files/move', middleware: [authMiddleware], handler: files.moveFiles },
  { method: 'POST', pattern: '/api/files/zip', middleware: [authMiddleware], handler: media.zipDownload },
  { method: 'POST', pattern: '/api/files/precheck', middleware: [authMiddleware], handler: files.precheck },
  { method: 'GET', pattern: '/api/files/duplicates', middleware: [authMiddleware], handler: files.listDuplicates },

  { method: 'GET', pattern: '/api/files/:id/thumbnail', middleware: [authMiddleware], handler: media.thumbnail },
  { method: 'GET', pattern: '/api/files/:id/preview', middleware: [authMiddleware], handler: media.preview },
  { method: 'GET', pattern: '/api/files/:id/download', middleware: [authMiddleware], handler: files.download },
  { method: 'GET', pattern: '/api/files/:id/info', middleware: [authMiddleware], handler: files.info },

  { method: 'GET', pattern: '/api/files/:id', middleware: [authMiddleware], handler: files.get },
  { method: 'PUT', pattern: '/api/files/:id', middleware: [authMiddleware], handler: files.rename },
  { method: 'DELETE', pattern: '/api/files/:id', middleware: [authMiddleware], handler: files.deleteFiles },

  // ── Folders API (session auth) ────────────────────────────────────
  { method: 'GET', pattern: '/api/folders', middleware: [authMiddleware], handler: folders.listFolders },
  { method: 'POST', pattern: '/api/folders', middleware: [authMiddleware], handler: folders.createFolder },
  { method: 'PUT', pattern: '/api/folders', middleware: [authMiddleware], handler: folders.renameFolder },
  { method: 'DELETE', pattern: '/api/folders', middleware: [authMiddleware], handler: folders.deleteFolder },
  { method: 'POST', pattern: '/api/folders/exclude', middleware: [authMiddleware], handler: share.toggleFolderExclude },
  { method: 'POST', pattern: '/api/folders/share', middleware: [authMiddleware], handler: share.shareFolderToggle },
  { method: 'GET', pattern: '/api/folders/shared', middleware: [authMiddleware], handler: share.listSharedFolders },

  // ── Share API (session auth) ──────────────────────────────────────
  { method: 'GET', pattern: '/api/shares', middleware: [authMiddleware], handler: share.listShares },
  { method: 'POST', pattern: '/api/share', middleware: [authMiddleware], handler: share.createShare },
  { method: 'GET', pattern: '/api/share/:token', middleware: [authMiddleware], handler: share.getShareInfo },
  { method: 'DELETE', pattern: '/api/share/:token', middleware: [authMiddleware], handler: share.revokeShare },

  // ── Folder share link (folder path may contain '/', use wildcard) ─
  { method: 'POST', pattern: '/api/folder-share-link', middleware: [authMiddleware], handler: share.createFolderShareLink },
  { method: 'GET', pattern: '/api/folder-share-link/*', middleware: [authMiddleware], handler: share.getFolderShareLinkInfo },
  { method: 'DELETE', pattern: '/api/folder-share-link/*', middleware: [authMiddleware], handler: share.revokeFolderShareLink },

  // ── Stats / Settings ──────────────────────────────────────────────
  { method: 'GET', pattern: '/api/stats', middleware: [authMiddleware], handler: stats.getStats },
  { method: 'GET', pattern: '/api/settings', middleware: [authMiddleware], handler: settings.handleGetSettings },
  { method: 'PUT', pattern: '/api/settings', middleware: [authMiddleware], handler: settings.handlePutSettings },

  // ── Admin (session auth, destructive) ─────────────────────────────
  { method: 'POST', pattern: '/api/admin/reset-all', middleware: [authMiddleware], handler: admin.resetAll },

  // ── WebDAV (basic auth; OPTIONS bypass handled inside webdavBasicAuth) ─
  { method: '*', pattern: '/dav', middleware: [webdavBasicAuth], handler: handleWebDav },
  { method: '*', pattern: '/dav/*', middleware: [webdavBasicAuth], handler: handleWebDav },
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS' && !path.startsWith('/dav')) {
      return corsPreflightResponse();
    }

    try {
      const routed = await router(request, env, ctx);
      if (routed) return routed;

      if ((method === 'GET' || method === 'HEAD') && isStaticAsset(path)) {
        return env.ASSETS.fetch(request);
      }

      if (method === 'GET' || method === 'HEAD') {
        const cleanResponse = await serveWithEdgeCache(request, ctx, () =>
          download.handleCleanDownload(request, env),
        );
        if (cleanResponse) return cleanResponse;
      }

      const isAuth = await validateSession(request, env, ctx);
      if (isAuth) return env.ASSETS.fetch(request);

      return await serve404Page(request, env);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Internal server error';
      console.error('Unhandled error:', message);
      return error(message, 500);
    }
  },
} satisfies ExportedHandler<Env>;
