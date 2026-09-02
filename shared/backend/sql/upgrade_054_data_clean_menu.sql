-- ============================================================
-- 课小满 后台「数据清理」菜单（处理历史脏数据：孤儿绑定/邀请码/家庭/空壳账号）
-- 影响：t_menus + t_role_menus（menu_id=51，admin 授权）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行；幂等。
-- ============================================================

SET NAMES utf8mb4;

-- 1. 菜单：成员管理(8) → 数据清理
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at)
VALUES (51, 8, '数据清理', '/module/data_clean', 'ClearOutlined', 9, 2, 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path), parent_id = VALUES(parent_id);

-- 2. 管理员角色授权该菜单（幂等：INSERT IGNORE 重复执行不报错）
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT COALESCE(MAX(id), 0) + 1, 'admin', 51, NOW() FROM t_role_menus
WHERE NOT EXISTS (SELECT 1 FROM t_role_menus WHERE role_code = 'admin' AND menu_id = 51);

-- 3. 序列覆盖新菜单 id
UPDATE t_seqs SET current_value = GREATEST(current_value, 52) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, (SELECT COALESCE(MAX(id),0) + 1 FROM t_role_menus)) WHERE seq_key = 'role_menu_id';
