-- ============================================================
-- 升级脚本：任务/打卡来源端（Web 后台 / 小程序）
-- 影响表：t_lp_tasks（新增 source）、t_lp_task_checkins（新增 source）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断列，可重复执行）
-- 前置条件：需先执行 upgrade_031_video_cover.sql
-- 说明：
--   1. source 标记「发布任务 / 打卡」来自哪个端：web（Web 后台）/ miniprogram（小程序）
--   2. 存量数据默认值：
--      - t_lp_tasks.source 默认 'web'（历史任务主要来自 Web 后台发布）
--      - t_lp_task_checkins.source 默认 'miniprogram'（历史打卡主要来自小程序提交）
--      如需按实际来源回填，请先备份后自行 UPDATE（如按 created_by 对应员工角色区分）
--   3. 需同步更新 init_schema.sql 保持一致
-- ============================================================

-- 1. t_lp_tasks：新增 source 列（不存在才加）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_tasks' AND column_name = 'source');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_tasks ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT ''web'' COMMENT ''发布来源 web后台/miniprogram小程序'' AFTER checkin_type',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. t_lp_task_checkins：新增 source 列（不存在才加）
SET @has_col2 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'source');
SET @sql2 := IF(@has_col2 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT ''miniprogram'' COMMENT ''打卡来源 web后台/miniprogram小程序'' AFTER checkin_type',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
