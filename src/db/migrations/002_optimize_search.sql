-- 优化文件夹列表与文件夹内排序查询性能
-- Apply with: wrangler d1 execute cloudvault --file=src/db/migrations/002_optimize_search.sql

-- 为文件夹字段添加复合索引以加速「按文件夹过滤 + 按上传时间排序」查询
CREATE INDEX IF NOT EXISTS idx_files_folder_uploaded ON files(folder, uploaded_at DESC);

-- 注：文件名搜索使用 LIKE '%term%'（前导通配符），B-tree 索引无法命中，
-- 故不为 name 建索引；如需加速模糊搜索应改用 FTS5 全文索引。
