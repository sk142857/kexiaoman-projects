-- ============================================================
-- 共享云托管后端 - 表结构（DDL）脚本（同步至当前最新 schema）
-- 微信云托管自带 MySQL（utf8mb4）
--
-- ⚠️ 警告：本文件含 DROP TABLE IF EXISTS，会清空所有数据并重建！
--    仅用于「全新部署」或「彻底重置」；
--    已有数据的库请勿执行本文件，业务变更一律使用 upgrade_*.sql。
--
-- 执行方式：在数据库管理控制台（DMS）或 mysql 客户端执行本文件
-- 配套：建表完成后，执行 init_data.sql 完成初始化数据（角色/菜单/字典/序列/管理员）
--
-- 主键发号约定：
--   业务表主键由 seqs 序列统一发放（见 init_data.sql 的序列初始化）
--   users.user_id 保留自增；业务主键（如 task_id / checkin_id）由序列发放
-- ============================================================

SET NAMES utf8mb4;

-- ==================== 用户 / 画像 ====================

-- 用户表（user_id 保留自增；user_uid 随机10位用户ID，不入序列管理）
DROP TABLE IF EXISTS t_users;
CREATE TABLE t_users (
  user_id      BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  openid       VARCHAR(64)  NOT NULL COMMENT '用户 openid（共享环境已去 AppID 前缀）',
  app_id       VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '所属小程序 app_id',
  user_uid     VARCHAR(10)  NOT NULL DEFAULT '' COMMENT '用户ID（随机10位数字）',
  nickname     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '昵称',
  avatar_emoji VARCHAR(16)  NOT NULL DEFAULT '🌱' COMMENT '头像 emoji',
  gender       TINYINT      NOT NULL DEFAULT 0 COMMENT '性别 0保密 1男 2女',
  avatar       VARCHAR(500) NOT NULL DEFAULT '' COMMENT '头像128px路径 kxm/avatar/...',
  avatar_hd    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '头像512px路径',
  user_status  TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0禁用',
  locked_until DATETIME     NULL COMMENT '账号锁定截止时间（NULL=未锁定；早于当前时间自动解锁）',
  locked_reason VARCHAR(255) NOT NULL DEFAULT '' COMMENT '账号锁定原因',
  locked_by    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '账号锁定操作人',
  locked_at    DATETIME     NULL COMMENT '账号锁定时间',
  nickname_pending VARCHAR(64) NOT NULL DEFAULT '' COMMENT '待审核昵称',
  avatar_pending VARCHAR(500) NOT NULL DEFAULT '' COMMENT '待审核头像128px',
  avatar_hd_pending VARCHAR(500) NOT NULL DEFAULT '' COMMENT '待审核头像512px',
  gender_pending TINYINT     NOT NULL DEFAULT 0 COMMENT '待审核性别',
  profile_review_status VARCHAR(12) NOT NULL DEFAULT 'approved' COMMENT '资料审核状态 pending/approved/rejected',
  profile_reviewed_at DATETIME NULL COMMENT '资料审核时间',
  profile_reviewer VARCHAR(64) NOT NULL DEFAULT '' COMMENT '资料审核人',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (user_id),
  UNIQUE KEY uk_openid (openid),
  UNIQUE KEY uk_user_uid (user_uid),
  KEY idx_app (app_id),
  KEY idx_profile_review (profile_review_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户';

-- 会话采集表（session_id 即主键 + 常用字段独立列 + 原始 payload 保留）
DROP TABLE IF EXISTS t_user_sessions;
CREATE TABLE t_user_sessions (
  session_id        VARCHAR(64)  NOT NULL COMMENT '会话 ID（主键）',
  openid            VARCHAR(64)  NOT NULL COMMENT '用户 openid',
  app_id            VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '所属小程序 app_id',
  brand             VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '设备品牌',
  model             VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '设备型号',
  platform          VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '平台 ios/android',
  os_version        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '系统版本',
  cpu_type          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT 'CPU 型号',
  wechat_version    VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '微信版本',
  sdk_version       VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '基础库版本',
  renderer          VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '渲染引擎 skyline/webview',
  network_type      VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '网络类型',
  env_version       VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '环境 develop/trial/release',
  app_version       VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '应用版本',
  launch_scene      INT          NOT NULL DEFAULT 0 COMMENT '进入场景值',
  model_level       VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '设备性能档位 high/middle/low',
  referrer_info     VARCHAR(500) NOT NULL DEFAULT '' COMMENT '来源信息 JSON（分享/扫码等）',
  auth_notification TINYINT      NOT NULL DEFAULT 0 COMMENT '通知权限',
  auth_album        TINYINT      NOT NULL DEFAULT 0 COMMENT '相册权限',
  auth_camera       TINYINT      NOT NULL DEFAULT 0 COMMENT '摄像头权限',
  auth_location     TINYINT      NOT NULL DEFAULT 0 COMMENT '位置权限',
  auth_mic          TINYINT      NOT NULL DEFAULT 0 COMMENT '麦克风权限',
  dark_mode         TINYINT      NOT NULL DEFAULT 0 COMMENT '深色模式',
  screen_w          INT          NOT NULL DEFAULT 0 COMMENT '屏幕宽',
  screen_h          INT          NOT NULL DEFAULT 0 COMMENT '屏幕高',
  battery_level     INT          NOT NULL DEFAULT -1 COMMENT '电量',
  is_charging       TINYINT      NOT NULL DEFAULT 0 COMMENT '是否充电中',
  payload           JSON         NULL COMMENT '原始完整会话画像数据',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '采集时间',
  PRIMARY KEY (session_id),
  KEY idx_openid_created (openid, created_at),
  KEY idx_created (created_at),
  KEY idx_app (app_id),
  KEY idx_platform (platform),
  KEY idx_env_version (env_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话采集';

-- ==================== 系统监控 / 链路 ====================

-- 系统服务监控表（每 10 分钟采集一次）
DROP TABLE IF EXISTS t_service_monitor;
CREATE TABLE t_service_monitor (
  monitor_id      VARCHAR(20)  NOT NULL COMMENT '主键（时间戳毫秒+2位随机）',
  env_id          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '云环境 ID',
  instance_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '实例 ID',
  cpu_cores       DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT 'CPU 核数（容器实际可见，含小数，如 0.25）',
  mem_total_mb    INT          NOT NULL DEFAULT 0 COMMENT '总内存 MB（容器实际可见）',
  instance_spec   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '实例规格（云托管配置，如 0.25核/512MB）',
  internal_ip     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '容器内网 IP',
  zone_id         VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '可用区（EKLET_META_ZONE）',
  cluster_id      VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '集群 ID（EKLET_META_ID）',
  node_version    VARCHAR(16)  NOT NULL DEFAULT '' COMMENT 'Node 运行时版本',
  heap_used_mb    INT          NOT NULL DEFAULT 0 COMMENT '堆内存已用 MB',
  heap_total_mb   INT          NOT NULL DEFAULT 0 COMMENT '堆内存总量 MB',
  rss_mb          INT          NOT NULL DEFAULT 0 COMMENT '进程常驻内存 RSS MB',
  external_mb     INT          NOT NULL DEFAULT 0 COMMENT '外部内存 MB',
  cpu_percent     DECIMAL(6,2) NOT NULL DEFAULT 0 COMMENT 'CPU 使用率 %',
  uptime_min      INT          NOT NULL DEFAULT 0 COMMENT '进程运行分钟',
  active_handles  INT          NOT NULL DEFAULT 0 COMMENT '活跃句柄数',
  active_reqs     INT          NOT NULL DEFAULT 0 COMMENT '活跃请求数',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '采集时间',
  PRIMARY KEY (monitor_id),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统服务监控';

-- 接口调用链路表（前端 request_id 关联两端耗时）
DROP TABLE IF EXISTS t_api_trace;
CREATE TABLE t_api_trace (
  request_id     VARCHAR(40)  NOT NULL COMMENT '请求 ID（前端生成 UUID，主键）',
  openid         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '用户 openid',
  user_id        VARCHAR(10)  NOT NULL DEFAULT '' COMMENT '用户ID（users.user_uid，用于后台定位）',
  api_path       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '接口路径',
  api_method     VARCHAR(8)   NOT NULL DEFAULT '' COMMENT '请求方法',
  req_params     JSON         NULL COMMENT '请求参数（脱敏后）',
  start_time     DATETIME     NULL COMMENT '服务端请求开始时间',
  end_time       DATETIME     NULL COMMENT '服务端请求结束时间',
  server_cost_ms INT          NOT NULL DEFAULT 0 COMMENT '服务端处理耗时 ms',
  server_code    INT          NOT NULL DEFAULT 0 COMMENT '服务端返回 code',
  http_status    INT          NOT NULL DEFAULT 200 COMMENT 'HTTP 状态码',
  client_fingerprint VARCHAR(128) NOT NULL DEFAULT '' COMMENT '客户端指纹（微信/平台/系统）',
  client_cost_ms INT          NOT NULL DEFAULT -1 COMMENT '前端总耗时 ms（发起→回调，-1=未上报）',
  client_at      DATETIME     NULL COMMENT '前端上报时间',
  trace_status   VARCHAR(12)  NOT NULL DEFAULT 'server_only' COMMENT 'server_only/complete',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次记录时间',
  PRIMARY KEY (request_id),
  KEY idx_created (created_at),
  KEY idx_openid_created (openid, created_at),
  KEY idx_user_id (user_id),
  KEY idx_trace_status (trace_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='接口调用链路';

-- ==================== 后台管理 ====================

-- 角色表（主键由序列 role_id 发放）
DROP TABLE IF EXISTS t_roles;
CREATE TABLE t_roles (
  role_id      BIGINT       NOT NULL COMMENT '主键（序列发放）',
  role_code    VARCHAR(32)  NOT NULL COMMENT '角色编码（唯一，admin/student）',
  role_name    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '角色名称',
  role_status  TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (role_id),
  UNIQUE KEY uk_role_code (role_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台角色';

-- 菜单表（动态加载，主键由序列 menu_id 发放）
DROP TABLE IF EXISTS t_menus;
CREATE TABLE t_menus (
  menu_id    BIGINT       NOT NULL COMMENT '主键（序列发放）',
  parent_id  BIGINT       NOT NULL DEFAULT 0 COMMENT '父级菜单ID（0=顶级分组）',
  menu_name  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '菜单名称',
  menu_path  VARCHAR(128) NOT NULL DEFAULT '' COMMENT '前端路由路径',
  menu_icon  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '图标名（对应前端图标映射）',
  sort       INT          NOT NULL DEFAULT 0 COMMENT '排序',
  menu_type  TINYINT      NOT NULL DEFAULT 2 COMMENT '1=分组 2=叶子',
  menu_status TINYINT     NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (menu_id),
  KEY idx_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台菜单';

-- 角色-菜单关联表（主键由序列 role_menu_id 发放）
DROP TABLE IF EXISTS t_role_menus;
CREATE TABLE t_role_menus (
  id         BIGINT      NOT NULL COMMENT '主键（序列发放）',
  role_code  VARCHAR(32) NOT NULL COMMENT '角色编码',
  menu_id    BIGINT      NOT NULL COMMENT '菜单ID',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_role_menu (role_code, menu_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色-菜单关联';

-- 后台管理员表（主键由序列 staff_id 发放，新员工从 9001 开始）
DROP TABLE IF EXISTS t_staff;
CREATE TABLE t_staff (
  staff_id      BIGINT       NOT NULL COMMENT '主键（序列发放，9001 起）',
  staff_username VARCHAR(64)  NOT NULL COMMENT '登录账号',
  staff_password VARCHAR(128) NOT NULL COMMENT '密码（bcrypt 哈希）',
  staff_nickname VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '昵称',
  staff_role    VARCHAR(16)  NOT NULL DEFAULT 'admin' COMMENT '角色 admin/student',
  staff_status  TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (staff_id),
  UNIQUE KEY uk_staff_username (staff_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台管理员';

-- 后台 staff 操作审计日志表（登录/登出/点击菜单/增删改查等）
DROP TABLE IF EXISTS t_staff_events;
CREATE TABLE t_staff_events (
  event_id           VARCHAR(16)  NOT NULL COMMENT '主键（13位时间戳+3位随机数）',
  staff_id           BIGINT       NOT NULL DEFAULT 0 COMMENT '操作人 staff_id',
  staff_username     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作人账号',
  app_id             VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '所属小程序 app_id',
  event_type         VARCHAR(24)  NOT NULL DEFAULT 'custom' COMMENT 'login/login_fail/logout/menu_click/create/update/delete/detail/review/custom',
  event_name         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '事件名称（如 登录成功 / 创建用户）',
  module             VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '业务模块（users/tasks/auth/menu 等）',
  api_path           VARCHAR(200) NOT NULL DEFAULT '' COMMENT '接口路径',
  biz_id             VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '业务 ID（被操作记录主键，可选）',
  client_ip          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '客户端 IP',
  client_fingerprint VARCHAR(128) NOT NULL DEFAULT '' COMMENT '客户端指纹（浏览器/平台/系统/设备）',
  user_agent         VARCHAR(255) NOT NULL DEFAULT '' COMMENT '客户端 User-Agent',
  extra              JSON         NULL COMMENT '附加信息（脱敏后的请求参数等）',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '事件时间',
  PRIMARY KEY (event_id),
  KEY idx_staff_created (staff_id, created_at),
  KEY idx_type_created (event_type, created_at),
  KEY idx_module_created (module, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台操作审计';

-- 小程序注册表（多小程序共享后台；密钥类配置存表，后台可维护，不用环境变量）
DROP TABLE IF EXISTS t_apps;
CREATE TABLE t_apps (
  app_id        VARCHAR(32)  NOT NULL COMMENT '应用标识（app_code，如 learning-planet）',
  app_name      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '应用名称',
  wechat_appid  VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '微信小程序 AppID',
  app_secret    VARCHAR(255) NOT NULL DEFAULT '' COMMENT '小程序 AppSecret（code2session 用，后台配置）',
  jwt_secret    VARCHAR(128) NOT NULL DEFAULT '' COMMENT '小程序业务 JWT 签名密钥（后台配置）',
  jwt_expires   VARCHAR(16)  NOT NULL DEFAULT '7d' COMMENT 'JWT 有效期（如 7d）',
  service_url   VARCHAR(255) NOT NULL DEFAULT '' COMMENT '云托管服务默认公网域名（前端 BASE_URL 依据）',
  subscribe_tmpl_ids VARCHAR(500) NOT NULL DEFAULT '' COMMENT '订阅消息模板ID(逗号分隔,后台可维护)',
  reminder_window VARCHAR(16) NOT NULL DEFAULT '18:00-22:00' COMMENT '打卡提醒窗口(如 18:00-22:00)',
  reminder_days INT NOT NULL DEFAULT 3 COMMENT '打卡提醒提前天数',
  reminder_overdue_days INT NOT NULL DEFAULT 7 COMMENT '逾期提醒回溯天数',
  app_desc      VARCHAR(255) NOT NULL DEFAULT '' COMMENT '小程序说明',
  app_status    TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0停用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (app_id),
  UNIQUE KEY uk_wechat_appid (wechat_appid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='小程序注册表（多小程序共享后台）';

-- 后台员工-小程序授权表
DROP TABLE IF EXISTS t_staff_apps;
CREATE TABLE t_staff_apps (
  id         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  staff_id   BIGINT       NOT NULL DEFAULT 0 COMMENT '员工 staff_id',
  app_id     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '可管理的小程序 app_id',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '授权时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_staff_app (staff_id, app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台员工-小程序授权';

-- 图片上传记录表
DROP TABLE IF EXISTS t_file_uploads;
CREATE TABLE t_file_uploads (
  file_id      VARCHAR(16)  NOT NULL COMMENT '主键（13位时间戳+3位随机数）',
  openid       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '用户 openid',
  staff_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '上传者staffID（后台登录员工，如9001）',
  biz          VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '业务类型 avatar/events/tasks',
  biz_id       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '业务 ID（审核通过后回填，如任务/打卡 ID）',
  file_name    VARCHAR(255) NOT NULL DEFAULT '' COMMENT '原始文件名',
  file_path    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '存储相对路径 kxm/...',
  file_url     VARCHAR(700) NOT NULL DEFAULT '' COMMENT '完整访问 URL（域名+路径）',
  file_cos_id  VARCHAR(700) NOT NULL DEFAULT '' COMMENT 'CloudBase fileID',
  file_size    INT          NOT NULL DEFAULT 0 COMMENT '文件大小(字节)',
  file_size_orig       INT          NOT NULL DEFAULT 0 COMMENT '原图大小(字节，压缩前)',
  file_size_compressed INT          NOT NULL DEFAULT 0 COMMENT '压缩后大小(字节)',
  file_size_ratio      DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT '压缩比(节省百分比%)',
  content_type VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'MIME 类型',
  file_status  VARCHAR(16)  NOT NULL DEFAULT 'active' COMMENT 'active/removed',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
  PRIMARY KEY (file_id),
  KEY idx_openid_created (openid, created_at),
  KEY idx_biz (biz, biz_id),
  KEY idx_staff (staff_id),
  KEY idx_openid_path (openid, file_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='图片上传记录';

-- 用户操作事件埋点表
DROP TABLE IF EXISTS t_user_events;
CREATE TABLE t_user_events (
  event_id   VARCHAR(16)  NOT NULL COMMENT '主键（13位时间戳+3位随机数）',
  openid     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '用户 openid',
  app_id     VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '所属小程序 app_id',
  event_type VARCHAR(24)  NOT NULL DEFAULT 'custom' COMMENT 'login/page_view/menu_click/button_click/create/update/delete/end/reset/custom',
  event_name VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '事件名称（如 点击学习管理）',
  page_path  VARCHAR(128) NOT NULL DEFAULT '' COMMENT '页面路径',
  biz_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '业务 ID（可选）',
  extra      JSON         NULL COMMENT '附加信息 JSON',
  client_at  DATETIME     NULL COMMENT '客户端时间',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (event_id),
  KEY idx_openid_created (openid, created_at),
  KEY idx_app (app_id),
  KEY idx_type_created (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户操作事件';

-- ==================== 数据字典 ====================

-- 字典类型表（主键由序列 dict_type_id 发放）
DROP TABLE IF EXISTS t_dict_types;
CREATE TABLE t_dict_types (
  dict_id     BIGINT       NOT NULL COMMENT '主键（序列发放）',
  dict_code   VARCHAR(64)  NOT NULL COMMENT '字典编码（唯一，如 subject/gender）',
  dict_name   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '字典名称',
  dict_status TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (dict_id),
  UNIQUE KEY uk_dict_code (dict_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据字典类型';

-- 字典项表（主键由序列 dict_item_id 发放）
DROP TABLE IF EXISTS t_dict_items;
CREATE TABLE t_dict_items (
  item_id     BIGINT       NOT NULL COMMENT '主键（序列发放）',
  dict_code   VARCHAR(64)  NOT NULL COMMENT '所属字典编码',
  item_value  VARCHAR(64)  NOT NULL COMMENT '项值',
  item_label  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '项名称',
  color       VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '颜色值（如 #1677ff，空=无颜色）',
  sort        INT          NOT NULL DEFAULT 0 COMMENT '排序',
  item_status TINYINT      NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (item_id),
  KEY idx_dict (dict_code, item_status),
  UNIQUE KEY uk_dict_item (dict_code, item_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据字典项';

-- ==================== 学习管理（任务 / 打卡 / 合集） ====================

-- 学习任务表（主键由序列 task_id 发放）
DROP TABLE IF EXISTS t_lp_tasks;
CREATE TABLE t_lp_tasks (
  task_id       BIGINT       NOT NULL COMMENT '任务编号（主键，序列发放）',
  title         VARCHAR(100) NOT NULL DEFAULT '' COMMENT '任务标题',
  subject       VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '科目',
  tags          VARCHAR(500) NOT NULL DEFAULT '' COMMENT '标签(JSON数组字符串,如["重点","复习"])',
  description   VARCHAR(500) NOT NULL DEFAULT '' COMMENT '任务描述',
  task_link     VARCHAR(500) NOT NULL DEFAULT '' COMMENT '任务链接(可点击跳转)',
  images        VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '图片路径(JSON数组字符串,最多9张)',
  task_status   VARCHAR(16)  NOT NULL DEFAULT 'todo' COMMENT 'todo未开始/doing进行中/done已完成',
  score         TINYINT      NOT NULL DEFAULT 10 COMMENT '任务评分(1-10,满分10)',
  deadline      VARCHAR(10)  NOT NULL DEFAULT '' COMMENT '截止日期 yyyy-MM-dd',
  start_date    VARCHAR(10)  NOT NULL DEFAULT '' COMMENT '开始日期 yyyy-MM-dd',
  collection_id BIGINT       NOT NULL DEFAULT 0 COMMENT '所属合集ID（0=未分合集）',
  checkin_count INT          NOT NULL DEFAULT 0 COMMENT '打卡次数',
  created_by    BIGINT       NOT NULL DEFAULT 0 COMMENT '创建人 staff_id',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (task_id),
  KEY idx_created_by (created_by),
  KEY idx_status (task_status),
  KEY idx_collection (collection_id),
  KEY idx_subject (subject)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学习任务';

-- 任务派发表（任务→学生角色的后台员工，一个任务可派发给多名学生；学生自建任务自动派发给自己）
DROP TABLE IF EXISTS t_lp_task_assignees;
CREATE TABLE t_lp_task_assignees (
  task_id    BIGINT   NOT NULL COMMENT '任务ID',
  staff_id   BIGINT   NOT NULL COMMENT '被派发学生 staff_id',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派发时间',
  PRIMARY KEY (task_id, staff_id),
  KEY idx_assignee (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学习任务派发';

-- 学习任务打卡表（主键由序列 task_checkin_id 发放）
DROP TABLE IF EXISTS t_lp_task_checkins;
CREATE TABLE t_lp_task_checkins (
  checkin_id    BIGINT       NOT NULL COMMENT '主键（序列发放）',
  task_id       BIGINT       NOT NULL DEFAULT 0 COMMENT '关联任务ID',
  checkin_date  VARCHAR(10)  NOT NULL DEFAULT '' COMMENT '打卡日期 yyyy-MM-dd',
  checkin_note  VARCHAR(500) NOT NULL DEFAULT '' COMMENT '打卡备注',
  checkin_images VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '图片路径(JSON数组字符串,最多9张)',
  created_by    BIGINT       NOT NULL DEFAULT 0 COMMENT '打卡人 staff_id',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '打卡时间',
  review_status VARCHAR(12)  NOT NULL DEFAULT 'pending' COMMENT '审核状态 pending待审核/approved已通过/rejected已驳回',
  review_score  TINYINT      NOT NULL DEFAULT 0 COMMENT '审核评分(0-10)',
  review_note   VARCHAR(500) NOT NULL DEFAULT '' COMMENT '审核说明/原因',
  reviewed_at   DATETIME     NULL COMMENT '审核时间',
  reviewer      BIGINT       NOT NULL DEFAULT 0 COMMENT '审核人 staff_id',
  PRIMARY KEY (checkin_id),
  KEY idx_task (task_id),
  KEY idx_created_by (created_by),
  KEY idx_date (checkin_date),
  KEY idx_created_at (created_at),
  KEY idx_review_status (review_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学习任务打卡';

-- 任务业务时间轴表（主键由序列 task_timeline_event_id 发放；任务/打卡全生命周期事件审计）
DROP TABLE IF EXISTS t_lp_task_timeline;
CREATE TABLE t_lp_task_timeline (
  event_id    BIGINT       NOT NULL COMMENT '主键（序列发放）',
  task_id     BIGINT       NOT NULL DEFAULT 0 COMMENT '关联任务ID',
  checkin_id  BIGINT       NOT NULL DEFAULT 0 COMMENT '关联打卡ID（0=任务级事件）',
  biz_type    VARCHAR(24)  NOT NULL DEFAULT 'task' COMMENT '业务类型 task/task_checkin',
  event_type  VARCHAR(24)  NOT NULL DEFAULT '' COMMENT 'create/update/delete/done/checkin/checkin_update/checkin_delete',
  event_name  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '事件中文名（如 创建任务/任务打卡）',
  summary     VARCHAR(255) NOT NULL DEFAULT '' COMMENT '事件摘要文案',
  payload     JSON         NULL COMMENT '事件详情（修改前后值、打卡图片等）',
  created_by  BIGINT       NOT NULL DEFAULT 0 COMMENT '操作人 staff_id',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '事件时间',
  PRIMARY KEY (event_id),
  KEY idx_task (task_id),
  KEY idx_checkin (checkin_id),
  KEY idx_created_at (created_at),
  KEY idx_task_created (task_id, created_at, event_id),
  KEY idx_checkin_created (checkin_id, created_at, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务业务时间轴';

-- 任务合集表（主键由序列 collection_id 发放；合集是独立功能，非数据字典）
DROP TABLE IF EXISTS t_lp_task_collections;
CREATE TABLE t_lp_task_collections (
  collection_id     BIGINT        NOT NULL COMMENT '合集编号（主键，序列发放）',
  name              VARCHAR(100)  NOT NULL DEFAULT '' COMMENT '合集名称',
  description       VARCHAR(500)  NOT NULL DEFAULT '' COMMENT '合集描述',
  cover_images      VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '封面图(JSON数组字符串,仅1张)',
  task_count        INT           NOT NULL DEFAULT 0 COMMENT '任务数量（读取时动态统计）',
  created_by        BIGINT        NOT NULL DEFAULT 0 COMMENT '创建人 staff_id',
  collection_status TINYINT       NOT NULL DEFAULT 1 COMMENT '1启用/0停用',
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (collection_id),
  KEY idx_name (name),
  KEY idx_created_by (created_by),
  KEY idx_status (collection_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务合集';

-- 课小满小程序用户-学生账号绑定表（邀请码准入）
DROP TABLE IF EXISTS t_lp_students;
CREATE TABLE t_lp_students (
  id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  staff_id     BIGINT       NOT NULL DEFAULT 0 COMMENT '学生 staff_id（t_staff，role=student）',
  app_id       VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '小程序 app_id',
  openid       VARCHAR(64)  NOT NULL COMMENT '小程序用户 openid（去前缀规范值）',
  bound_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '绑定时间',
  bound_status TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0已锁定（邀请码作废后锁定）',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_app_openid (app_id, openid),
  KEY idx_staff (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满小程序用户-学生账号绑定';

-- 课小满邀请码独立表（学生码/家属共享码；邀请码不再挂 t_staff 维护）
DROP TABLE IF EXISTS t_lp_invites;
CREATE TABLE t_lp_invites (
  invite_id       BIGINT       NOT NULL COMMENT '主键（序列发放）',
  app_id          VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '小程序 app_id',
  invite_code     VARCHAR(8)   NOT NULL DEFAULT '' COMMENT '6位大写邀请码（生成时排除0/O/1/I）',
  kind            VARCHAR(16)  NOT NULL DEFAULT 'student' COMMENT 'student学生码 / family家属共享码',
  owner_staff_id  BIGINT       NOT NULL DEFAULT 0 COMMENT '归属账号：学生码=孩子student账号；家属码=主家长账号',
  child_id        BIGINT       NOT NULL DEFAULT 0 COMMENT '学生码关联的孩子档案ID（家属码为0）',
  status          VARCHAR(16)  NOT NULL DEFAULT 'available' COMMENT 'available未绑定可用 / bound已绑定 / revoked已作废',
  bound_openid    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '绑定的小程序 openid',
  bound_staff_id  BIGINT       NOT NULL DEFAULT 0 COMMENT '绑定后建立的家属/学生 staff_id',
  bound_at        DATETIME     NULL COMMENT '绑定时间',
  created_by      BIGINT       NOT NULL DEFAULT 0 COMMENT '创建人 staff_id（主家长/管理员）',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (invite_id),
  UNIQUE KEY uk_invite_code (invite_code),
  KEY idx_owner (owner_staff_id),
  KEY idx_status (status),
  KEY idx_kind (kind),
  KEY idx_child (child_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满邀请码独立表（学生码/家属共享码）';

-- 课小满孩子档案（家长-孩子关系）
DROP TABLE IF EXISTS t_lp_children;
CREATE TABLE t_lp_children (
  child_id          BIGINT       NOT NULL COMMENT '主键（序列发放）',
  app_id            VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '小程序 app_id',
  parent_staff_id   BIGINT       NOT NULL DEFAULT 0 COMMENT '主家长 staff_id',
  student_staff_id  BIGINT       NOT NULL DEFAULT 0 COMMENT '孩子学生账号 staff_id（t_staff role=student）',
  child_name        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '孩子姓名',
  gender            TINYINT      NOT NULL DEFAULT 0 COMMENT '性别 0未知 1男 2女',
  birth_date        DATE         NULL COMMENT '出生年月',
  school_name       VARCHAR(128) NOT NULL DEFAULT '' COMMENT '学校名称',
  grade             TINYINT      NOT NULL DEFAULT 0 COMMENT '年级 1-6',
  class_no          TINYINT      NOT NULL DEFAULT 0 COMMENT '班级 1-35',
  child_status      TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0已删除',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (child_id),
  KEY idx_parent (parent_staff_id),
  KEY idx_student (student_staff_id),
  KEY idx_app_parent (app_id, parent_staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满孩子档案（家长-孩子关系）';

-- 课小满家属关系（主家长-家属）
DROP TABLE IF EXISTS t_lp_family_members;
CREATE TABLE t_lp_family_members (
  id                BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  app_id            VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '小程序 app_id',
  owner_staff_id    BIGINT       NOT NULL DEFAULT 0 COMMENT '主家长 staff_id',
  member_staff_id   BIGINT       NOT NULL DEFAULT 0 COMMENT '家属账号 staff_id',
  member_openid     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '家属小程序 openid',
  member_status     TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0已解除',
  bound_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '绑定时间',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_owner_member (owner_staff_id, member_staff_id),
  KEY idx_owner (owner_staff_id),
  KEY idx_member (member_staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满家属关系（主家长-家属）';

-- 课小满订阅消息授权记录表（主键由序列 subscribe_grant_id 发放）
DROP TABLE IF EXISTS t_lp_subscribe_grants;
CREATE TABLE t_lp_subscribe_grants (
  grant_id     BIGINT       NOT NULL COMMENT '主键（序列发放）',
  staff_id     BIGINT       NOT NULL DEFAULT 0 COMMENT '学生 staff_id',
  openid       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '小程序用户 openid',
  app_id       VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '小程序 app_id',
  tmpl_id      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '订阅消息模板ID（第一阶段可为空）',
  grant_count  INT          NOT NULL DEFAULT 1 COMMENT '本次授权获得的订阅次数',
  used_count   INT          NOT NULL DEFAULT 0 COMMENT '已消耗次数',
  grant_status VARCHAR(12)  NOT NULL DEFAULT 'active' COMMENT 'active可用/consumed用尽',
  source       VARCHAR(24)  NOT NULL DEFAULT 'mini' COMMENT '来源 mini小程序/backoffice后台',
  remark       VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '授权时间',
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (grant_id),
  KEY idx_staff (staff_id),
  KEY idx_openid (openid),
  KEY idx_status (grant_status),
  KEY idx_staff_status (staff_id, grant_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满订阅消息授权记录';

-- 课小满订阅消息发送记录表（主键由序列 subscribe_send_id 发放）
DROP TABLE IF EXISTS t_lp_subscribe_sends;
CREATE TABLE t_lp_subscribe_sends (
  send_id     BIGINT       NOT NULL COMMENT '主键（序列发放）',
  staff_id    BIGINT       NOT NULL DEFAULT 0 COMMENT '接收人 staff_id',
  openid      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '接收人 openid',
  app_id      VARCHAR(32)  NOT NULL DEFAULT 'learning-planet' COMMENT '小程序 app_id',
  tmpl_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '模板ID',
  event_type  VARCHAR(24)  NOT NULL DEFAULT '' COMMENT '业务事件类型 review_approve/review_reject',
  biz_type    VARCHAR(24)  NOT NULL DEFAULT '' COMMENT '业务类型 task_checkin',
  biz_id      VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '业务ID（打卡/任务ID）',
  page        VARCHAR(255) NOT NULL DEFAULT '' COMMENT '跳转页面',
  payload     JSON         NULL COMMENT '发送的模板字段数据',
  send_status VARCHAR(16)  NOT NULL DEFAULT 'sent' COMMENT 'sent发送成功/failed失败/skip跳过',
  errcode     INT          NOT NULL DEFAULT 0 COMMENT '微信返回 errcode（-1跳过/-2本地异常）',
  errmsg      VARCHAR(255) NOT NULL DEFAULT '' COMMENT '微信返回 errmsg / 跳过原因',
  credit_consumed TINYINT   NOT NULL DEFAULT 0 COMMENT '是否消耗订阅次数 0否 1是',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
  PRIMARY KEY (send_id),
  KEY idx_staff_created (staff_id, created_at),
  KEY idx_biz (biz_type, biz_id),
  KEY idx_status (send_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课小满订阅消息发送记录';

-- 序列管理表（统一发号）
DROP TABLE IF EXISTS t_seqs;
CREATE TABLE t_seqs (
  seq_key       VARCHAR(32)  NOT NULL COMMENT '序列键（如 task_id/staff_id）',
  seq_name      VARCHAR(100) NOT NULL DEFAULT '' COMMENT '序列名称',
  current_value BIGINT       NOT NULL DEFAULT 1 COMMENT '当前值（下次发放的值）',
  init_value    BIGINT       NOT NULL DEFAULT 1 COMMENT '初始值',
  step          INT          NOT NULL DEFAULT 1 COMMENT '步长',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (seq_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='序列管理';
