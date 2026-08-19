-- ============================================================
-- 升级脚本：任务新增独立进度字段 progress（默认 1%）
-- 影响表：t_lp_tasks（加 progress）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断列，可重复执行）
-- 前置条件：无
-- 说明：
--   1. progress 为任务独立进度字段（与 task_status 解耦，动态维护）：
--      新增任务 = 1；打卡（无论是否通过）= 50；审核通过 / 任务完成 = 100
--   2. 存量数据回填：done → 100；doing 且已有打卡 → 50；doing 未打卡 → 1；todo → 1
--   3. 需同步更新 init_schema.sql 保持一致
-- ============================================================

-- 1. t_lp_tasks：新增 progress 列（不存在才加）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_tasks' AND column_name = 'progress');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_tasks ADD COLUMN progress TINYINT NOT NULL DEFAULT 1 COMMENT ''任务进度(1待开始/50已打卡进行中/100已完成)'' AFTER task_status',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. 存量数据回填（可重复执行，幂等）
UPDATE t_lp_tasks SET progress = 100 WHERE task_status = 'done';
UPDATE t_lp_tasks SET progress = 50 WHERE task_status = 'doing' AND checkin_count > 0;
UPDATE t_lp_tasks SET progress = 1 WHERE task_status = 'doing' AND checkin_count = 0;
UPDATE t_lp_tasks SET progress = 1 WHERE task_status = 'todo';
