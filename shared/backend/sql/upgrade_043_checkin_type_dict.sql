-- ============================================================
-- 升级脚本：打卡方式字典（checkin_type）+ color 同步
-- 影响表：t_dict_types（新增 checkin_type）、t_dict_items（image/voice/video 三项 + color）、t_seqs（dict_type_id / dict_item_id 同步）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（uk_dict_code / uk_dict_item 唯一键 + ON DUPLICATE KEY UPDATE，可重复执行）
-- 前置条件：无（checkin_type 字段自 upgrade_025 已有：image图文/voice语音/video视频）
-- 说明：
--   1. 打卡方式（图文打卡/语音打卡/视频打卡）统一收口到数据字典维护，色值由后台「数据字典」调整即全局同步
--   2. 需同步更新 init_data.sql（保持字典种子一致）
-- ============================================================

-- 1. 字典类型：checkin_type
SET @tmax := (SELECT IFNULL(MAX(dict_id), 0) + 1 FROM t_dict_types);
INSERT INTO t_dict_types (dict_id, dict_code, dict_name, dict_status, created_at, updated_at) VALUES
  (@tmax, 'checkin_type', '打卡方式', 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE dict_name = VALUES(dict_name);

-- 2. 字典项：image/voice/video（含 color，供卡片模式等直接取色）
SET @base := (SELECT IFNULL(MAX(item_id), 0) FROM t_dict_items);
INSERT INTO t_dict_items (item_id, dict_code, item_value, item_label, color, sort, item_status, created_at, updated_at) VALUES
  (@base + 1, 'checkin_type', 'image', '图文打卡', '#1677ff', 1, 1, NOW(), NOW()),
  (@base + 2, 'checkin_type', 'voice', '语音打卡', '#faad14', 2, 1, NOW(), NOW()),
  (@base + 3, 'checkin_type', 'video', '视频打卡', '#13c2c2', 3, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE item_label = VALUES(item_label), color = VALUES(color), sort = VALUES(sort), item_status = VALUES(item_status);

-- 3. 同步序列：字典类型 / 字典项 ID 覆盖新增最大值，避免后续发放冲突
SET @t_new := (SELECT IFNULL(MAX(dict_id), 0) + 1 FROM t_dict_types);
UPDATE t_seqs SET current_value = GREATEST(current_value, @t_new) WHERE seq_key = 'dict_type_id';
SET @dmax := (SELECT IFNULL(MAX(item_id), 0) + 1 FROM t_dict_items);
UPDATE t_seqs SET current_value = GREATEST(current_value, @dmax) WHERE seq_key = 'dict_item_id';
