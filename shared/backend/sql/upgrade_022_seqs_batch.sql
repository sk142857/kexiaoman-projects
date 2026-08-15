-- ============================================================
-- 升级脚本：t_seqs 增加号段列 batch（每次领取的 ID 数量）
-- 影响表：t_seqs
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（IF NOT EXISTS 加列；UPDATE 按 seq_key 精确定位，可重复执行）
-- 前置条件：无（旧库执行本脚本补齐 batch；新库 init_schema/init_data 已含 batch）
-- 说明：号段大小优先读本列（后台「序列管理」可调整），未配置时后端回退代码默认值
--       （日志类 500 / 其余 200）。
-- ============================================================

-- 1. 增加号段列（已存在则跳过）
ALTER TABLE t_seqs ADD COLUMN batch INT NOT NULL DEFAULT 200 COMMENT '号段大小（每次向 seqs 领取的 ID 数量，后台可调整）';

-- 2. 初始化号段大小：日志类（时间轴/订阅发送）500，其余 200
UPDATE t_seqs SET batch = 500
WHERE seq_key IN ('task_timeline_event_id', 'subscribe_send_id')
  AND (batch IS NULL OR batch = 0);

UPDATE t_seqs SET batch = 200
WHERE (batch IS NULL OR batch = 0);
