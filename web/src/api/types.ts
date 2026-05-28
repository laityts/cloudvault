// ─── File / Folder DTOs (mirroring backend types — independent of backend code) ────

export interface FileMeta {
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: string;
  shareToken: string | null;
  sharePassword: string | null;
  shareExpiresAt: string | null;
  downloads: number;
}

export interface FolderInfo {
  name: string;
  shared: boolean;
  directlyShared: boolean;
  excluded: boolean;
}

export interface FileListResponse {
  files: FileMeta[];
  cursor: string | null;
  totalFiles: number;
}

export interface StatsResponse {
  totalFiles: number;
  totalSize: number;
  totalDownloads: number;
  recentUploads: FileMeta[];
  topDownloaded: FileMeta[];
}

export interface SiteSettings {
  guestPageEnabled: boolean;
  showLoginButton: boolean;
  siteName: string;
  siteIconUrl: string;
}

export interface FolderShareLinkInfo {
  token: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
}

// ─── Public (guest) listing payloads ─────────────────────────────────────

export interface PublicFile {
  id: string;
  name: string;
  size: number;
  type: string;
  token: string | null;
  folder: string;
  uploadedAt: string;
}

export interface PublicSharedResponse {
  files: PublicFile[];
  sharedFolders: string[];
  settings: { showLoginButton: boolean; siteName: string; siteIconUrl: string };
}

export interface PublicFolderResponse {
  files: PublicFile[];
  subfolders: string[];
  currentFolder?: string;
}

// ─── Share page (SSR injected) ───────────────────────────────────────────

export interface ShareFilePayload {
  /* error / password gate signaling */
  needsPassword?: boolean;
  error?: string;

  /* folder share */
  isFolder?: boolean;
  folder?: string;
  folderName?: string;
  subpath?: string;
  subfolders?: string[];
  files?: Array<{ id: string; name: string; size: number; type: string; folder: string; uploadedAt: string }>;

  /* file share */
  id?: string;
  name?: string;
  size?: number;
  type?: string;
  uploadedAt?: string;
  downloads?: number;
}

// ─── Branding (SSR injected) ─────────────────────────────────────────────

export interface BrandingData {
  siteName: string;
  siteIconUrl: string;
}

// ─── Multipart upload ────────────────────────────────────────────────────

export interface MultipartCreateResponse {
  uploadId: string;
  key: string;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}
