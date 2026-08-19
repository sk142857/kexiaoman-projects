-- ============================================================
-- 升级脚本：新增「任务管理（卡片模式）」菜单（/module/card_tasks）并授权
-- 影响表：t_menus（新增 menu_id=39）、t_role_menus（admin/student/parent/family 授权）、t_seqs（menu_id/role_menu_id 同步）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（ON DUPLICATE KEY UPDATE / INSERT IGNORE / GREATEST 覆盖，可重复执行）
-- 前置条件：无
-- 说明：需同步更新 init_data.sql / init_menus.sql（保持菜单种子一致）
-- ============================================================

-- 1. 新增菜单 39「任务管理（卡片模式）」（学习管理分组 parent_id=5，排任务管理之后）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (39, 5, '任务管理（卡片模式）', '/module/card_tasks', 'ProfileOutlined', 4, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 2. 打卡管理 / 合集管理排序顺延（7: 4->5, 28: 5->6），保持与种子一致（幂等：仅原排序时更新）
UPDATE t_menus SET sort = 5, updated_at = NOW() WHERE menu_id = 7 AND sort = 4;
UPDATE t_menus SET sort = 6, updated_at = NOW() WHERE menu_id = 28 AND sort = 5;

-- 3. 角色授权：与「任务管理」同等权限，admin/student/parent/family 均授权菜单 39
--    uk_role_menu 唯一键 + INSERT IGNORE 保证幂等
SET @rm_max := (SELECT IFNULL(MAX(id), 0) FROM t_role_menus);
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT @rm_max + 1, 'admin',   39, NOW()
UNION ALL SELECT @rm_max + 2, 'student', 39, NOW()
UNION ALL SELECT @rm_max + 3, 'parent',  39, NOW()
UNION ALL SELECT @rm_max + 4, 'family',  39, NOW();

-- 4. 同步序列：菜单 / 角色菜单 id 覆盖新增最大值，避免后续发放冲突
SET @m_max := (SELECT IFNULL(MAX(menu_id), 0) + 1 FROM t_menus);
UPDATE t_seqs SET current_value = GREATEST(current_value, @m_max) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, @rm_max + 5) WHERE seq_key = 'role_menu_id';
