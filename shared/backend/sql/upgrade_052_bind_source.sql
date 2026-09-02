-- ============================================================
-- 课小满 绑定关系加「来源」标记（t_lp_students.source）
-- 目的：区分「孩子自己的手机（码绑定）」vs「家长自动挂的孩子（家谱继承）」，后台绑定管理可识别/过滤，
-- 减少“绑定关系混乱”的感知；家长那行自动绑定可安全删除（删了也能再自动），不影响孩子自己的手机。
-- 取值：register=注册建档 / invite=邀请码绑定 / auto=家谱自动（家长一键切换/建档自动绑定）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行；幂等（加列前查 information_schema）。
-- 说明：历史数据无法精确还原来源，做一次启发式回填——
--   “同一 openid 同时绑定了家长账号、且本行是学生账号”判定为 auto（家长挂在孩子上）；
--   其余保留默认 invite（含注册建档的历史家长行，属可接受的近似）。
-- ============================================================

SET NAMES utf8mb4;
SET @db := DATABASE();

-- 1. 加列（不存在才加）
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_students' AND column_name = 'source');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_students ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT ''invite'' COMMENT ''绑定来源 register注册建档 / invite邀请码 / auto家谱自动(家长一键/建档自动)'' AFTER bound_status',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. 启发式回填 auto（同一 openid 既绑家长、本行又是学生账号 ⇒ 家长自动挂的孩子）
UPDATE t_lp_students s
JOIN t_lp_students p
  ON p.openid = s.openid AND p.app_id = s.app_id
JOIN t_staff st ON st.staff_id = s.staff_id
JOIN t_staff pt ON pt.staff_id = p.staff_id
SET s.source = 'auto'
WHERE s.source = 'invite'
  AND st.staff_role = 'student'
  AND pt.staff_role = 'parent'
  AND p.staff_id <> s.staff_id;
