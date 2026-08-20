-- ============================================================
-- 升级脚本：性能索引补充（审计报告 P1）
-- 影响表：t_file_uploads / t_lp_subscribe_sends / t_lp_subscribe_grants / t_staff_events
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断索引是否存在，可重复执行）
-- 前置条件：无
-- 说明：
--   1. t_file_uploads：file_path 单独建索引（storage.js / lp.js 大量按 path 查询，
--      现有 idx_openid_path 以 openid 为最左列，无法覆盖纯 file_path 条件）
--   2. t_lp_subscribe_sends：(event_type, app_id, created_at) 索引，
--      覆盖 reminder.js 每日去重扫描，避免全表扫描
--   3. t_lp_subscribe_grants：(app_id, created_at) 索引，覆盖后台列表 appField 过滤
--   4. t_staff_events：(app_id, created_at) 索引，覆盖后台审计列表 appField 过滤
--   5. 与 init_schema.sql 保持一致（新增建表时同步包含这些索引）
-- ============================================================

-- 1. t_file_uploads：idx_file_path
SET @db := DATABASE();
SET @has_idx := (SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema = @db AND table_name = 't_file_uploads' AND index_name = 'idx_file_path');
SET @sql := IF(@has_idx = 0, 'ALTER TABLE t_file_uploads ADD KEY idx_file_path (file_path(191))', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. t_lp_subscribe_sends：idx_event_app_created
SET @has_idx2 := (SELECT COUNT(*) FROM information_schema.statistics
                  WHERE table_schema = @db AND table_name = 't_lp_subscribe_sends' AND index_name = 'idx_event_app_created');
SET @sql2 := IF(@has_idx2 = 0, 'ALTER TABLE t_lp_subscribe_sends ADD KEY idx_event_app_created (event_type, app_id, created_at)', 'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. t_lp_subscribe_grants：idx_app_created
SET @has_idx3 := (SELECT COUNT(*) FROM information_schema.statistics
                  WHERE table_schema = @db AND table_name = 't_lp_subscribe_grants' AND index_name = 'idx_app_created');
SET @sql3 := IF(@has_idx3 = 0, 'ALTER TABLE t_lp_subscribe_grants ADD KEY idx_app_created (app_id, created_at)', 'SELECT 1');
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- 4. t_staff_events：idx_app_created
SET @has_idx4 := (SELECT COUNT(*) FROM information_schema.statistics
                  WHERE table_schema = @db AND table_name = 't_staff_events' AND index_name = 'idx_app_created');
SET @sql4 := IF(@has_idx4 = 0, 'ALTER TABLE t_staff_events ADD KEY idx_app_created (app_id, created_at)', 'SELECT 1');
PREPARE stmt4 FROM @sql4;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;
