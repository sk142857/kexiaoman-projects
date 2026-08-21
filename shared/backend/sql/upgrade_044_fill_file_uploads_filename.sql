-- ============================================================
-- 升级脚本：补全 file_uploads.file_name（复制任务/打卡产生的副本文件名为空）
-- 影响表：t_file_uploads（仅补全 file_name 为空的历史记录）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行；建议先执行各段 SELECT 预览再 UPDATE
-- 幂等性：是（只更新 file_name 为空 / '' 的记录，可重复执行）
-- 前置条件：无
-- 背景：
--   历史 copyImageNew 复制图片时登记 file_uploads 未写入 file_name（且 file_size 记 0），
--   导致复制任务后文件记录「原始文件名」为空。已从代码层修复（storage.js），本脚本仅回补存量。
-- 补全策略：
--   1) 精确补全：按「content_type + file_size」匹配同组中有 file_name 的记录（复制文件与源文件字节一致）
--   2) 兜底补全：复制副本 file_size=0 时精确匹配不命中，退化为按「biz + content_type」取组内任一有 file_name 的记录
-- ============================================================

-- ---------- 1) 精确补全：同 content_type + file_size ----------
-- 预览
SELECT fu.file_id, fu.file_path, fu.biz, fu.content_type, fu.file_size, fu.file_name, d.donor_name
FROM t_file_uploads fu
JOIN (
  SELECT content_type, file_size, MIN(file_name) AS donor_name
  FROM t_file_uploads
  WHERE file_name IS NOT NULL AND file_name != ''
    AND content_type IS NOT NULL AND content_type != ''
  GROUP BY content_type, file_size
) d ON d.content_type = fu.content_type AND d.file_size = fu.file_size
WHERE (fu.file_name IS NULL OR fu.file_name = '')
  AND fu.content_type IS NOT NULL AND fu.content_type != '';

-- 执行
UPDATE t_file_uploads fu
JOIN (
  SELECT content_type, file_size, MIN(file_name) AS donor_name
  FROM t_file_uploads
  WHERE file_name IS NOT NULL AND file_name != ''
    AND content_type IS NOT NULL AND content_type != ''
  GROUP BY content_type, file_size
) d ON d.content_type = fu.content_type AND d.file_size = fu.file_size
SET fu.file_name = d.donor_name
WHERE (fu.file_name IS NULL OR fu.file_name = '')
  AND fu.content_type IS NOT NULL AND fu.content_type != '';

-- ---------- 2) 兜底补全：同 biz + content_type（副本 file_size=0 时） ----------
-- 预览
SELECT fu.file_id, fu.file_path, fu.biz, fu.content_type, fu.file_size, fu.file_name, d.donor_name
FROM t_file_uploads fu
JOIN (
  SELECT biz, content_type, MIN(file_name) AS donor_name
  FROM t_file_uploads
  WHERE file_name IS NOT NULL AND file_name != ''
    AND content_type IS NOT NULL AND content_type != ''
  GROUP BY biz, content_type
) d ON d.biz = fu.biz AND d.content_type = fu.content_type
WHERE (fu.file_name IS NULL OR fu.file_name = '')
  AND fu.content_type IS NOT NULL AND fu.content_type != '';

-- 执行
UPDATE t_file_uploads fu
JOIN (
  SELECT biz, content_type, MIN(file_name) AS donor_name
  FROM t_file_uploads
  WHERE file_name IS NOT NULL AND file_name != ''
    AND content_type IS NOT NULL AND content_type != ''
  GROUP BY biz, content_type
) d ON d.biz = fu.biz AND d.content_type = fu.content_type
SET fu.file_name = d.donor_name
WHERE (fu.file_name IS NULL OR fu.file_name = '')
  AND fu.content_type IS NOT NULL AND fu.content_type != '';

-- 校验：应无 file_name 为空的记录（若有，多为「全库同类型都无名称」的脏数据，可人工按 file_path 取名）
SELECT COUNT(*) AS still_empty
FROM t_file_uploads
WHERE file_name IS NULL OR file_name = '';
