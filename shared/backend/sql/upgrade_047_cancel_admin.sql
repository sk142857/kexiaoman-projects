-- ============================================================
-- 047 后台用户注销管理模块 + 身份选择三卡片文案
-- 变更：
--  1) 新增后台菜单：成员管理 → 注销管理（menu_id=45，仅 admin）
--  2) 角色-菜单：admin 授权菜单 45（role_menu_id=70）
--  3) 系统参数 identity_bind_copy 更新为三卡片文案（我是家长/我是个人/我有邀请码）
-- 影响表：t_menus / t_role_menus / t_system_params / t_seqs
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（可重复执行）
-- 前置条件：需先执行 upgrade_046_personal_cancel_params.sql（注销功能上线，含 t_lp_account_cancellations 表）
-- 需同步：shared/backend/sql/init_data.sql / init_menus.sql
-- ============================================================

-- 1. 后台菜单：成员管理(8) → 注销管理(45)，仅 admin
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (45, 8, '注销管理', '/module/account_cancellations', 'StopOutlined', 7, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 2. 角色-菜单：仅 admin 授权注销管理
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 70, 'admin', 45, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 3. 系统参数 identity_bind_copy 更新为三卡片文案（我是家长/我是个人/我有邀请码）
INSERT INTO t_system_params (param_id, app_id, param_key, param_value, param_type, param_desc, param_status, created_at, updated_at) VALUES
  (1, 'miniprogram-kxm', 'identity_bind_copy', '{"parent":{"name":"我是家长","desc":"创建家庭档案，管理孩子任务与打卡"},"personal":{"name":"我是个人","desc":"创建个人账号，自己发布任务、自己打卡"},"invite":{"name":"我有邀请码","desc":"输入家长或管理员提供的邀请码，绑定孩子或家属身份"}}', 'json', '身份选择页绑定文案（JSON 集中维护）', 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), param_type = VALUES(param_type),
    param_desc = VALUES(param_desc), param_status = VALUES(param_status);

-- 4. 序列同步（menu_id / role_menu_id 覆盖新菜单）
UPDATE t_seqs SET current_value = GREATEST(current_value, 46) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 71) WHERE seq_key = 'role_menu_id';
