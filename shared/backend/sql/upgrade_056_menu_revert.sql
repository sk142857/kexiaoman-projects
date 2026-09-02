-- ============================================================
-- 课小满 回退「成员管理二级分组」（曾执行 upgrade_055_menu_regroup.sql 的库执行本脚本）
-- 原因：后台前端菜单渲染为两层结构（分组→叶子），二级分组会把分组当叶子跳转到无路由路径，导致点击无页面。
-- 作用：把成员管理叶子改回 parent_id=8；删除二级分组 52/53 及其 admin 授权。
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行；幂等。
-- 全新部署走 init_data.sql 已是平铺结构，无需本脚本。
-- ============================================================

SET NAMES utf8mb4;

-- 1. 叶子改回成员管理(8)（按新顺序：关系类在前，账号/清理类在后）
UPDATE t_menus SET parent_id = 8,
  sort = CASE menu_id
    WHEN 40 THEN 1 WHEN 36 THEN 2 WHEN 37 THEN 3 WHEN 31 THEN 4 WHEN 38 THEN 5
    WHEN 9 THEN 6 WHEN 45 THEN 7 WHEN 51 THEN 8 WHEN 50 THEN 9 ELSE sort END
WHERE menu_id IN (9, 31, 36, 37, 38, 40, 45, 50, 51);

-- 2. 删除二级分组与授权（幂等：不存在不影响）
DELETE FROM t_role_menus WHERE role_code = 'admin' AND menu_id IN (52, 53);
DELETE FROM t_menus WHERE menu_id IN (52, 53);
