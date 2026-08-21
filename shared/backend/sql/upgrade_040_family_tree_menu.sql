-- ============================================================
-- 升级脚本：新增「家庭关系」树形视图菜单（/module/lp_family_tree）并授权管理员
-- 影响表：t_menus（新增 menu_id=40）、t_role_menus（admin 授权）、t_seqs（menu_id/role_menu_id 同步）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（ON DUPLICATE KEY UPDATE / INSERT IGNORE / GREATEST 覆盖，可重复执行）
-- 前置条件：无（纯新增菜单，不动既有数据）
-- 说明：需同步更新 init_data.sql / init_menus.sql（保持菜单种子一致）；后台 DEFAULT_MENU_GROUPS 已含
-- ============================================================

-- 1. 新增菜单 40「家庭关系」（成员管理分组 parent_id=8，排在邀请码管理之后）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (40, 8, '家庭关系', '/module/lp_family_tree', 'ApartmentOutlined', 6, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 2. 角色授权：仅管理员（家庭关系含全家敏感信息，不授权学生/家长/家属）
--    uk_role_menu 唯一键 + INSERT IGNORE 保证幂等
SET @rm_max := (SELECT IFNULL(MAX(id), 0) FROM t_role_menus);
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT @rm_max + 1, 'admin', 40, NOW();

-- 3. 同步序列：菜单 / 角色菜单 id 覆盖新增最大值，避免后续发放冲突
SET @m_max := (SELECT IFNULL(MAX(menu_id), 0) + 1 FROM t_menus);
UPDATE t_seqs SET current_value = GREATEST(current_value, @m_max) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, @rm_max + 2) WHERE seq_key = 'role_menu_id';
