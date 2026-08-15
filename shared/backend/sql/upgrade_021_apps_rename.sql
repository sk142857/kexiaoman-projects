-- ============================================================
-- 升级脚本：小程序 app_id 标识统一从 learning-planet 改为 miniprogram-kxm
-- 影响表：t_apps / t_staff_apps / t_users / t_user_sessions / t_file_uploads /
--         t_user_events / t_lp_students / t_lp_invites / t_lp_children /
--         t_lp_family_members / t_lp_subscribe_grants / t_lp_subscribe_sends
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（UPDATE 仅在存在 learning-planet 记录时命中，可重复执行）
-- 前置条件：无（已上线旧库执行；新库直接使用 init_schema/init_data 的 miniprogram-kxm 无需本脚本）
-- 说明：目录与后端代码已同步改为 miniprogram-kxm（apps/miniprogram-kxm/），
--       存量数据需执行本脚本完成 app_id 迁移，否则后台切换器 / 业务隔离会读不到数据。
-- ============================================================

-- 1. 小程序注册表（t_apps.app_id 为主键，miniprogram-kxm 不存在才更新）
UPDATE t_apps SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';

-- 2. 员工-小程序授权
UPDATE t_staff_apps SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';

-- 3. 用户 / 会话 / 事件 / 文件 / 订阅（共享系统表）
UPDATE t_users            SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_user_sessions    SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_user_events      SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_lp_subscribe_sends SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';

-- 4. 课小满业务表（t_lp_*）
UPDATE t_lp_students          SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_lp_invites           SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_lp_children          SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_lp_family_members    SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
UPDATE t_lp_subscribe_grants  SET app_id = 'miniprogram-kxm' WHERE app_id = 'learning-planet';
