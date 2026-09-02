-- ============================================================
-- 课小满 后台「物理清除审计」表（t_lp_staff_purges）
-- 删除账号（含整棵家庭树：主家长 + 孩子 + 家属）时记录完整删除审计清单，
-- 后台「成员管理 → 物理清除审计」可回看每次清除的目标/范围/逐表计数/媒体文件/操作人。
--
-- 部署：在已有库上执行本脚本（幂等），再重新部署云托管。
-- ============================================================

SET NAMES utf8mb4;

-- 1. 物理清除审计表
CREATE TABLE IF NOT EXISTS t_lp_staff_purges (
  purge_id            BIGINT       NOT NULL COMMENT '清除记录ID（seqs 发放）',
  app_id              VARCHAR(32)  NOT NULL DEFAULT 'miniprogram-kxm' COMMENT '小程序 app_id',
  target_kind         VARCHAR(16)  NOT NULL DEFAULT 'staff' COMMENT '清除对象类型 staff=业务账号 / user=微信用户(openid)',
  target_staff_id     BIGINT       NOT NULL DEFAULT 0 COMMENT '被清除账号 staff_id（user 类型=关联的孤儿账号，无则0）',
  target_role         VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '被清除账号角色 parent/student/family/personal/admin',
  target_username     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '被清除账号',
  target_nickname     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '被清除账号昵称',
  scope_staff_ids     VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '级联清除的账号集合（含孩子/家属）逗号分隔',
  scope_openids       VARCHAR(3000) NOT NULL DEFAULT '' COMMENT '级联清除的微信用户 openid 集合',
  summary             TEXT         NULL COMMENT '逐表清除计数汇总 JSON',
  manifest            TEXT         NULL COMMENT '完整清除清单 JSON（逐表计数 + 样本行）',
  media_files         INT          NOT NULL DEFAULT 0 COMMENT '物理删除的云存储媒体文件数',
  status              VARCHAR(16)  NOT NULL DEFAULT 'done' COMMENT 'done 完成 / partial 部分失败',
  fail_detail         VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '失败明细',
  operator_staff_id   BIGINT       NOT NULL DEFAULT 0 COMMENT '操作人 staff_id',
  operator_username   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作人账号',
  client_ip           VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作人 IP',
  client_fingerprint  VARCHAR(128) NOT NULL DEFAULT '' COMMENT '操作人浏览器指纹',
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '清除时间',
  PRIMARY KEY (purge_id),
  KEY idx_target (target_staff_id),
  KEY idx_created (created_at),
  KEY idx_operator (operator_staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满后台物理清除审计';

-- 2. 序列（purge_id 发号）
INSERT INTO t_seqs (seq_key, seq_name, current_value, init_value, step, batch)
VALUES ('purge_id', '物理清除审计ID', 1, 1, 1, 200)
ON DUPLICATE KEY UPDATE seq_name = VALUES(seq_name);

-- 3. 菜单：成员管理 → 物理清除审计（menu_id=50）
INSERT INTO t_menus (menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status, created_at, updated_at)
VALUES (50, 8, '物理清除审计', '/module/staff_purges', 'DeleteOutlined', 8, 2, 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name), menu_path = VALUES(menu_path), parent_id = VALUES(parent_id);

-- 4. 管理员角色授权该菜单
INSERT IGNORE INTO t_role_menus (id, role_code, menu_id, created_at)
SELECT COALESCE(MAX(id), 0) + 1, 'admin', 50, NOW() FROM t_role_menus
WHERE NOT EXISTS (SELECT 1 FROM t_role_menus WHERE role_code = 'admin' AND menu_id = 50);
