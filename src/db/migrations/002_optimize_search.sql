-- 优化文件名搜索性能
-- 为文件名添加索引以加速 LIKE 查询
CREATE INDEX IF NOT EXISTS idx_files_name_lower ON files(LOWER(name));

-- 为文件夹字段添加复合索引以加速文件夹+排序查询
CREATE INDEX IF NOT EXISTS idx_files_folder_uploaded ON files(folder, uploaded_at DESC);
