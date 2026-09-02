-- ============================================================
-- 课小满 物理清除审计表：支持「用户（openid）清理」类型
-- 在 t_lp_staff_purges 增加 target_kind 列（staff=业务账号 / user=微信用户 openid），
-- 兼容已在旧库执行过 upgrade_050_staff_purges.sql 的环境。
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行；幂等（加列前查 information_schema）。
-- ============================================================

SET NAMES utf8mb4;
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_staff_purges' AND column_name = 'target_kind');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_staff_purges ADD COLUMN target_kind VARCHAR(16) NOT NULL DEFAULT ''staff'' COMMENT ''清除对象类型 staff=业务账号 / user=微信用户(openid)'' AFTER app_id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
