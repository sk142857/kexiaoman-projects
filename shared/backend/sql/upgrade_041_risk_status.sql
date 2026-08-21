-- ============================================================
-- 升级脚本：业务表内容安全状态（risk_status）
-- 影响表：t_lp_tasks（新增 risk_status）、t_lp_task_checkins（新增 risk_status）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（加列前查 information_schema；回填带 NOT EXISTS）
-- 说明：
--   1. 业务表直接承载内容安全状态，与人工业务审核（review_status）正交：
--      - risk_status：机器检测，pass 通过 / pending 检测中 / reject 违规（仅 label=100 通过，其余拦截）
--      - review_status：人工审核（打卡），pending→approved/rejected
--      - 前端只展示「risk_status 符合 && 业务状态符合」的记录
--   2. worker 检测完成后实时回写（contentSecurity.syncRecordRisk）；新增记录默认 pending，
--      检测通过/违规后立即更新。
--   3. 存量回填 pass：历史内容从未经机器检测，直接放行（与打卡审核存量回填 approved 同理念）。
--   4. 需同步更新 init_schema.sql。
-- ============================================================

-- 1. t_lp_tasks.risk_status
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_tasks' AND column_name = 'risk_status');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_tasks ADD COLUMN risk_status VARCHAR(16) NOT NULL DEFAULT ''pending'' COMMENT ''内容安全状态 pass通过/pending检测中/reject违规'' AFTER task_status',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
UPDATE t_lp_tasks t SET t.risk_status = 'pass'
WHERE t.risk_status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM t_content_audits a WHERE a.biz_type = 'task' AND a.biz_id = CAST(t.task_id AS CHAR));

-- 2. t_lp_task_checkins.risk_status
SET @has_col2 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'risk_status');
SET @sql2 := IF(@has_col2 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN risk_status VARCHAR(16) NOT NULL DEFAULT ''pending'' COMMENT ''内容安全状态 pass通过/pending检测中/reject违规'' AFTER review_status',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
UPDATE t_lp_task_checkins c SET c.risk_status = 'pass'
WHERE c.risk_status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM t_content_audits a WHERE a.biz_type = 'checkin' AND a.biz_id = CAST(c.checkin_id AS CHAR));
