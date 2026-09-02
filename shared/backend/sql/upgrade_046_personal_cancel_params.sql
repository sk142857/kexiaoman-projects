-- ============================================================
-- 046 个人身份 + 账号注销 + 系统参数模块
-- 新增：
--  1) t_system_params         系统参数表（常量维护，支持 JSON 文案集中维护）
--  2) t_lp_account_cancellations 账号注销申请表（家长/个人，立即/7天）
--  3) t_roles 新增「个人」角色（role_code=personal）
--  4) 后台菜单：系统设置 → 系统参数（menu_id=44，仅 admin）
--  5) 系统参数种子（identity_bind_copy / account_cancel_copy）
-- 幂等可重复执行。部署顺序：本脚本 → 重新部署云托管。
-- 需同步：shared/backend/sql/init_schema.sql / init_data.sql / init_menus.sql
-- ============================================================

-- 1. 系统参数表（共享系统表 t_，按 app 维度隔离；主键由序列 param_id 发放）
CREATE TABLE IF NOT EXISTS t_system_params (
  param_id     BIGINT       NOT NULL COMMENT '参数ID（seqs 发放）',
  app_id       VARCHAR(32)  NOT NULL DEFAULT 'miniprogram-kxm' COMMENT '所属小程序 app_id',
  param_key    VARCHAR(64)  NOT NULL COMMENT '参数键（如 identity_bind_copy / account_cancel_copy）',
  param_value  TEXT         NULL COMMENT '参数值（字符串或 JSON 文本）',
  param_type   VARCHAR(16)  NOT NULL DEFAULT 'string' COMMENT '值类型 string/json',
  param_desc   VARCHAR(255) NOT NULL DEFAULT '' COMMENT '参数说明',
  param_status TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (param_id),
  UNIQUE KEY uk_app_key (app_id, param_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统参数（常量维护，支持 JSON 文案集中维护）';

-- 2. 账号注销申请表（课小满业务表；家长/个人可申请注销）
CREATE TABLE IF NOT EXISTS t_lp_account_cancellations (
  cancel_id    BIGINT      NOT NULL COMMENT '注销申请ID（seqs 发放）',
  app_id       VARCHAR(32) NOT NULL DEFAULT 'miniprogram-kxm' COMMENT '所属小程序 app_id',
  staff_id     BIGINT      NOT NULL DEFAULT 0 COMMENT '申请注销的账号 staff_id',
  openid       VARCHAR(64) NOT NULL DEFAULT '' COMMENT '申请人 openid',
  mode         VARCHAR(16) NOT NULL DEFAULT 'grace' COMMENT '注销模式 immediate 立即 / grace 7天冷静期',
  status       VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending 待生效 / executed 已注销 / cancelled 已撤销',
  requested_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '申请时间',
  effective_at DATETIME    NULL COMMENT '生效时间（grace 模式=申请+7天）',
  executed_at  DATETIME    NULL COMMENT '实际执行注销时间',
  cancelled_at DATETIME    NULL COMMENT '撤销时间',
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (cancel_id),
  KEY idx_openid_status (app_id, openid, status),
  KEY idx_status_effective (status, effective_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='账号注销申请（家长/个人）';

-- 3. 新增「个人」角色（role_code=personal，role_id=5）
INSERT INTO t_roles (role_id, role_code, role_name, role_status, created_at, updated_at) VALUES
  (5, 'personal', '个人', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE role_name = VALUES(role_name);

-- 4. 后台菜单：系统设置(22) → 系统参数(44)，仅 admin
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (44, 22, '系统参数', '/module/system_params', 'SlidersOutlined', 8, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 5. 角色-菜单：仅 admin 授权系统参数
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 69, 'admin', 44, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 6. 系统参数种子（幂等）
INSERT INTO t_system_params (param_id, app_id, param_key, param_value, param_type, param_desc, param_status, created_at, updated_at) VALUES
  (1, 'miniprogram-kxm', 'identity_bind_copy', '{"parent":{"name":"我是家长","desc":"创建家庭档案，管理孩子任务与打卡"},"personal":{"name":"我是个人","desc":"创建个人账号，自己发布任务、自己打卡"},"invite":{"name":"我有邀请码","desc":"输入家长或管理员提供的邀请码，绑定孩子或家属身份"}}', 'json', '身份选择页绑定文案（JSON 集中维护）', 1, NOW(), NOW()),
  (2, 'miniprogram-kxm', 'account_cancel_copy', '{"title":"注销账号","readTitle":"请仔细阅读注销说明","countdownSeconds":10,"notices":["注销后，当前账号的绑定关系将立即解除，无法使用该账号登录课小满。","注销后，该账号下的任务、打卡、积分、徽章等数据将被清除，且不可恢复。","7天注销冷静期内将暂停使用业务功能，只能在本页撤销或等待生效；撤销后恢复正常。"],"risks":["注销属于不可逆操作，请谨慎决定。","若您是家长，注销后您将失去家长管理权限，名下相关邀请码将一并作废。","注销后即使重新绑定，也无法找回已清除的历史数据。"],"immediate":{"label":"立即注销","desc":"立即解除绑定并清除账号数据，即刻生效，不可恢复。"},"grace":{"label":"7天注销","desc":"提交后有7天冷静期，期间暂停使用业务功能，可随时撤销，到期自动注销。"},"pendingTitle":"注销申请待生效","pendingDesc":"冷静期内将暂停使用业务功能，您可随时撤销。","revokeBtn":"撤销注销申请","revokeModalContent":"撤销后账号可继续正常使用，确定撤销吗？"}', 'json', '注销账号说明文案（JSON 集中维护）', 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), param_type = VALUES(param_type),
    param_desc = VALUES(param_desc), param_status = VALUES(param_status);

-- 7. 序列同步（保证后续发放不与既有记录冲突）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at) VALUES
  ('param_id', '系统参数ID', 3, 1, 1, 200, NOW())
  ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, 3);
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at) VALUES
  ('account_cancel_id', '账号注销申请ID', 1, 1, 1, 200, NOW())
  ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, 1);
UPDATE t_seqs SET current_value = GREATEST(current_value, 6) WHERE seq_key = 'role_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 45) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 70) WHERE seq_key = 'role_menu_id';
