-- 文件表
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL,
  folder TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  share_token TEXT UNIQUE,
  share_password TEXT,
  share_expires_at TEXT,
  downloads INTEGER DEFAULT 0,
  -- 分块上传字段
  upload_id TEXT,
  upload_chunks TEXT,
  upload_status TEXT DEFAULT 'pending',
  upload_created_at TEXT,
  upload_updated_at TEXT,
  upload_total_chunks INTEGER,
  upload_completed_chunks INTEGER DEFAULT 0,
  upload_retry_count INTEGER DEFAULT 0,
  upload_error TEXT,
  -- 哈希字段
  sha1 TEXT,
  sha256 TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_share_token ON files(share_token);
CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_files_upload_status ON files(upload_status);
CREATE INDEX IF NOT EXISTS idx_files_upload_id ON files(upload_id);
-- 加速分页查询的联合索引
CREATE INDEX IF NOT EXISTS idx_files_folder_status ON files(folder, upload_status);
CREATE INDEX IF NOT EXISTS idx_files_folder_uploaded_at ON files(folder, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_status_folder_uploaded_at ON files(upload_status, folder, uploaded_at DESC);

-- 文件夹表
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- 文件夹分享表
CREATE TABLE IF NOT EXISTS folder_shares (
  folder TEXT PRIMARY KEY,
  shared_at TEXT NOT NULL
);

-- 文件夹排除表
CREATE TABLE IF NOT EXISTS folder_excludes (
  folder TEXT PRIMARY KEY,
  excluded_at TEXT NOT NULL
);

-- 文件夹分享链接表
CREATE TABLE IF NOT EXISTS folder_share_links (
  token TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  password_hash TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folder_share_links_folder ON folder_share_links(folder);

-- 文件夹分享元数据表
CREATE TABLE IF NOT EXISTS folder_share_meta (
  folder TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  password_hash TEXT,
  expires_at TEXT
);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- 设置表
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 统计表
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY DEFAULT 1,
  total_files INTEGER DEFAULT 0,
  total_size INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO stats (id, total_files, total_size) VALUES (1, 0, 0);
