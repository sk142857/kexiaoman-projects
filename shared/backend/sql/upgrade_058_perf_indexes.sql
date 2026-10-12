-- ============================================================
-- 升级脚本：性能索引补充（慢查询专项）
-- 影响表：t_lp_task_checkins / t_lp_children / t_staff / t_lp_family_members /
--         t_lp_notifications / t_lp_tasks / t_lp_students /
--         t_lp_subscribe_grants / t_lp_subscribe_sends / t_lp_invites /
--         t_staff_events / t_api_trace
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断索引是否存在，可重复执行）
-- 说明：补齐热门查询的复合索引，消除全表扫描与文件排序（filesort）。
--       与 init_schema.sql 保持一致（新建库时同步包含）。
-- ============================================================

SET @db := DATABASE();

-- 以下为幂等执行块（逐条判断索引是否存在，不存在才新增）

-- 1.1 t_lp_task_checkins.idx_review_created_at (review_status, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND index_name = 'idx_review_created_at');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_task_checkins ADD KEY idx_review_created_at (review_status, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 1.2 t_lp_task_checkins.idx_created_by_date (created_by, checkin_date)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND index_name = 'idx_created_by_date');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_task_checkins ADD KEY idx_created_by_date (created_by, checkin_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 1.3 t_lp_task_checkins.idx_task_created (task_id, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND index_name = 'idx_task_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_task_checkins ADD KEY idx_task_created (task_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2.1 t_lp_children.idx_parent_status (parent_staff_id, child_status)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_children' AND index_name = 'idx_parent_status');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_children ADD KEY idx_parent_status (parent_staff_id, child_status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2.2 t_lp_children.idx_student_status (student_staff_id, child_status)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_children' AND index_name = 'idx_student_status');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_children ADD KEY idx_student_status (student_staff_id, child_status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3.1 t_staff.idx_role_status (staff_role, staff_status)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_staff' AND index_name = 'idx_role_status');
SET @sql := IF(@has = 0, 'ALTER TABLE t_staff ADD KEY idx_role_status (staff_role, staff_status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4.1 t_lp_family_members.idx_member_status (member_staff_id, member_status)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_family_members' AND index_name = 'idx_member_status');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_family_members ADD KEY idx_member_status (member_staff_id, member_status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4.2 t_lp_family_members.idx_owner_status (owner_staff_id, member_status)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_family_members' AND index_name = 'idx_owner_status');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_family_members ADD KEY idx_owner_status (owner_staff_id, member_status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5.1 t_lp_notifications.idx_staff_app_created (staff_id, app_id, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_notifications' AND index_name = 'idx_staff_app_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_notifications ADD KEY idx_staff_app_created (staff_id, app_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6.1 t_lp_tasks.idx_status_updated (task_status, updated_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_tasks' AND index_name = 'idx_status_updated');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_tasks ADD KEY idx_status_updated (task_status, updated_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6.2 t_lp_tasks.idx_created_by_created (created_by, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_tasks' AND index_name = 'idx_created_by_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_tasks ADD KEY idx_created_by_created (created_by, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 7.1 t_lp_students.idx_app_bound (app_id, bound_status, staff_id)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_students' AND index_name = 'idx_app_bound');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_students ADD KEY idx_app_bound (app_id, bound_status, staff_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 8.1 t_lp_subscribe_grants.idx_staff_created (staff_id, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_subscribe_grants' AND index_name = 'idx_staff_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_subscribe_grants ADD KEY idx_staff_created (staff_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 9.1 t_lp_subscribe_sends.idx_app_created (app_id, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_subscribe_sends' AND index_name = 'idx_app_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_subscribe_sends ADD KEY idx_app_created (app_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 10.1 t_lp_invites.idx_owner_status (owner_staff_id, status)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_lp_invites' AND index_name = 'idx_owner_status');
SET @sql := IF(@has = 0, 'ALTER TABLE t_lp_invites ADD KEY idx_owner_status (owner_staff_id, status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 11.1 t_staff_events.idx_app_staff_created (app_id, staff_id, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_staff_events' AND index_name = 'idx_app_staff_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_staff_events ADD KEY idx_app_staff_created (app_id, staff_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 12.1 t_api_trace.idx_status_created (trace_status, created_at)
SET @has := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = @db AND table_name = 't_api_trace' AND index_name = 'idx_status_created');
SET @sql := IF(@has = 0, 'ALTER TABLE t_api_trace ADD KEY idx_status_created (trace_status, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
