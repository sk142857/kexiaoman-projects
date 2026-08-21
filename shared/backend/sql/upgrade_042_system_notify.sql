-- ============================================================
-- 042 系统通知（站内信，轻量文本；与「订阅消息」完全隔离）
-- 新增：
--  1) t_lp_notify_templates  通知模板（类型 × 角色，占位符模板，管理员可改）
--  2) t_lp_notifications     系统通知记录（按接收人落库，查看即已读）
--  3) 后台菜单：消息通知 → 通知模板(42) / 系统通知(43)
--  4) 角色-菜单（仅 admin）+ 序列
-- 幂等可重复执行。部署顺序：本脚本 → 重新部署云托管。
-- 需同步：shared/backend/sql/init_schema.sql / init_data.sql / init_menus.sql
-- ============================================================

-- 1. 通知模板表（主键由序列 template_id 发放；后台「通知模板」模块维护）
CREATE TABLE IF NOT EXISTS t_lp_notify_templates (
  template_id  BIGINT       NOT NULL COMMENT '模板ID（seqs 发放）',
  app_id       VARCHAR(32)  NOT NULL DEFAULT 'miniprogram-kxm' COMMENT '所属小程序 app_id',
  code         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '通知类型编码（如 checkin_approved/checkin_rejected/content_violation/checkin_submitted/task_assigned/task_done）',
  name         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '模板名称（如 打卡审核通过）',
  target_role  VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '目标角色 student/parent/family（不同角色收到不同文案）',
  title_tmpl   VARCHAR(128) NOT NULL DEFAULT '' COMMENT '标题模板（支持占位符）',
  content_tmpl VARCHAR(500) NOT NULL DEFAULT '' COMMENT '正文模板（支持占位符）',
  enabled      TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0停用（停用后该类型不再发送）',
  sort         INT          NOT NULL DEFAULT 0 COMMENT '排序',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (template_id),
  KEY idx_app_code (app_id, code),
  KEY idx_app_role (app_id, target_role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满系统通知模板';

-- 2. 系统通知记录表（每条 = 一位接收人的一条站内信；查看即已读）
CREATE TABLE IF NOT EXISTS t_lp_notifications (
  notify_id  BIGINT       NOT NULL COMMENT '通知ID（seqs 发放）',
  app_id     VARCHAR(32)  NOT NULL DEFAULT 'miniprogram-kxm' COMMENT '所属小程序 app_id',
  staff_id   BIGINT       NOT NULL DEFAULT 0 COMMENT '接收人账号 staff_id',
  role       VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '接收时角色快照 student/parent/family/admin',
  type       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '通知类型 code（对应模板 code）',
  title      VARCHAR(128) NOT NULL DEFAULT '' COMMENT '渲染后的标题',
  content    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '渲染后的正文（轻量文本）',
  biz_type   VARCHAR(24)  NOT NULL DEFAULT '' COMMENT '业务类型 task/checkin',
  biz_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '业务ID（任务/打卡ID）',
  is_read    TINYINT      NOT NULL DEFAULT 0 COMMENT '是否已读 0未读 1已读',
  read_at    DATETIME     NULL COMMENT '已读时间',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
  PRIMARY KEY (notify_id),
  KEY idx_staff_created (staff_id, created_at),
  KEY idx_staff_read (staff_id, is_read, created_at),
  KEY idx_app_type (app_id, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满系统通知（站内信，与订阅消息隔离）';

-- 3. 默认模板种子（类型 × 角色；占位符 {xxx} 由业务变量渲染）
INSERT INTO t_lp_notify_templates
  (template_id, app_id, code, name, target_role, title_tmpl, content_tmpl, enabled, sort, created_at, updated_at) VALUES
  -- 打卡审核通过
  (1,  'miniprogram-kxm', 'checkin_approved',   '打卡审核通过',   'student', '打卡审核通过', '你的打卡「{taskTitle}」已审核通过，获得 {score} 积分，任务已完成，继续保持！', 1, 1, NOW(), NOW()),
  (2,  'miniprogram-kxm', 'checkin_approved',   '打卡审核通过',   'parent',  '打卡审核通过', '孩子「{childName}」的打卡「{taskTitle}」已审核通过，获得 {score} 积分，任务已完成。', 1, 1, NOW(), NOW()),
  (3,  'miniprogram-kxm', 'checkin_approved',   '打卡审核通过',   'family',  '打卡审核通过', '孩子「{childName}」的打卡「{taskTitle}」已审核通过，获得 {score} 积分，任务已完成。', 1, 1, NOW(), NOW()),
  -- 打卡审核不通过
  (4,  'miniprogram-kxm', 'checkin_rejected',   '打卡审核不通过', 'student', '打卡审核不通过', '你的打卡「{taskTitle}」未通过审核：{note}。请修改后重新提交。', 1, 2, NOW(), NOW()),
  (5,  'miniprogram-kxm', 'checkin_rejected',   '打卡审核不通过', 'parent',  '打卡审核不通过', '孩子「{childName}」的打卡「{taskTitle}」未通过审核：{note}。请提醒孩子修改后重新提交。', 1, 2, NOW(), NOW()),
  (6,  'miniprogram-kxm', 'checkin_rejected',   '打卡审核不通过', 'family',  '打卡审核不通过', '孩子「{childName}」的打卡「{taskTitle}」未通过审核：{note}。请提醒孩子修改后重新提交。', 1, 2, NOW(), NOW()),
  -- 内容违规
  (7,  'miniprogram-kxm', 'content_violation',  '内容违规',       'student', '内容违规提醒', '你提交的「{bizName}」内容未通过安全检测，涉及违规内容，已被系统拦截，请修改后重新提交。', 1, 3, NOW(), NOW()),
  (8,  'miniprogram-kxm', 'content_violation',  '内容违规',       'parent',  '内容违规提醒', '孩子「{childName}」提交的「{bizName}」内容未通过安全检测，涉及违规内容，已被系统拦截，请关注并引导孩子。', 1, 3, NOW(), NOW()),
  (9,  'miniprogram-kxm', 'content_violation',  '内容违规',       'family',  '内容违规提醒', '孩子「{childName}」提交的「{bizName}」内容未通过安全检测，涉及违规内容，已被系统拦截，请关注并引导孩子。', 1, 3, NOW(), NOW()),
  -- 新打卡待审核（家长/家属收）
  (10, 'miniprogram-kxm', 'checkin_submitted',  '新打卡待审核',   'parent',  '新打卡待审核', '孩子「{childName}」提交了「{taskTitle}」（{checkinDate}）的打卡，请及时审核。', 1, 4, NOW(), NOW()),
  (11, 'miniprogram-kxm', 'checkin_submitted',  '新打卡待审核',   'family',  '新打卡待审核', '孩子「{childName}」提交了「{taskTitle}」（{checkinDate}）的打卡，请及时审核。', 1, 4, NOW(), NOW()),
  -- 新任务派发（学生收）
  (12, 'miniprogram-kxm', 'task_assigned',      '新任务派发',     'student', '新任务派发', '「{assignerName}」给你布置了新任务「{taskTitle}」，记得按时完成哦。', 1, 5, NOW(), NOW()),
  -- 任务完成（学生「你」/ 家长·家属「孩子」）
  (13, 'miniprogram-kxm', 'task_done',          '任务完成',       'parent',  '任务完成', '你「{childName}」已完成任务「{taskTitle}」，获得 {score} 积分，太棒了！', 1, 6, NOW(), NOW()),
  (14, 'miniprogram-kxm', 'task_done',          '任务完成',       'family',  '任务完成', '你「{childName}」已完成任务「{taskTitle}」，获得 {score} 积分，太棒了！', 1, 6, NOW(), NOW()),
  (15, 'miniprogram-kxm', 'task_done',          '任务完成',       'student', '任务完成', '你已完成任务「{taskTitle}」，获得 {score} 积分，太棒了！', 1, 6, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    code = VALUES(code), name = VALUES(name), target_role = VALUES(target_role),
    title_tmpl = VALUES(title_tmpl), content_tmpl = VALUES(content_tmpl),
    enabled = VALUES(enabled), sort = VALUES(sort);

-- 4. 菜单（消息通知 19 分组下新增叶子，sort=3/4）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (42, 19, '通知模板', '/module/notify_templates', 'FormOutlined', 3, 2, 1, NOW(), NOW()),
  (43, 19, '系统通知', '/module/notifications',    'BellOutlined', 4, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 5. 角色-菜单：仅 admin（消息通知为系统配置类，学生/家长/家属不开放）
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 67, 'admin', 42, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 68, 'admin', 43, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 6. 序列同步（保证后续发放不与既有记录冲突）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at) VALUES
  ('template_id', '通知模板ID', 16, 1, 1, 200, NOW())
  ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, 16);
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at) VALUES
  ('notify_id', '系统通知ID', 1, 1, 1, 500, NOW())
  ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, 1);
UPDATE t_seqs SET current_value = GREATEST(current_value, 44) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 69) WHERE seq_key = 'role_menu_id';
