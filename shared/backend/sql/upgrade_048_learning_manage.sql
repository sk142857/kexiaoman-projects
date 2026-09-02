-- ============================================================
-- 048 学习管理：科目独立成表 + 合集按 staff_id 归属（主家长管理）
-- 新增：
--  1) t_lp_subjects                 科目表（staff_id 归属，主家长/个人维护）
--  2) t_lp_task_collections.staff_id 合集归属列（回填 created_by，主家长/个人管理）
--  3) 系统参数 subject_presets      预置科目 JSON（用户可选创建，非初始化数据）
--  4) 后台菜单：学习管理 → 科目管理(46) + 角色-菜单（admin/student/parent/family）
--  5) 序列：subject_id
-- 幂等可重复执行。部署顺序：本脚本 → 重新部署云托管。
-- 需同步：shared/backend/sql/init_schema.sql / init_data.sql
-- ============================================================

-- 1. 科目表（主键由序列 subject_id 发放；同一归属下科目名唯一）
CREATE TABLE IF NOT EXISTS t_lp_subjects (
  subject_id     BIGINT       NOT NULL COMMENT '科目ID（seqs 发放）',
  staff_id       BIGINT       NOT NULL DEFAULT 0 COMMENT '归属账号 staff_id（主家长/个人）',
  name           VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '科目名称',
  color          VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '颜色（如 #1677ff，空=默认）',
  sort           INT          NOT NULL DEFAULT 0 COMMENT '排序',
  subject_status TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (subject_id),
  UNIQUE KEY uk_staff_name (staff_id, name),
  KEY idx_staff (staff_id),
  KEY idx_status (subject_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满科目（按用户归属，主家长管理）';

-- 2. 合集归属列（不存在才加；回填存量 created_by → staff_id，兼容历史数据）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_task_collections' AND column_name = 'staff_id');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_task_collections ADD COLUMN staff_id BIGINT NOT NULL DEFAULT 0 COMMENT ''归属账号 staff_id（主家长/个人）'' AFTER created_by',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE t_lp_task_collections SET staff_id = created_by WHERE staff_id = 0 AND created_by > 0;

SET @has_idx := (SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema = @db AND table_name = 't_lp_task_collections' AND index_name = 'idx_staff_id');
SET @sql2 := IF(@has_idx = 0, 'ALTER TABLE t_lp_task_collections ADD KEY idx_staff_id (staff_id)', 'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. 序列：subject_id
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch, updated_at)
SELECT 'subject_id', '科目ID', COALESCE(MAX(subject_id), 0) + 1, 1, 1, 200, NOW()
FROM t_lp_subjects
ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, (SELECT COALESCE(MAX(subject_id), 0) + 1 FROM t_lp_subjects));

-- 4. 系统参数：预置科目（JSON 数组，用户可选创建，非初始化数据；后台「系统参数」可改）
INSERT INTO t_system_params (param_id, app_id, param_key, param_value, param_type, param_desc, param_status, created_at, updated_at) VALUES
  (3, 'miniprogram-kxm', 'subject_presets', '["语文","数学","英语","科学","阅读","写作","作业","运动","音乐","美术","编程","书法","口语"]', 'json', '科目预置列表（JSON 数组；用户在「学习管理 → 科目」中选择创建，不自动初始化）', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), param_type = VALUES(param_type),
    param_desc = VALUES(param_desc), param_status = VALUES(param_status);

-- 5. 菜单：学习管理(5) → 科目管理(46)（sort=7，合集管理之后）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at) VALUES
  (46, 5, '科目管理', '/module/subjects', 'BookOutlined', 7, 2, 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path),
    menu_icon = VALUES(menu_icon), sort = VALUES(sort), parent_id = VALUES(parent_id), menu_status = VALUES(menu_status);

-- 6. 角色-菜单（admin/student/parent/family 均开放科目管理）
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 71, 'admin', 46, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 72, 'student', 46, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 73, 'parent', 46, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT 74, 'family', 46, NOW()
ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id);

-- 7. 序列同步
UPDATE t_seqs SET current_value = GREATEST(current_value, 47) WHERE seq_key = 'menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 75) WHERE seq_key = 'role_menu_id';
UPDATE t_seqs SET current_value = GREATEST(current_value, 4) WHERE seq_key = 'param_id';
