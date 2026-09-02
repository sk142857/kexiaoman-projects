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
  (4, 'family', '家属', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5, 'personal', '个人', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
  (39, 5, '任务管理（卡片模式）', '/module/card_tasks', 'ProfileOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (7, 5, '打卡管理', '/module/task_checkins', 'CalendarOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (28, 5, '合集管理', '/module/task_collections', 'FolderOutlined', 6, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (46, 5, '科目管理', '/module/subjects', 'BookOutlined', 7, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 3. 成员管理（前台菜单为两层结构，叶子直接挂在分组下）
  (8, 0, '成员管理', '/members', 'UserOutlined', 3, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (40, 8, '家庭关系', '/module/lp_family_tree', 'ApartmentOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (36, 8, '孩子档案', '/module/lp_children', 'SolutionOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (37, 8, '家属关系', '/module/lp_family_members', 'HeartOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (31, 8, '绑定管理', '/module/lp_students', 'LinkOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (38, 8, '邀请码管理', '/module/lp_invites', 'KeyOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9, 8, '用户管理', '/module/users', 'UserOutlined', 6, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (45, 8, '注销管理', '/module/account_cancellations', 'StopOutlined', 7, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (51, 8, '数据清理', '/module/data_clean', 'ClearOutlined', 8, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (50, 8, '物理清除审计', '/module/staff_purges', 'DeleteOutlined', 9, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 4. 消息通知
  (19, 0, '消息通知', '/message', 'BellOutlined', 4, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (32, 19, '订阅授权', '/module/subscribe_grants', 'BellOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (33, 19, '发送记录', '/module/subscribe_sends', 'SendOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (42, 19, '通知模板', '/module/notify_templates', 'FormOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (43, 19, '系统通知', '/module/notifications', 'BellOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 5. 系统监控
  (15, 0, '系统监控', '/ops', 'FundOutlined', 5, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (16, 15, '服务监控', '/module/monitors', 'MonitorOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (17, 15, '接口链路', '/module/traces', 'ApiOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (18, 15, '会话画像', '/module/sessions', 'MobileOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (21, 15, '用户事件', '/module/user_events', 'ThunderboltOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (20, 15, '图片上传记录', '/module/file_uploads', 'PictureOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (41, 15, '内容安全', '/module/content_audits', 'SafetyOutlined', 6, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (47, 15, '错误日志', '/module/system_error_logs', 'BugOutlined', 7, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- 6. 系统设置
  (22, 0, '系统设置', '/system', 'SettingOutlined', 6, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (23, 22, '管理员管理', '/module/staff', 'SafetyOutlined', 1, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (24, 22, '角色管理', '/module/roles', 'TeamOutlined', 2, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (25, 22, '菜单管理', '/module/menus', 'MenuOutlined', 3, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (26, 22, '数据字典', '/module/dicts', 'DatabaseOutlined', 4, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (27, 22, '序列管理', '/module/seqs', 'OrderedListOutlined', 5, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (29, 22, '操作审计', '/module/staff_events', 'AuditOutlined', 6, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (30, 22, '小程序配置', '/module/apps', 'AppstoreOutlined', 7, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (44, 22, '系统参数', '/module/system_params', 'SlidersOutlined', 8, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path), parent_id = VALUES(parent_id);

-- 3. 角色-菜单（按 menu_id 关联，分组调整后关联保持不变）
--    管理员：全部菜单；学生：学习仪表盘 + 学习管理（待办/任务/卡片任务/合集，不含打卡管理/绑定管理等敏感数据）；
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
  (35, 'student', 28, CURRENT_TIMESTAMP),
  (36, 'student', 1,  CURRENT_TIMESTAMP),
  (37, 'student', 4,  CURRENT_TIMESTAMP),
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
  (60, 'admin', 38, CURRENT_TIMESTAMP),
  (61, 'admin', 39, CURRENT_TIMESTAMP),
  (62, 'student', 39, CURRENT_TIMESTAMP),
  (63, 'parent', 39, CURRENT_TIMESTAMP),
  (64, 'family', 39, CURRENT_TIMESTAMP),
  (65, 'admin', 40, CURRENT_TIMESTAMP),
  (66, 'admin', 41, CURRENT_TIMESTAMP),
  (67, 'admin', 42, CURRENT_TIMESTAMP),
  (68, 'admin', 43, CURRENT_TIMESTAMP),
  (69, 'admin', 44, CURRENT_TIMESTAMP),
  (70, 'admin', 45, CURRENT_TIMESTAMP),
  (71, 'admin', 46, CURRENT_TIMESTAMP),
  (72, 'student', 46, CURRENT_TIMESTAMP),
  (73, 'parent', 46, CURRENT_TIMESTAMP),
  (74, 'family', 46, CURRENT_TIMESTAMP),
  (75, 'admin', 47, CURRENT_TIMESTAMP),
  (76, 'admin', 50, CURRENT_TIMESTAMP),
  (77, 'admin', 51, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 4. 数据字典
INSERT INTO t_dict_types (dict_id, dict_code, dict_name, dict_status, created_at, updated_at) VALUES
  (1, 'subject', '科目', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 'gender', '性别', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 'task_status', '任务状态', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4, 'checkin_type', '打卡方式', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE dict_name = VALUES(dict_name);

INSERT INTO t_dict_items (item_id, dict_code, item_value, item_label, color, sort, item_status, created_at, updated_at) VALUES
  (1,  'subject', '语文', '语文', '', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2,  'subject', '数学', '数学', '', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3,  'subject', '英语', '英语', '', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4,  'subject', '阅读', '阅读', '', 4, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5,  'subject', '作业', '作业', '', 5, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6,  'subject', '运动', '运动', '', 6, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (7,  'gender', '0', '保密', '', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8,  'gender', '1', '男', '', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9,  'gender', '2', '女', '', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 'task_status', 'todo', '待完成', '#f5222d', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 'task_status', 'doing', '进行中', '#1677ff', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (12, 'task_status', 'done', '已完成', '#52c41a', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (13, 'checkin_type', 'image', '图文打卡', '#1677ff', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (14, 'checkin_type', 'voice', '语音打卡', '#faad14', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (15, 'checkin_type', 'video', '视频打卡', '#13c2c2', 3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE item_label = VALUES(item_label), color = VALUES(color);

-- 5. 系统通知模板（类型 × 角色，占位符 {xxx} 由业务变量渲染；后台「消息通知 → 通知模板」可改）
INSERT INTO t_lp_notify_templates
  (template_id, app_id, code, name, target_role, title_tmpl, content_tmpl, enabled, sort, created_at, updated_at) VALUES
  (1,  'miniprogram-kxm', 'checkin_approved',   '打卡审核通过',   'student', '打卡审核通过', '你的打卡「{taskTitle}」已审核通过，获得 {score} 积分，任务已完成，继续保持！', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2,  'miniprogram-kxm', 'checkin_approved',   '打卡审核通过',   'parent',  '打卡审核通过', '孩子「{childName}」的打卡「{taskTitle}」已审核通过，获得 {score} 积分，任务已完成。', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3,  'miniprogram-kxm', 'checkin_approved',   '打卡审核通过',   'family',  '打卡审核通过', '孩子「{childName}」的打卡「{taskTitle}」已审核通过，获得 {score} 积分，任务已完成。', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (4,  'miniprogram-kxm', 'checkin_rejected',   '打卡审核不通过', 'student', '打卡审核不通过', '你的打卡「{taskTitle}」未通过审核：{note}。请修改后重新提交。', 1, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (5,  'miniprogram-kxm', 'checkin_rejected',   '打卡审核不通过', 'parent',  '打卡审核不通过', '孩子「{childName}」的打卡「{taskTitle}」未通过审核：{note}。请提醒孩子修改后重新提交。', 1, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (6,  'miniprogram-kxm', 'checkin_rejected',   '打卡审核不通过', 'family',  '打卡审核不通过', '孩子「{childName}」的打卡「{taskTitle}」未通过审核：{note}。请提醒孩子修改后重新提交。', 1, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (7,  'miniprogram-kxm', 'content_violation',  '内容违规',       'student', '内容违规提醒', '你提交的「{bizName}」内容未通过安全检测，涉及违规内容，已被系统拦截，请修改后重新提交。', 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (8,  'miniprogram-kxm', 'content_violation',  '内容违规',       'parent',  '内容违规提醒', '孩子「{childName}」提交的「{bizName}」内容未通过安全检测，涉及违规内容，已被系统拦截，请关注并引导孩子。', 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (9,  'miniprogram-kxm', 'content_violation',  '内容违规',       'family',  '内容违规提醒', '孩子「{childName}」提交的「{bizName}」内容未通过安全检测，涉及违规内容，已被系统拦截，请关注并引导孩子。', 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (10, 'miniprogram-kxm', 'checkin_submitted',  '新打卡待审核',   'parent',  '新打卡待审核', '孩子「{childName}」提交了「{taskTitle}」（{checkinDate}）的打卡，请及时审核。', 1, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (11, 'miniprogram-kxm', 'checkin_submitted',  '新打卡待审核',   'family',  '新打卡待审核', '孩子「{childName}」提交了「{taskTitle}」（{checkinDate}）的打卡，请及时审核。', 1, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (12, 'miniprogram-kxm', 'task_assigned',      '新任务派发',     'student', '新任务派发', '「{assignerName}」给你布置了新任务「{taskTitle}」，记得按时完成哦。', 1, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (13, 'miniprogram-kxm', 'task_done',          '任务完成',       'parent',  '任务完成', '孩子「{childName}」已完成任务「{taskTitle}」，获得 {score} 积分，太棒了！', 1, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (14, 'miniprogram-kxm', 'task_done',          '任务完成',       'family',  '任务完成', '孩子「{childName}」已完成任务「{taskTitle}」，获得 {score} 积分，太棒了！', 1, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (15, 'miniprogram-kxm', 'task_done',          '任务完成',       'student', '任务完成', '你已完成任务「{taskTitle}」，获得 {score} 积分，太棒了！', 1, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE
    code = VALUES(code), name = VALUES(name), target_role = VALUES(target_role),
    title_tmpl = VALUES(title_tmpl), content_tmpl = VALUES(content_tmpl),
    enabled = VALUES(enabled), sort = VALUES(sort);

-- 6. 序列初始化（current_value = 种子数据最大编号 + 1；batch = 号段大小，日志类 500，其余 200）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at) VALUES
  ('task_id', '任务ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('task_checkin_id', '任务打卡ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('collection_id', '合集ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('subject_id', '科目ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('task_timeline_event_id', '任务时间轴事件ID', 1, 1, 1, 500, CURRENT_TIMESTAMP),
  ('point_log_id', '积分流水ID', 1, 1, 1, 500, CURRENT_TIMESTAMP),
  ('subscribe_grant_id', '订阅授权ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('subscribe_send_id', '订阅发送ID', 1, 1, 1, 500, CURRENT_TIMESTAMP),
  ('content_audit_id', '内容审核ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('template_id', '通知模板ID', 16, 1, 1, 200, CURRENT_TIMESTAMP),
  ('notify_id', '系统通知ID', 1, 1, 1, 500, CURRENT_TIMESTAMP),
  ('invite_id', '邀请码ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('child_id', '孩子档案ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('staff_id', '管理员ID', 9002, 9001, 1, 200, CURRENT_TIMESTAMP),
  ('role_id', '角色ID', 6, 1, 1, 200, CURRENT_TIMESTAMP),
  ('menu_id', '菜单ID', 52, 1, 1, 200, CURRENT_TIMESTAMP),
  ('role_menu_id', '角色菜单ID', 78, 1, 1, 200, CURRENT_TIMESTAMP),
  ('dict_type_id', '字典类型ID', 5, 1, 1, 200, CURRENT_TIMESTAMP),
  ('dict_item_id', '字典项ID', 16, 1, 1, 200, CURRENT_TIMESTAMP),
  ('param_id', '系统参数ID', 4, 1, 1, 200, CURRENT_TIMESTAMP),
  ('account_cancel_id', '账号注销申请ID', 1, 1, 1, 200, CURRENT_TIMESTAMP),
  ('purge_id', '物理清除审计ID', 1, 1, 1, 200, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, VALUES(current_value));

-- 6. 系统参数种子（身份选择文案 / 注销说明文案，JSON 集中维护，后台「系统参数」可改）
INSERT INTO t_system_params (param_id, app_id, param_key, param_value, param_type, param_desc, param_status, created_at, updated_at) VALUES
  (1, 'miniprogram-kxm', 'identity_bind_copy', '{"parent":{"name":"我是家长","desc":"创建家庭档案，管理孩子任务与打卡"},"personal":{"name":"我是个人","desc":"创建个人账号，自己发布任务、自己打卡"},"invite":{"name":"我有邀请码","desc":"输入家长或管理员提供的邀请码，绑定孩子或家属身份"}}', 'json', '身份选择页绑定文案（JSON 集中维护）', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 'miniprogram-kxm', 'account_cancel_copy', '{"title":"注销账号","readTitle":"请仔细阅读注销说明","countdownSeconds":10,"notices":["注销后，当前账号的绑定关系将立即解除，无法使用该账号登录课小满。","注销后，该账号下的任务、打卡、积分、徽章等数据将被清除，且不可恢复。","7天注销冷静期内将暂停使用业务功能，只能在本页撤销或等待生效；撤销后恢复正常。"],"risks":["注销属于不可逆操作，请谨慎决定。","若您是家长，注销后您将失去家长管理权限，名下相关邀请码将一并作废。","注销后即使重新绑定，也无法找回已清除的历史数据。"],"immediate":{"label":"立即注销","desc":"立即解除绑定并清除账号数据，即刻生效，不可恢复。"},"grace":{"label":"7天注销","desc":"提交后有7天冷静期，期间暂停使用业务功能，可随时撤销，到期自动注销。"},"pendingTitle":"注销申请待生效","pendingDesc":"冷静期内将暂停使用业务功能，您可随时撤销。","revokeBtn":"撤销注销申请","revokeModalContent":"撤销后账号可继续正常使用，确定撤销吗？"}', 'json', '注销账号说明文案（JSON 集中维护）', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (3, 'miniprogram-kxm', 'subject_presets', '["语文","数学","英语","科学","阅读","写作","作业","运动","音乐","美术","编程","书法","口语"]', 'json', '科目预置列表（JSON 数组；用户在「学习管理 → 科目」中选择创建，不自动初始化）', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), param_type = VALUES(param_type),
    param_desc = VALUES(param_desc), param_status = VALUES(param_status);

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
