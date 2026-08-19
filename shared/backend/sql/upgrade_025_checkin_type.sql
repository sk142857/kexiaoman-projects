-- ============================================================
-- 升级脚本：任务发布新增「打卡方式」字段 + 语音打卡字段
-- 影响表：t_lp_tasks（加 checkin_type）、t_lp_task_checkins（加 checkin_type/voice_url/voice_duration）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（information_schema 判断列，可重复执行）
-- 前置条件：无
-- 说明：
--   1. t_lp_tasks.checkin_type：任务发布的打卡方式
--      image 图文（默认）/ voice 语音 / video 视频（预留，本期后端白名单未开放）
--   2. t_lp_task_checkins 冗余 checkin_type 便于独立展示与审核，并新增语音打卡字段：
--      voice_url（云存储相对路径，非语音为空）、voice_duration（语音时长秒）
--   3. 存量数据靠 DEFAULT 'image' 自动兼容，无需数据回填
--   4. 需同步更新 init_schema.sql 保持一致
-- ============================================================

-- 1. t_lp_tasks：新增 checkin_type 列（不存在才加）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 't_lp_tasks' AND column_name = 'checkin_type');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE t_lp_tasks ADD COLUMN checkin_type VARCHAR(16) NOT NULL DEFAULT ''image'' COMMENT ''打卡方式 image图文/voice语音/video视频(预留)'' AFTER task_status',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. t_lp_task_checkins：新增 checkin_type 列（不存在才加）
SET @has_col2 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'checkin_type');
SET @sql2 := IF(@has_col2 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN checkin_type VARCHAR(16) NOT NULL DEFAULT ''image'' COMMENT ''打卡方式(冗余自任务,便于独立展示/审核) image图文/voice语音/video视频(预留)'' AFTER checkin_images',
  'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. t_lp_task_checkins：新增 voice_url 列（不存在才加）
SET @has_col3 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'voice_url');
SET @sql3 := IF(@has_col3 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN voice_url VARCHAR(500) NOT NULL DEFAULT '''' COMMENT ''语音打卡文件(云存储相对路径,非语音为空)'' AFTER checkin_type',
  'SELECT 1');
PREPARE stmt3 FROM @sql3;
EXECUTE stmt3;
DEALLOCATE PREPARE stmt3;

-- 4. t_lp_task_checkins：新增 voice_duration 列（不存在才加）
SET @has_col4 := (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = @db AND table_name = 't_lp_task_checkins' AND column_name = 'voice_duration');
SET @sql4 := IF(@has_col4 = 0,
  'ALTER TABLE t_lp_task_checkins ADD COLUMN voice_duration INT NOT NULL DEFAULT 0 COMMENT ''语音时长(秒)'' AFTER voice_url',
  'SELECT 1');
PREPARE stmt4 FROM @sql4;
EXECUTE stmt4;
DEALLOCATE PREPARE stmt4;
