import { apiFetch } from './client';
import type {
  FileMeta,
  FolderInfo,
  StatsResponse,
  SiteSettings,
  FolderShareLinkInfo,
  SharesResponse,
  PublicSharedResponse,
  PublicFolderResponse,
  MultipartCreateResponse,
  UploadPart,
} from './types';

// ─── Files ───────────────────────────────────────────────────────────────

export interface ListFilesParams {
  folder?: string;
  search?: string;
}

export function listFiles(params: ListFilesParams = {}): Promise<{ files: FileMeta[] }> {
  const usp = new URLSearchParams();
  if (params.folder && params.folder !== 'root') usp.set('folder', params.folder);
  if (params.search) usp.set('search', params.search);
  const q = usp.toString();
  return apiFetch(`/api/files${q ? '?' + q : ''}`);
}

export function deleteFiles(ids: string[]) {
  return apiFetch<{ message?: string }>('/api/files/delete', { method: 'POST', body: { ids } });
}

export function renameFile(id: string, name: string) {
  return apiFetch<{ message?: string }>(`/api/files/${id}`, { method: 'PUT', body: { name } });
}

export function moveFiles(ids: string[], targetFolder: string) {
  return apiFetch<{ moved: number }>('/api/files/move', { method: 'POST', body: { ids, targetFolder } });
}

export async function zipDownload(ids: string[]): Promise<Blob> {
  const res = await fetch('/api/files/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error('Failed to download zip');
  return res.blob();
}

// ─── Folders ─────────────────────────────────────────────────────────────

export function listFolders(): Promise<{ folders: FolderInfo[] }> {
  return apiFetch('/api/folders');
}

export function createFolder(name: string, parent: string) {
  return apiFetch<{ folder: string }>('/api/folders', { method: 'POST', body: { name, parent } });
}

export function renameFolder(oldName: string, newName: string) {
  return apiFetch<{ folder: string }>('/api/folders', { method: 'PUT', body: { oldName, newName } });
}

export function deleteFolder(folder: string) {
  return apiFetch<{ deletedFiles: number; deletedSubfolders: number }>('/api/folders', {
    method: 'DELETE',
    body: { folder },
  });
}

export function toggleFolderShare(folder: string) {
  return apiFetch<{ shared: boolean; folder: string }>('/api/folders/share', { method: 'POST', body: { folder } });
}

export function toggleFolderExclude(folder: string) {
  return apiFetch<{ excluded: boolean; folder: string }>('/api/folders/exclude', {
    method: 'POST',
    body: { folder },
  });
}

// ─── Stats ───────────────────────────────────────────────────────────────

export function getStats(): Promise<StatsResponse> {
  return apiFetch('/api/stats');
}

// ─── Settings ────────────────────────────────────────────────────────────

export function getSettings(): Promise<SiteSettings> {
  return apiFetch('/api/settings');
}

export function saveSettings(settings: SiteSettings) {
  return apiFetch<SiteSettings>('/api/settings', { method: 'PUT', body: settings });
}

// ─── Share (single-file) ─────────────────────────────────────────────────

export interface CreateShareRequest {
  fileId: string;
  password?: string;
  expiresInDays?: number;
}

export function createShare(req: CreateShareRequest) {
  return apiFetch<{ token: string; hasPassword: boolean; expiresAt: string | null }>('/api/share', {
    method: 'POST',
    body: req,
  });
}

export function revokeShare(fileId: string) {
  return apiFetch<{ message: string }>(`/api/share/${fileId}`, { method: 'DELETE' });
}

export function listShares(): Promise<SharesResponse> {
  return apiFetch('/api/shares');
}

// ─── Share (folder link) ─────────────────────────────────────────────────

export interface CreateFolderShareLinkRequest {
  folder: string;
  password?: string;
  expiresInDays?: number;
}

export function createFolderShareLink(req: CreateFolderShareLinkRequest) {
  return apiFetch<{ token: string; hasPassword: boolean; expiresAt: string | null }>('/api/folder-share-link', {
    method: 'POST',
    body: req,
  });
}

export function getFolderShareLink(folder: string): Promise<FolderShareLinkInfo> {
  return apiFetch(`/api/folder-share-link/${encodeURIComponent(folder)}`);
}

export function revokeFolderShareLink(folder: string) {
  return apiFetch<{ message: string }>(`/api/folder-share-link/${encodeURIComponent(folder)}`, { method: 'DELETE' });
}

// ─── Public (guest) endpoints ────────────────────────────────────────────

export function listPublicShared(): Promise<PublicSharedResponse> {
  return apiFetch('/api/public/shared', { noAuthRedirect: true });
}

export function browsePublicFolder(path: string): Promise<PublicFolderResponse> {
  return apiFetch(`/api/public/folder?path=${encodeURIComponent(path)}`, { noAuthRedirect: true });
}

// ─── Auth ────────────────────────────────────────────────────────────────

export async function login(password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    credentials: 'same-origin',
    redirect: 'follow',
  });
  if (res.redirected) {
    window.location.href = res.url;
    return { ok: true };
  }
  if (res.ok) {
    window.location.href = '/admin';
    return { ok: true };
  }
  let msg = 'Invalid password';
  try {
    const body = await res.json();
    if (body?.error) msg = body.error;
  } catch {
    /* ignore */
  }
  return { ok: false, error: msg };
}

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/login';
}

// ─── Upload (multipart) ──────────────────────────────────────────────────

export async function multipartCreate(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<MultipartCreateResponse> {
  const res = await fetch('/api/files/upload?action=mpu-create', {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) throw new Error('Failed to create multipart upload');
  return res.json();
}

export async function multipartUploadPart(args: {
  uploadId: string;
  key: string;
  partNumber: number;
  chunk: Blob;
  signal?: AbortSignal;
}): Promise<UploadPart> {
  const { uploadId, key, partNumber, chunk, signal } = args;
  const url = `/api/files/upload?action=mpu-upload&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { method: 'PUT', body: chunk, credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`Failed to upload part ${partNumber}`);
  const data = (await res.json()) as { etag: string };
  return { partNumber, etag: data.etag };
}

export async function multipartComplete(args: {
  uploadId: string;
  key: string;
  parts: UploadPart[];
  signal?: AbortSignal;
}) {
  const res = await fetch('/api/files/upload?action=mpu-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: args.uploadId, key: args.key, parts: args.parts }),
    credentials: 'same-origin',
    signal: args.signal,
  });
  if (!res.ok) throw new Error('Failed to complete multipart upload');
}

/** Abort a multipart upload to release any uploaded parts on R2.
 *  Best-effort: server returns 200 even if the upload no longer exists. */
export async function multipartAbort(args: { uploadId: string; key: string }): Promise<void> {
  try {
    await fetch('/api/files/upload?action=mpu-abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      credentials: 'same-origin',
      keepalive: true,
    });
  } catch {
    /* ignore — best effort */
  }
}

/** Fire-and-forget abort using sendBeacon, suitable for pagehide. */
export function multipartAbortBeacon(args: { uploadId: string; key: string }): void {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  // sendBeacon's allowed Content-Types are restricted; text/plain is universally accepted.
  // Server's mpu-abort handler reads request.text() + JSON.parse so the wire format matches.
  const blob = new Blob([JSON.stringify(args)], { type: 'text/plain;charset=UTF-8' });
  navigator.sendBeacon('/api/files/upload?action=mpu-abort', blob);
}

export type { FileMeta, FolderInfo, StatsResponse, SiteSettings, FolderShareLinkInfo } from './types';
