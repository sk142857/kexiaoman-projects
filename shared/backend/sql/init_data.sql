-- ============================================================
-- 共享云托管后端 - 初始化数据脚本（DML 种子数据）
-- 前置：需先执行 init_schema.sql 完成建表
-- 执行方式：在数据库管理控制台（DMS）或 mysql 客户端执行本文件
-- 说明：全部语句幂等（INSERT ... ON DUPLICATE KEY UPDATE / INSERT IGNORE），
--       可重复执行，不会产生重复数据
-- 包含：角色 / 菜单 / 角色-菜单 / 数据字典 / 序列 / 超级管理员
--
-- 注意：菜单数据需与 shared/backend/routes/admin.js 的 DEFAULT_MENU_GROUPS 保持一致
--       序列 current_value = 种子数据最大编号 + 1，勿手工改小
-- ============================================================

-- 1. 角色
INSERT INTO t_roles (role_id, role_code, role_name, role_status, created_at, updated_at) VALUES
  (1, 'admin', '管理员', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 'student', '学生', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 'parent', '主家长', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 'family', '家属', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE role_name = VALUES(role_name);

-- 2. 菜单（与 routes/admin.js DEFAULT_MENU_GROUPS 保持一致，1~38；menu_id 稳定，role_menus 关联不变）
--    一级分组：仪表盘 / 学习管理 / 成员管理 / 消息通知 / 系统监控 / 系统设置
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  -- 1. 仪表盘
  (1, 0, '仪表盘', '/dashboard', 'DashboardOutlined', 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 1, '监控仪表盘', '/dashboard/monitor', 'LineChartOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 1, '学习仪表盘', '/dashboard/learning', 'BookOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 2. 学习管理
  (5, 0, '学习管理', '/learning', 'ReadOutlined', 2, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (34, 5, '待办任务', '/module/todo_tasks', 'CheckSquareOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (35, 5, '打卡审核', '/module/checkin_reviews', 'AuditOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6, 5, '任务管理', '/module/tasks', 'UnorderedListOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (7, 5, '打卡管理', '/module/task_checkins', 'CalendarOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (28, 5, '合集管理', '/module/task_collections', 'FolderOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 3. 成员管理
  (8, 0, '成员管理', '/members', 'UserOutlined', 3, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 8, '用户管理', '/module/users', 'UserOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (31, 8, '绑定管理', '/module/lp_students', 'LinkOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (36, 8, '孩子档案', '/module/lp_children', 'SolutionOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (37, 8, '家属关系', '/module/lp_family_members', 'HeartOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (38, 8, '邀请码管理', '/module/lp_invites', 'KeyOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 4. 消息通知
  (19, 0, '消息通知', '/message', 'BellOutlined', 4, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (32, 19, '订阅授权', '/module/subscribe_grants', 'BellOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (33, 19, '发送记录', '/module/subscribe_sends', 'SendOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 5. 系统监控
  (15, 0, '系统监控', '/ops', 'FundOutlined', 5, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (16, 15, '服务监控', '/module/monitors', 'MonitorOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (17, 15, '接口链路', '/module/traces', 'ApiOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (18, 15, '会话画像', '/module/sessions', 'MobileOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (21, 15, '用户事件', '/module/user_events', 'ThunderboltOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (20, 15, '图片上传记录', '/module/file_uploads', 'PictureOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 6. 系统设置
  (22, 0, '系统设置', '/system', 'SettingOutlined', 6, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (23, 22, '管理员管理', '/module/staff', 'SafetyOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (24, 22, '角色管理', '/module/roles', 'TeamOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (25, 22, '菜单管理', '/module/menus', 'MenuOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (26, 22, '数据字典', '/module/dicts', 'DatabaseOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (27, 22, '序列管理', '/module/seqs', 'OrderedListOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (29, 22, '操作审计', '/module/staff_events', 'AuditOutlined', 6, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (30, 22, '小程序配置', '/module/apps', 'AppstoreOutlined', 7, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path), parent_id = VALUES(parent_id);

-- 3. 角色-菜单（按 menu_id 关联，分组调整后关联保持不变）
--    管理员：全部菜单；学生：学习仪表盘 + 学习管理（待办/任务/打卡/合集）+ 成员管理·绑定管理；
--    主家长/家属：学习仪表盘 + 学习管理（待办/任务/打卡/合集/审核）+ 成员管理·孩子档案
INSERT INTO t_role_menus (id, role_code, menu_id, created_at) VALUES
  (1,  'admin', 1,  CURRENT_TIMESTAMP), (3,  'admin', 3,  CURRENT_TIMESTAMP),
  (4,  'admin', 4,  CURRENT_TIMESTAMP),
  (5,  'admin', 5,  CURRENT_TIMESTAMP), (6,  'admin', 6,  CURRENT_TIMESTAMP),
  (7,  'admin', 7,  CURRENT_TIMESTAMP), (8,  'admin', 8,  CURRENT_TIMESTAMP),
  (9,  'admin', 9,  CURRENT_TIMESTAMP),
  (15, 'admin', 15, CURRENT_TIMESTAMP), (16, 'admin', 16, CURRENT_TIMESTAMP),
  (17, 'admin', 17, CURRENT_TIMESTAMP), (18, 'admin', 18, CURRENT_TIMESTAMP),
  (19, 'admin', 19, CURRENT_TIMESTAMP), (20, 'admin', 20, CURRENT_TIMESTAMP),
  (21, 'admin', 21, CURRENT_TIMESTAMP), (22, 'admin', 22, CURRENT_TIMESTAMP),
  (23, 'admin', 23, CURRENT_TIMESTAMP), (24, 'admin', 24, CURRENT_TIMESTAMP),
  (25, 'admin', 25, CURRENT_TIMESTAMP), (26, 'admin', 26, CURRENT_TIMESTAMP),
  (27, 'admin', 27, CURRENT_TIMESTAMP), (28, 'admin', 28, CURRENT_TIMESTAMP),
  (29, 'admin', 29, CURRENT_TIMESTAMP),
  (30, 'admin', 30, CURRENT_TIMESTAMP),
  (31, 'admin', 31, CURRENT_TIMESTAMP),
  (32, 'student', 5,  CURRENT_TIMESTAMP),
  (33, 'student', 6,  CURRENT_TIMESTAMP),
  (34, 'student', 7,  CURRENT_TIMESTAMP),
  (35, 'student', 28, CURRENT_TIMESTAMP),
  (36, 'student', 1,  CURRENT_TIMESTAMP),
  (37, 'student', 4,  CURRENT_TIMESTAMP),
  (38, 'student', 31, CURRENT_TIMESTAMP),
  (39, 'admin', 32, CURRENT_TIMESTAMP),
  (40, 'admin', 33, CURRENT_TIMESTAMP),
  (41, 'admin', 34, CURRENT_TIMESTAMP),
  (42, 'admin', 35, CURRENT_TIMESTAMP),
  (43, 'student', 34, CURRENT_TIMESTAMP),
  (44, 'admin', 36, CURRENT_TIMESTAMP),
  (45, 'admin', 37, CURRENT_TIMESTAMP),
  (46, 'parent', 5,  CURRENT_TIMESTAMP),
  (47, 'parent', 6,  CURRENT_TIMESTAMP),
  (48, 'parent', 7,  CURRENT_TIMESTAMP),
  (49, 'parent', 28, CURRENT_TIMESTAMP),
  (50, 'parent', 36, CURRENT_TIMESTAMP),
  (51, 'parent', 34, CURRENT_TIMESTAMP),
  (52, 'parent', 35, CURRENT_TIMESTAMP),
  (53, 'family', 5,  CURRENT_TIMESTAMP),
  (54, 'family', 6,  CURRENT_TIMESTAMP),
  (55, 'family', 7,  CURRENT_TIMESTAMP),
  (56, 'family', 28, CURRENT_TIMESTAMP),
  (57, 'family', 36, CURRENT_TIMESTAMP),
  (58, 'family', 34, CURRENT_TIMESTAMP),
  (59, 'family', 35, CURRENT_TIMESTAMP),
  (60, 'admin', 38, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 4. 数据字典
INSERT INTO t_dict_types (dict_id, dict_code, dict_name, dict_status, created_at, updated_at) VALUES
  (1, 'subject', '科目', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 'gender', '性别', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 'task_status', '任务状态', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE dict_name = VALUES(dict_name);

INSERT INTO t_dict_items (item_id, dict_code, item_value, item_label, sort, item_status, created_at, updated_at) VALUES
  (1,  'subject', '语文', '语文', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2,  'subject', '数学', '数学', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3,  'subject', '英语', '英语', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4,  'subject', '阅读', '阅读', 4, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5,  'subject', '作业', '作业', 5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6,  'subject', '运动', '运动', 6, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (7,  'gender', '0', '保密', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8,  'gender', '1', '男', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9,  'gender', '2', '女', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 'task_status', 'todo', '未开始', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 'task_status', 'doing', '进行中', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (12, 'task_status', 'done', '已完成', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE item_label = VALUES(item_label);

-- 5. 序列初始化（current_value = 种子数据最大编号 + 1；batch = 号段大小，日志类 500，其余 200）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at) VALUES
  ('task_id', '任务ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('task_checkin_id', '任务打卡ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('collection_id', '合集ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('task_timeline_event_id', '任务时间轴事件ID', 1, 1, 1, 500, CURRENT_TIMESTAMP),
  ('subscribe_grant_id', '订阅授权ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('subscribe_send_id', '订阅发送ID', 1, 1, 1, 500, CURRENT_TIMESTAMP),
  ('invite_id', '邀请码ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('child_id', '孩子档案ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('staff_id', '管理员ID', 9002, 9001, 1, 200, CURRENT_TIMESTAMP),
  ('role_id', '角色ID', 5, 1, 1, 200, CURRENT_TIMESTAMP),
  ('menu_id', '菜单ID', 39, 1, 1, 200, CURRENT_TIMESTAMP),
  ('role_menu_id', '角色菜单ID', 61, 1, 1, 200, CURRENT_TIMESTAMP),
  ('dict_type_id', '字典类型ID', 4, 1, 1, 200, CURRENT_TIMESTAMP),
  ('dict_item_id', '字典项ID', 13, 1, 1, 200, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, VALUES(current_value));

-- 6. 初始化超级管理员（sys_admin / sk0987，bcrypt cost10）
--    幂等：已存在 sys_admin 时跳过；显式取 MAX(staff_id)+1，避免与序列冲突
INSERT INTO t_staff
  (staff_id, staff_username, staff_password, staff_nickname, staff_role, staff_status, created_at, updated_at)
SELECT
  COALESCE(MAX(staff_id), 9000) + 1,
  'sys_admin',
  '$2a$10$Yrc42H1ogAmwxSDbQcie3uUAiBRgWl32ZJBklhgcDP99xGxdna2/6',
  '超级管理员',
  'admin',
  1,
  NOW(),
  NOW()
FROM t_staff
WHERE NOT EXISTS (SELECT 1 FROM t_staff WHERE staff_username = 'sys_admin');

-- 同步序列：确保 seqs.staff_id 覆盖新增的管理员 ID，避免后续发放冲突
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at)
SELECT 'staff_id', '管理员ID', COALESCE(MAX(staff_id), 9000) + 1, 9001, 1, 200, NOW()
FROM t_staff
ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, (SELECT MAX(staff_id) FROM t_staff) + 1);

-- 7. 小程序注册表 + 员工-小程序授权（多小程序共享后台；与 apps.js BUILTIN_APPS 保持一致）
--    课小满默认订阅模板（审核结果通知）随种子写入；后台可另行维护 subscribe_tmpl_ids
INSERT INTO t_apps (app_id, app_name, wechat_appid, app_status, subscribe_tmpl_ids, created_at, updated_at) VALUES
  ('miniprogram-kxm', '课小满', 'wxa8035a4cd63554fe', 1, '91HSfOQSSVKHPwT2oNM4NdGuKe9Gw1uY0VkLf_nyJ9I,aIReeE_R92te__wWL7EKRknaZ0pXhSJ2Kcct_rNWzVg', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE app_name = VALUES(app_name), wechat_appid = VALUES(wechat_appid);

-- admin 角色默认拥有全部小程序（幂等；与 upgrade_009_apps.sql 保持一致）
INSERT INTO t_staff_apps (staff_id, app_id, created_at)
SELECT s.staff_id, a.app_id, NOW()
FROM t_staff s CROSS JOIN t_apps a
WHERE s.staff_role = 'admin'
ON DUPLICATE KEY UPDATE staff_id = VALUES(staff_id);

-- 修改管理员密码：用 node 生成 bcrypt 哈希（cost 10）后执行
--   node -e "console.log(require('bcryptjs').hashSync('新密码',10))"
--   UPDATE staff SET staff_password = '<哈希>' WHERE staff_username = 'sys_admin';
