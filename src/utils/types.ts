// ─── Environment Bindings ─────────────────────────────────────────────
export interface Env {
  VAULT_BUCKET: R2Bucket;
  VAULT_DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;   // wrangler secret
  SESSION_SECRET: string;   // wrangler secret
  ENVIRONMENT: string;
}

// ─── File Metadata (stored in KV) ─────────────────────────────────────
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
  /** Hex-encoded SHA-1, lazily computed on first /info request. */
  sha1: string | null;
  /** Hex-encoded SHA-256, lazily computed on first /info request. */
  sha256: string | null;
}

// ─── Share Link Info ──────────────────────────────────────────────────
export interface ShareInfo {
  fileId: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
  hasPassword: boolean;
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

// ─── API Request Types ────────────────────────────────────────────────
export interface CreateShareRequest {
  fileId: string;
  password?: string;
  expiresInDays?: number;
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

// ─── Site Settings ────────────────────────────────────────────────────
export interface SiteSettings {
  guestPageEnabled: boolean;
  showLoginButton: boolean;
  siteName: string;
  siteIconUrl: string;        // URL to custom logo/icon image (empty = default cloud icon)
}

export const DEFAULT_SETTINGS: SiteSettings = {
  guestPageEnabled: false,
  showLoginButton: true,
  siteName: 'CloudVault',
  siteIconUrl: '',
};
