-- ============================================================
-- 升级脚本：视频封面字段
-- 影响表：t_lp_task_checkins（新增 video_cover）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断列，可重复执行）
-- 前置条件：upgrade_029_video_checkin.sql
-- 说明：
--   1. 视频打卡上传后由后端 ffmpeg 抽一帧作为封面（云存储相对路径 kxm/covers/...）
--   2. 封面在视频压缩/抽帧完成后异步回写，压缩完成前为空
--   3. 存量数据靠 DEFAULT '' 兼容，无需数据回填
--   4. 需同步更新 init_schema.sql 保持一致
-- ============================================================

-- 1. t_lp_task_checkins：新增 video_cover 列（不存在才加）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'video_cover');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN video_cover VARCHAR(500) NOT NULL DEFAULT '''' COMMENT ''视频封面(云存储相对路径,抽帧完成后回写)'' AFTER video_size',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
