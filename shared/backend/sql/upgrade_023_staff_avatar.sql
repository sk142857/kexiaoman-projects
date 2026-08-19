
-- ============================================================
-- 升级脚本：t_staff 增加头像列 staff_avatar（云存储相对路径）
-- 影响表：t_staff
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断加列，可重复执行）
-- 前置条件：无（新库 init_schema.sql 已含 staff_avatar；旧库执行本脚本补齐）
-- 说明：小程序「编辑资料」页支持头像修改，头像以相对路径存于本列，
--       展示时拼接云存储公开访问域名（见 shared/backend/storage.js）。
-- ============================================================

SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_staff' AND column_name = 'staff_avatar');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_staff ADD COLUMN staff_avatar VARCHAR(500) NOT NULL DEFAULT '''' COMMENT ''头像（云存储相对路径）'' AFTER staff_nickname',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
