-- ============================================
-- 学习打卡管理平台 数据库结构定义
-- MySQL 8.0 / utf8mb4
-- ============================================
SET NAMES utf8mb4;

-- 用户表
CREATE TABLE IF NOT EXISTS t_user (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account      VARCHAR(64)     NOT NULL,
  password     VARCHAR(128)    NOT NULL,
  name         VARCHAR(32)     NOT NULL,
  role         VARCHAR(16)     NOT NULL DEFAULT 'student',
  avatar       VARCHAR(512)    DEFAULT NULL,
  gender       TINYINT         DEFAULT 0,
  school       VARCHAR(64)     DEFAULT NULL,
  grade        VARCHAR(32)     DEFAULT NULL,
  status       TINYINT         NOT NULL DEFAULT 1,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_account (account)
) ENGINE = InnoDB COMMENT = '用户表';

-- 任务表
CREATE TABLE IF NOT EXISTS t_task (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(128)    NOT NULL,
  subject      VARCHAR(32)     DEFAULT NULL,
  description  TEXT            DEFAULT NULL,
  start_date   DATE            DEFAULT NULL,
  deadline     DATE            DEFAULT NULL,
  score        SMALLINT        NOT NULL DEFAULT 0,
  images       JSON            DEFAULT NULL,
  status       VARCHAR(16)     NOT NULL DEFAULT 'todo',
  creator_id   BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_creator (creator_id),
  KEY idx_status (status),
  KEY idx_created (created_at)
) ENGINE = InnoDB COMMENT = '学习任务表';

-- 任务派发表
CREATE TABLE IF NOT EXISTS t_task_assignee (
  task_id    BIGINT UNSIGNED NOT NULL,
  student_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (task_id, student_id)
) ENGINE = InnoDB COMMENT = '任务派发表';

-- 打卡表
CREATE TABLE IF NOT EXISTS t_checkin (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id      BIGINT UNSIGNED NOT NULL,
  student_id   BIGINT UNSIGNED NOT NULL,
  checkin_date DATE            NOT NULL,
  note         TEXT            DEFAULT NULL,
  images       JSON            DEFAULT NULL,
  voice_url    VARCHAR(512)    DEFAULT NULL,
  audit_status VARCHAR(16)     NOT NULL DEFAULT 'pending',
  audit_remark VARCHAR(256)    DEFAULT NULL,
  auditor_id   BIGINT UNSIGNED DEFAULT NULL,
  audited_at   DATETIME        DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_task (task_id),
  KEY idx_student (student_id),
  KEY idx_date (checkin_date)
) ENGINE = InnoDB COMMENT = '任务打卡表';

-- 积分账本表
CREATE TABLE IF NOT EXISTS t_point_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id BIGINT UNSIGNED NOT NULL,
  delta      INT             NOT NULL,
  reason     VARCHAR(32)     NOT NULL,
  remark     VARCHAR(256)    DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_student (student_id)
) ENGINE = InnoDB COMMENT = '积分账本表';

-- 学生档案表
CREATE TABLE IF NOT EXISTS t_student_profile (
  student_id BIGINT UNSIGNED NOT NULL,
  xp         INT             NOT NULL DEFAULT 0,
  streak     INT             NOT NULL DEFAULT 0,
  PRIMARY KEY (student_id)
) ENGINE = InnoDB COMMENT = '学生档案表';

-- 徽章解锁表
CREATE TABLE IF NOT EXISTS t_badge_unlock (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id  BIGINT UNSIGNED NOT NULL,
  badge_key   VARCHAR(32)     NOT NULL,
  unlocked_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_student_badge (student_id, badge_key)
) ENGINE = InnoDB COMMENT = '徽章解锁表';

-- 操作日志表
CREATE TABLE IF NOT EXISTS t_audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id BIGINT UNSIGNED DEFAULT NULL,
  action     VARCHAR(64)     NOT NULL,
  detail     TEXT            DEFAULT NULL,
  ip         VARCHAR(64)     DEFAULT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_operator (operator_id)
) ENGINE = InnoDB COMMENT = '操作审计日志表';
