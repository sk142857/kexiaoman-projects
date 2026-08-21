-- ============================================================
-- 升级脚本：内容安全审核记录保存微信接口原始返回（t_content_audits.wx_raw）
-- 影响表：t_content_audits（新增 wx_raw 列）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（加列前查 information_schema）
-- 说明：
--   1. 微信官方内容安全接口的完整返回 JSON（msgSecCheck / imgSecCheck / mediaCheckAsync 轮询结果）
--      原样存入 wx_raw（TEXT），供后台「系统监控 → 内容安全」详情抽屉审计展示；
--      视频为抽帧检测，wx_raw 存 {"frames":[{frame,status,raw}]} 聚合结构。
--   2. 前置条件：需先执行 upgrade_037_content_audit.sql。
--   3. 需同步更新 init_schema.sql。
-- ============================================================

SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_content_audits' AND column_name = 'wx_raw');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_content_audits ADD COLUMN wx_raw TEXT NULL COMMENT ''微信接口原始返回(JSON，后台审计展示)'' AFTER detail',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
