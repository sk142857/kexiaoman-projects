-- ============================================================
-- 049 系统错误日志表 + 后台菜单（错误异常统一入库，类似 Java logger.error）
-- 新增：
--  1) t_system_error_logs            系统错误日志表（errorLog.js 统一写入）
--  2) 后台菜单：系统监控 → 错误日志(47) + admin 角色授权
-- 幂等可重复执行。部署顺序：本脚本 → 重新部署云托管。
-- 需同步：shared/backend/sql/init_schema.sql / init_data.sql / init_menus.sql、
--         routes/admin.js DEFAULT_MENU_GROUPS、tables.js、errorLog.js
-- ============================================================

-- 1. 系统错误日志表（主键为时间戳+随机，无序列；按 created_at 倒序查询）
CREATE TABLE IF NOT EXISTS t_system_error_logs (
  log_id     VARCHAR(24)  NOT NULL COMMENT '错误日志ID（时间戳+随机）',
  app_id     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '小程序 app_id（空=全局）',
  openid     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '用户 openid（无则空）',
  level      VARCHAR(16)  NOT NULL DEFAULT 'error' COMMENT '级别：error/warn/info',
  module     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '来源模块（如 lp、admin/users、global）',
  api_path   VARCHAR(200) NOT NULL DEFAULT '' COMMENT '接口路径（无则空）',
  error_code INT          NOT NULL DEFAULT 500 COMMENT '错误码（HTTP/业务）',
  message    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '错误信息摘要',
  stack      TEXT         NULL COMMENT '错误堆栈（截断 4000）',
  detail     TEXT         NULL COMMENT '附加详情（JSON，脱敏后）',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
  PRIMARY KEY (log_id),
  KEY idx_created (created_at),
  KEY idx_level (level),
  KEY idx_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统错误日志';

-- 2. 菜单：系统监控(15) → 错误日志(47)（sort=7，内容安全之后）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (47, 15, '错误日志', '/module/system_error_logs', 'BugOutlined', 7, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 3. 角色-菜单（仅 admin）
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 75, 'admin', 47, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 4. 序列同步
UPDATE t_seqs SET current_value = GREATEST(current_value, 48) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 76) WHERE seq_key = 'role_menu_id';
