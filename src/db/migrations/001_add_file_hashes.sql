-- Migration: add sha1 / sha256 columns to files (lazily populated by /api/files/:id/info)
-- Apply with: wrangler d1 execute cloudvault --file=src/db/migrations/001_add_file_hashes.sql

ALTER TABLE files ADD COLUMN sha1   TEXT;
ALTER TABLE files ADD COLUMN sha256 TEXT;
