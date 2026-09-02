-- ============================================================
-- 课小满 清理存量「auto」绑定行（重构 C：家谱继承改为运行时推导后不再需要物化 auto 行）
-- 背景：旧版把“家长挂孩子”物化成 t_lp_students.source='auto'；新版起家长切孩由
--       lpAuth.listBoundStaffs / openidMayUseStaff 按「家谱继承」实时推导，不再写 auto 行。
--       auto 行已无作用（显式绑定+家谱去重后不重复；同 openid 无家长绑定或孩子不在家谱中时，
--       家谱继承也不放行），可安全清理。
-- ⚠️ 部署顺序：必须先部署新版云托管（重构 C 生效），再执行本脚本清理存量 auto 行；
--    若先删 auto 行、旧版仍在运行，共用微信场景的“切孩子”会短暂失效。
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行；幂等。
-- ============================================================

SET NAMES utf8mb4;

-- 1. 确认 source 列存在（upgrade_052 已加；缺失则跳过避免报错）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_students' AND column_name = 'source');

-- 2. 清理 source='auto' 的存量绑定行
DELETE FROM t_lp_students
WHERE @has_col = 1 AND source = 'auto';
