-- ── 文件元数据（替代 file:<id>，并合并 share:<token> 反查） ──
CREATE TABLE files (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  type            TEXT NOT NULL,
  folder          TEXT NOT NULL DEFAULT '',
  uploaded_at     TEXT NOT NULL,
  share_token     TEXT,
  share_password  TEXT,
  share_expires_at TEXT,
  downloads       INTEGER NOT NULL DEFAULT 0,
  sha1            TEXT,
  sha256          TEXT
);
CREATE INDEX idx_files_folder       ON files(folder);
CREATE INDEX idx_files_uploaded_at  ON files(uploaded_at DESC);
CREATE INDEX idx_files_downloads    ON files(downloads DESC);
CREATE UNIQUE INDEX idx_files_share_token
  ON files(share_token) WHERE share_token IS NOT NULL;

-- ── 虚拟文件夹（替代 folder:<path>） ──
CREATE TABLE folders (
  path        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ── 文件夹分享标记（替代 foldershare:<folder>） ──
CREATE TABLE folder_shares (
  folder      TEXT PRIMARY KEY,
  shared_at   TEXT NOT NULL
);

-- ── 文件夹分享排除（替代 foldershare-exclude:<folder>） ──
CREATE TABLE folder_share_excludes (
  folder      TEXT PRIMARY KEY,
  excluded_at TEXT NOT NULL
);

-- ── 文件夹分享链接（替代 foldersharelink:<token> + meta:<folder>） ──
CREATE TABLE folder_share_links (
  token           TEXT PRIMARY KEY,
  folder          TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_folder_share_links_folder ON folder_share_links(folder);

-- ── 会话（替代 session:<id>） ──
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ── 站点设置（替代 settings:<key>） ──
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
