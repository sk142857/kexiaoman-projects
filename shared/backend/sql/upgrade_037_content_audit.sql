-- ============================================================
-- 升级脚本：内容安全审核（t_content_audits）
-- 影响表：t_content_audits（新增）、t_apps（新增 content_security 配置列）、t_seqs（content_audit_id 序列）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（CREATE TABLE IF NOT EXISTS / 加列前查 information_schema / INSERT IGNORE）
-- 说明：
--   1. 内容安全检测为旁路管线，与业务审核（打卡 review_status）正交：
--      - 业务审核：人工，仅打卡，状态写业务表 t_lp_task_checkins；
--      - 内容安全：机器，覆盖任务/打卡/资料等全部 UGC 的文本与媒体，结果只写本表，
--        业务读路径用 mergeAudit 派生展示级别，业务表结构零改动。
--   2. 全局开关：t_apps.content_security 存 JSON，如 {"enabled":true,"scene":2}；
--      关闭时后端入队/worker/merge 全部短路，业务行为与接入前完全一致。
--   3. 降级策略：检测失败/超时 → status=skip（放行）+ 告警日志，不阻断业务；
--      打卡仍有 pending→approved/rejected 人工审核兜底。
--   4. 需同步更新 init_schema.sql（建表 + t_apps 列）与 init_data.sql（seqs 种子）。
-- ============================================================

-- 1. 建表（不存在才建，可重复执行）
CREATE TABLE IF NOT EXISTS t_content_audits (
  audit_id     BIGINT       NOT NULL COMMENT '审核ID（seqs 发放）',
  app_id       VARCHAR(32)  NOT NULL DEFAULT 'miniprogram-kxm' COMMENT '所属小程序 app_id',
  biz_type     VARCHAR(24)  NOT NULL DEFAULT '' COMMENT '业务类型 task/checkin/profile/collection/review_note/file',
  biz_id       VARCHAR(128) NOT NULL DEFAULT '' COMMENT '业务ID（文本=biz_id；媒体=file_path）',
  field        VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '字段名（title/description/checkin_note/nickname/avatar；媒体为 file）',
  media_type   TINYINT      NOT NULL DEFAULT 1 COMMENT '1文本 2图片 3音频 4视频',
  content      VARCHAR(2500) NOT NULL DEFAULT '' COMMENT '文本内容（文本，与 msgSecCheck 2500 上限对齐）或文件相对路径（媒体）',
  openid       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '提交用户 openid',
  status       VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending/pass/reject/risk/skip',
  detail       VARCHAR(500) NOT NULL DEFAULT '' COMMENT '风险点/命中标签/失败原因',
  score        TINYINT      NOT NULL DEFAULT 0 COMMENT '风险分（0-100，微信接口未给分时留 0）',
  trace_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '微信异步检测 trace_id（音频/视频）',
  next_poll_at DATETIME     NULL COMMENT '下次轮询时间（异步检测/失败退避）',
  retries      TINYINT      NOT NULL DEFAULT 0 COMMENT '重试/轮询次数',
  enqueued_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入队时间',
  detected_at  DATETIME     NULL COMMENT '检测完成时间',
  PRIMARY KEY (audit_id),
  KEY idx_status_enq (status, enqueued_at),
  KEY idx_biz (biz_type, biz_id, field),
  KEY idx_trace (trace_id),
  KEY idx_app_status (app_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='内容安全审核记录（旁路，独立于业务表）';

-- 2. 初始化 content_audit_id 序列（不存在才插入；current_value=MAX+1）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at)
SELECT 'content_audit_id', '内容审核ID', COALESCE(MAX(audit_id), 0) + 1, 1, 1, 200, NOW()
FROM t_content_audits
ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, VALUES(current_value));

-- 3. t_apps 增加内容安全配置列（JSON：{"enabled":true,"scene":2}）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_apps' AND column_name = 'content_security');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_apps ADD COLUMN content_security VARCHAR(500) NOT NULL DEFAULT '''' COMMENT ''内容安全配置JSON(如 {"enabled":true,"scene":2})'' AFTER service_url',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
