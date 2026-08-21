-- ============================================================
-- 升级脚本：内容安全管理菜单（t_menus / t_role_menus）
-- 影响表：t_menus（新增 menu_id=41）、t_role_menus（admin 授权 id=66）、t_seqs（menu_id/role_menu_id 同步）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（INSERT ... ON DUPLICATE KEY UPDATE；seqs GREATEST）
-- 说明：
--   1. 「内容安全」为只读查看页（/module/content_audits），挂在「系统监控」分组（menu_id=15）下，
--      仅 admin 角色可见。
--   2. 前置条件：需先执行 upgrade_037_content_audit.sql（t_content_audits 建表）。
--   3. 需同步更新 init_data.sql / init_menus.sql 与 routes/admin.js DEFAULT_MENU_GROUPS。
-- ============================================================

-- 1. 菜单（系统监控 15 分组下的叶子，sort=6）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (41, 15, '内容安全', '/module/content_audits', 'SafetyOutlined', 6, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path), parent_id = VALUES(parent_id), sort = VALUES(sort);

-- 2. 角色-菜单（仅 admin）
INSERT INTO t_role_menus (id, role_code, menu_id, created_at) VALUES
  (66, 'admin', 41, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 3. 序列同步（保证后续新菜单/角色菜单不与既有记录冲突）
UPDATE t_seqs SET current_value = GREATEST(current_value, 42) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 67) WHERE seq_key = 'role_menu_id';
