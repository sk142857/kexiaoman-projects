-- ============================================================
-- 升级脚本：任务状态字典统一为「待完成」并补齐 color（供卡片模式等直接使用字典色）
-- 影响表：t_dict_items（task_status 三项的 item_label / color）、t_seqs（dict_item_id 同步）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（uk_dict_item 唯一键 + ON DUPLICATE KEY UPDATE，可重复执行）
-- 前置条件：无
-- 说明：
--   1. 术语统一：todo 由「未开始/未完成」统一为「待完成」
--   2. task_status 字典补齐 color：todo=#bfbfbf 灰 / doing=#1677ff 蓝 / done=#52c41a 绿
--   3. 需同步更新 init_data.sql（保持字典种子一致）
-- ============================================================

SET @base := (SELECT IFNULL(MAX(item_id), 0) FROM t_dict_items);

INSERT INTO t_dict_items (item_id, dict_code, item_value, item_label, color, sort, item_status, created_at, updated_at) VALUES
  (@base + 1, 'task_status', 'todo',  '待完成', '#bfbfbf', 1, 1, NOW(), NOW()),
  (@base + 2, 'task_status', 'doing', '进行中', '#1677ff', 2, 1, NOW(), NOW()),
  (@base + 3, 'task_status', 'done',  '已完成', '#52c41a', 3, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE item_label = VALUES(item_label), color = VALUES(color), sort = VALUES(sort), item_status = VALUES(item_status);

-- 同步序列：字典项 ID 覆盖新增最大值，避免后续发放冲突
SET @dmax := (SELECT IFNULL(MAX(item_id), 0) + 1 FROM t_dict_items);
UPDATE t_seqs SET current_value = GREATEST(current_value, @dmax) WHERE seq_key = 'dict_item_id';
