// ─── Environment Bindings ─────────────────────────────────────────────
export interface Env {
  VAULT_BUCKET: R2Bucket;
  DB: D1Database;           // 使用D1代替KV
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;   // wrangler secret
  SESSION_SECRET: string;   // wrangler secret
  ENVIRONMENT: string;
}

// ─── File Metadata (stored in D1) ─────────────────────────────────────
export interface FileMeta {
  id: string;
  key: string;              // R2 object key (e.g. "photos/sunset.jpg")
  name: string;             // Original filename
  size: number;
  type: string;             // MIME type
  folder: string;           // Virtual folder path (e.g. "photos")
  uploadedAt: string;       // ISO 8601
  shareToken: string | null;
  sharePassword: string | null; // bcrypt-style hash (null = no password)
  shareExpiresAt: string | null; // ISO 8601 or null
  downloads: number;
  uploadId?: string | null;
  uploadChunks?: { partNumber: number; etag: string }[] | null;
  uploadStatus?: string | null;
  uploadCreatedAt?: string | null;
  uploadUpdatedAt?: string | null;
  uploadTotalChunks?: number | null;
  uploadCompletedChunks?: number | null;
  uploadRetryCount?: number | null;
  uploadError?: string | null;
  sha1?: string | null;
  sha256?: string | null;
}

// ─── Folder Share Info ───────────────────────────────────────────────
export interface FolderShare {
  folder: string;
  sharedAt: string;
}

export interface FolderExclude {
  folder: string;
  excludedAt: string;
}

export interface FolderShareLink {
  token: string;
  folder: string;
  passwordHash: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// ─── Session ──────────────────────────────────────────────────────────
export interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
}

// ─── API Response Types ───────────────────────────────────────────────
export interface FileListResponse {
  files: FileMeta[];
  hasMore: boolean;
  total?: number | null;
  cursor?: string | null;
}

export interface StatsResponse {
  totalFiles: number;
  totalSize: number;
  totalDownloads: number;
  recentUploads: FileMeta[];
  topDownloaded: FileMeta[];
}

// ─── API Request Types ────────────────────────────────────────────────
export interface CreateShareRequest {
  fileId: string;
  password?: string;
  expiresInDays?: number;
}

export interface MoveFilesRequest {
  ids: string[];
  targetFolder: string;
}

export interface MoveFilesResponse {
  moved: number;
}

export interface MoveFolderRequest {
  sourceFolder: string;
  targetFolder: string;
}

export interface MoveFolderResponse {
  folder: string;
  previousFolder: string;
}

export interface MultipartCreateResponse {
  uploadId: string;
  key: string;
}

export interface MultipartCompleteRequest {
  uploadId: string;
  key: string;
  parts: { partNumber: number; etag: string }[];
}

export interface ResetAllDataResponse {
  deletedObjects: number;
  resetTables: string[];
}

export interface CleanupIncompleteUploadsResponse {
  deletedTasks: number;
  abortedMultipartUploads: number;
}

// ─── Site Settings ────────────────────────────────────────────────────
export interface SiteSettings {
  guestPageEnabled: boolean;
  showLoginButton: boolean;
  siteName: string;
  siteIconUrl: string;        // URL to custom logo/icon image (empty = default cloud icon)
  allowedUploadExtensions: string; // Comma separated extensions, empty = allow all
}

export const DEFAULT_SETTINGS: SiteSettings = {
  guestPageEnabled: false,
  showLoginButton: true,
  siteName: 'CloudVault',
  siteIconUrl: '',
  allowedUploadExtensions: '',
};
