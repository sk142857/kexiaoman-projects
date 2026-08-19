-- ============================================================
-- 升级脚本：共用微信多身份（一 openid 多绑定）+ 家长身份 PIN 锁
-- 影响表：t_lp_students（唯一键放开）、t_staff（加 pin_hash）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断索引/列，可重复执行）
-- 前置条件：需先执行 upgrade_021_apps_rename.sql（app_id 规范）
-- 说明：
--   1. t_lp_students 唯一键由 uk_app_openid(app_id,openid) 改为
--      uk_app_openid_staff(app_id,openid,staff_id)：同一 openid 可绑定多个身份
--      （家长 + 多个孩子 + 家属），实现家长孩子共用微信。
--   2. t_staff 增加 pin_hash（bcrypt）：家长身份切换 PIN 锁，仅 parent/admin 可设，
--      孩子切换到家长模式需 PIN，防止越权查看敏感信息。
-- ============================================================

-- 1. t_lp_students：删除旧唯一键 uk_app_openid（存在才删）
SET @db := DATABASE();
SET @has_old_idx := (SELECT COUNT(*) FROM information_schema.statistics
                     WHERE table_schema = @db AND table_name = 't_lp_students' AND index_name = 'uk_app_openid');
SET @sql := IF(@has_old_idx > 0,
  'ALTER TABLE t_lp_students DROP INDEX uk_app_openid',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. t_lp_students：新增唯一键 uk_app_openid_staff（不存在才加）
SET @has_new_idx := (SELECT COUNT(*) FROM information_schema.statistics
                     WHERE table_schema = @db AND table_name = 't_lp_students' AND index_name = 'uk_app_openid_staff');
SET @sql2 := IF(@has_new_idx = 0,
  'ALTER TABLE t_lp_students ADD UNIQUE KEY uk_app_openid_staff (app_id, openid, staff_id)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. t_staff：增加 pin_hash 列（不存在才加）
SET @has_pin := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_staff' AND column_name = 'pin_hash');
SET @sql3 := IF(@has_pin = 0,
  'ALTER TABLE t_staff ADD COLUMN pin_hash VARCHAR(100) NOT NULL DEFAULT '''' COMMENT ''身份切换 PIN（bcrypt，仅 parent/admin 可设，空=未开启）'' AFTER staff_avatar',
  'SELECT 1');
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;
