-- ============================================================
-- 升级脚本：收紧学生角色菜单权限（安全审计 S5/S6）
-- 影响表：t_role_menus（删除学生角色对敏感管理菜单的授权）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（DELETE 条件删除，可重复执行）
-- 前置条件：无
-- 说明：
--   1. 学生角色仅保留学习相关菜单（学习仪表盘 / 待办 / 任务管理 / 卡片任务 / 合集管理），
--      不再授权以下敏感管理菜单（跨家庭绑定 / 枚举全部打卡与成员）：
--         - /module/task_checkins  打卡管理（含图片/语音/视频/审核备注）
--         - /module/lp_students    绑定管理（openid↔账号映射）
--         - /module/lp_children    孩子档案（跨家庭绑定操作）
--         - /module/lp_family_members 家属关系
--   2. 与 admin.js 中 STUDENT_MENU_PATHS 默认种子保持一致；全新部署见 init_data.sql
--   3. 该脚本仅收紧菜单，不删除任何数据
-- ============================================================

-- 按 menu_path 删除学生角色的敏感菜单授权（兼容任意 menu_id 部署）
DELETE rm FROM t_role_menus rm
INNER JOIN t_menus m ON m.menu_id = rm.menu_id
WHERE rm.role_code = 'student'
  AND m.menu_path IN ('/module/task_checkins', '/module/lp_students', '/module/lp_children', '/module/lp_family_members');

-- 兜底：若菜单表缺路径但已按 menu_id 授权（历史固定 ID），按 id 再清一次
DELETE FROM t_role_menus
WHERE role_code = 'student' AND menu_id IN (7, 31, 36, 37);
