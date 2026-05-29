-- 为 sha256 字段添加索引，加速基于内容的去重查询
-- Apply with: wrangler d1 execute cloudvault --file=src/db/migrations/003_add_sha256_index.sql

CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
