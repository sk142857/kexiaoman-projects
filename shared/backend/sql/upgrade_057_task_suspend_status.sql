-- ============================================================
-- 升级脚本：任务状态新增「任务挂起」（suspended）
-- 影响表：t_dict_items（task_status 新增一项）、t_seqs（dict_item_id 同步）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（uk_dict_item 唯一键 + ON DUPLICATE KEY UPDATE，可重复执行）
-- 前置条件：无
-- 说明：
--   1. 新增 task_status 字典项 suspended =「任务挂起」，橙色 #faad14，sort=4
--   2. 挂起语义（前后端已按此实现）：暂停任务——不进学生待办、禁止打卡、不发提醒、
--      不计入完成进度（progress=0）、不触发积分变动；可恢复为待完成/进行中
--   3. 已同步更新 init_data.sql（保持字典种子一致）
-- ============================================================

SET @base := (SELECT IFNULL(MAX(item_id), 0) FROM t_dict_items);

INSERT INTO t_dict_items (item_id, dict_code, item_value, item_label, color, sort, item_status, created_at, updated_at) VALUES
  (@base + 1, 'task_status', 'suspended', '任务挂起', '#faad14', 4, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE item_label = VALUES(item_label), color = VALUES(color), sort = VALUES(sort), item_status = VALUES(item_status);

-- 同步序列：字典项 ID 覆盖新增最大值，避免后续发放冲突
SET @dmax := (SELECT IFNULL(MAX(item_id), 0) + 1 FROM t_dict_items);
UPDATE t_seqs SET current_value = GREATEST(current_value, @dmax) WHERE seq_key = 'dict_item_id';
