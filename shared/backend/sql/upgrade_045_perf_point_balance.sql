-- ============================================================
-- 升级脚本：性能优化（积分余额表 + 待审核复合索引）
-- 影响表：t_lp_point_balances（新增）、t_lp_task_checkins（新增索引）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（CREATE TABLE IF NOT EXISTS / 索引存在判断 / 回填带 EXISTS 防重）
-- 说明：
--   1. t_lp_point_balances：学生积分余额快照表（staff_id 主键），
--      由 logPoints 写流水时同步累加，读余额由「拉全量流水 JS 求和」降为单行查询，
--      解决 /api/lp/dashboard 每次拉 10000 行 point_logs 求和的问题。
--   2. 存量回填：从 t_lp_point_logs 按 staff_id 聚合 SUM(points) 初始化余额，
--      带 NOT EXISTS 防重，可重复执行。
--   3. t_lp_task_checkins：idx_review_created (review_status, created_by) 复合索引，
--      覆盖家长/家属「待审核打卡」查询 review_status='pending' AND created_by IN (...)
--      的场景，避免 idx_review_status 单列索引后回表过滤。
--   4. 需同步更新 init_schema.sql 保持一致。
-- ============================================================

-- 1. 建积分余额快照表（不存在才建，可重复执行）
CREATE TABLE IF NOT EXISTS t_lp_point_balances (
  staff_id   BIGINT   NOT NULL COMMENT '学生 staff_id',
  balance    INT      NOT NULL DEFAULT 0 COMMENT '积分余额（流水累加快照）',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学习积分余额快照';

-- 2. 存量回填：从账本按 staff_id 聚合，补齐/校正余额（带 NOT EXISTS 防重复插入）
INSERT INTO t_lp_point_balances (staff_id, balance, updated_at)
SELECT p.staff_id, SUM(p.points), NOW()
FROM t_lp_point_logs p
WHERE p.staff_id > 0
  AND NOT EXISTS (SELECT 1 FROM t_lp_point_balances b WHERE b.staff_id = p.staff_id)
GROUP BY p.staff_id;

-- 3. t_lp_task_checkins：待审核复合索引（不存在才加，可重复执行）
SET @db := DATABASE();
SET @has_idx := (SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND index_name = 'idx_review_created');
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE t_lp_task_checkins ADD KEY idx_review_created (review_status, created_by)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
