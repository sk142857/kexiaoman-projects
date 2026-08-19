-- ============================================================
-- 升级脚本：视频打卡字段
-- 影响表：t_lp_task_checkins（新增 video_url / video_duration / video_size）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断列，可重复执行）
-- 前置条件：upgrade_025_checkin_type.sql（checkin_type 含 video 预留值）
-- 说明：
--   1. 视频打卡文件上传后由后端后台压缩（720p CRF28 转码），压缩完成前
--      video_url 暂存原始路径，压缩完成后更新为压缩后路径并物理删除原文件
--   2. video_size 为压缩后文件大小（字节），便于后台展示节省空间效果
--   3. 存量数据靠 DEFAULT ''/0 兼容，无需数据回填
--   4. 需同步更新 init_schema.sql 保持一致
-- ============================================================

-- 1. t_lp_task_checkins：新增 video_url 列（不存在才加）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'video_url');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN video_url VARCHAR(500) NOT NULL DEFAULT '''' COMMENT ''视频打卡文件(云存储相对路径,非视频为空;压缩完成后更新为压缩后路径)'' AFTER voice_duration',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. t_lp_task_checkins：新增 video_duration 列（不存在才加）
SET @has_col2 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'video_duration');
SET @sql2 := IF(@has_col2 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN video_duration INT NOT NULL DEFAULT 0 COMMENT ''视频时长(秒)'' AFTER video_url',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. t_lp_task_checkins：新增 video_size 列（不存在才加）
SET @has_col3 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'video_size');
SET @sql3 := IF(@has_col3 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN video_size INT NOT NULL DEFAULT 0 COMMENT ''视频压缩后大小(字节)'' AFTER video_duration',
  'SELECT 1');
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;
