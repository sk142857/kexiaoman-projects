-- ============================================================
-- 升级脚本：学习积分账本（t_lp_point_logs）
-- 影响表：t_lp_point_logs（新增）、t_seqs（point_log_id 序列）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（CREATE TABLE IF NOT EXISTS；回填带 EXISTS 防重，可重复执行）
-- 说明：
--   1. 积分改为账本式：每次加分/减分写入流水（reason 区分原因），余额 = 流水累加，
--      删除已通过打卡 / 任务回退 / 删除任务时自动回扣，杜绝"只增不减"与待审核/驳回误计。
--   2. 规则：打卡审核通过 +10；任务完成 +30（有派发人则每位派发人，否则创建人）；
--      删除已通过打卡 -10；已完成任务回退 -30；删除已完成任务 -30、其已通过打卡每人 -10。
--   3. 存量回填：历史已通过打卡 +10、历史已完成任务 +30，与原「审核通过计分」口径一致，
--      同时纠正旧公式把待审核/驳回打卡计入经验的问题（经验会小幅回落，属预期修复）。
--   4. 需同步更新 init_schema.sql 保持一致。
-- ============================================================

-- 1. 建账本表（不存在才建，可重复执行）
CREATE TABLE IF NOT EXISTS t_lp_point_logs (
  log_id      BIGINT       NOT NULL COMMENT '主键（序列 point_log_id 发放）',
  staff_id    BIGINT       NOT NULL DEFAULT 0 COMMENT '学生 staff_id',
  points      INT          NOT NULL DEFAULT 0 COMMENT '积分变动(+加分/-扣分)',
  reason      VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '变动原因 checkin_approved/task_done/checkin_deleted/task_undone/task_deleted/admin_adjust',
  ref_type    VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '关联类型 task/task_checkin',
  ref_id      BIGINT       NOT NULL DEFAULT 0 COMMENT '关联任务或打卡ID',
  note        VARCHAR(255) NOT NULL DEFAULT '' COMMENT '说明',
  created_by  BIGINT       NOT NULL DEFAULT 0 COMMENT '操作人 staff_id(0=系统)',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '变动时间',
  PRIMARY KEY (log_id),
  KEY idx_staff (staff_id, created_at),
  KEY idx_ref (ref_type, ref_id),
  KEY idx_reason (reason)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学习积分账本';

-- 2. 序列：point_log_id（不存在才插入）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at)
VALUES ('point_log_id', '积分流水ID', 1, 1, 1, 500, CURRENT_TIMESTAMP)
ON DUPLICATE KEY UPDATE batch = GREATEST(batch, 500);

-- 3. 存量回填（仅空表时执行一次；带 EXISTS 防重复）
SET @cnt := (SELECT COUNT(*) FROM t_lp_point_logs);
SET @log_id := (SELECT current_value FROM t_seqs WHERE seq_key = 'point_log_id') - 1;

INSERT INTO t_lp_point_logs (log_id, staff_id, points, reason, ref_type, ref_id, note, created_by, created_at)
SELECT @log_id := @log_id + 1, c.created_by, 10, 'checkin_approved', 'task_checkin', c.checkin_id,
       '存量回填：历史审核通过打卡', 0, COALESCE(c.reviewed_at, c.created_at)
FROM t_lp_task_checkins c
WHERE @cnt = 0
  AND c.review_status = 'approved'
  AND NOT EXISTS (SELECT 1 FROM t_lp_point_logs pl
                  WHERE pl.ref_type = 'task_checkin' AND pl.ref_id = c.checkin_id AND pl.reason = 'checkin_approved');

INSERT INTO t_lp_point_logs (log_id, staff_id, points, reason, ref_type, ref_id, note, created_by, created_at)
SELECT @log_id := @log_id + 1, a.staff_id, 30, 'task_done', 'task', t.task_id,
       '存量回填：历史完成任务', 0, t.updated_at
FROM t_lp_tasks t
JOIN t_lp_task_assignees a ON a.task_id = t.task_id
WHERE @cnt = 0
  AND t.task_status = 'done'
  AND NOT EXISTS (SELECT 1 FROM t_lp_point_logs pl
                  WHERE pl.ref_type = 'task' AND pl.ref_id = t.task_id AND pl.reason = 'task_done' AND pl.staff_id = a.staff_id);

-- 任务无派发人时回填给创建人
INSERT INTO t_lp_point_logs (log_id, staff_id, points, reason, ref_type, ref_id, note, created_by, created_at)
SELECT @log_id := @log_id + 1, t.created_by, 30, 'task_done', 'task', t.task_id,
       '存量回填：历史完成任务（创建人）', 0, t.updated_at
FROM t_lp_tasks t
WHERE @cnt = 0
  AND t.task_status = 'done'
  AND NOT EXISTS (SELECT 1 FROM t_lp_task_assignees ta WHERE ta.task_id = t.task_id)
  AND NOT EXISTS (SELECT 1 FROM t_lp_point_logs pl
                  WHERE pl.ref_type = 'task' AND pl.ref_id = t.task_id AND pl.reason = 'task_done' AND pl.staff_id = t.created_by);

-- 4. 回填后同步序列，避免与新流水主键冲突
UPDATE t_seqs SET current_value = GREATEST(current_value, @log_id + 1) WHERE seq_key = 'point_log_id';
