/*
 Navicat Premium Dump SQL

 Source Server         : 腾讯云托管MySQL - 2
 Source Server Type    : MySQL
 Source Server Version : 80030 (8.0.30-cynos-3.1.19.002)
 Source Host           : sh-cynosdbmysql-grp-l6nltqsw.sql.tencentcdb.com:22853
 Source Schema         : cloud1-d6gddqzrsda16338f

 Target Server Type    : MySQL
 Target Server Version : 80030 (8.0.30-cynos-3.1.19.002)
 File Encoding         : 65001

 Date: 15/08/2026 12:20:00
*/

-- 课小满后台管理系统 - 菜单数据（完整覆盖，与 sql/init_data.sql、routes/admin.js DEFAULT_MENU_GROUPS 保持一致）
-- 一级分组（menu_type=1）：仪表盘 / 学习管理 / 成员管理 / 消息通知 / 系统监控 / 系统设置
-- menu_id 保持 1~39 稳定不变，t_role_menus 关联全部有效；仅调整归属分组 / 排序 / 名称 / 图标

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for t_menus
-- ----------------------------
DROP TABLE IF EXISTS `t_menus`;
CREATE TABLE `t_menus`  (
  `menu_id` bigint NOT NULL COMMENT '主键',
  `parent_id` bigint NOT NULL DEFAULT 0 COMMENT '父级菜单ID（0=顶级分组）',
  `menu_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '' COMMENT '菜单名称',
  `menu_path` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '' COMMENT '前端路由路径',
  `menu_icon` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '' COMMENT '图标名（对应前端图标映射）',
  `sort` int NOT NULL DEFAULT 0 COMMENT '排序',
  `menu_type` tinyint NOT NULL DEFAULT 2 COMMENT '1=分组 2=叶子',
  `menu_status` tinyint NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`menu_id`) USING BTREE,
  INDEX `idx_parent`(`parent_id` ASC) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '后台菜单' ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Records of t_menus
-- ----------------------------
-- 1. 仪表盘
INSERT INTO `t_menus` VALUES (1, 0, '仪表盘', '/dashboard', 'DashboardOutlined', 1, 1, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (3, 1, '监控仪表盘', '/dashboard/monitor', 'LineChartOutlined', 1, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (4, 1, '学习仪表盘', '/dashboard/learning', 'BookOutlined', 2, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
-- 2. 学习管理
INSERT INTO `t_menus` VALUES (5, 0, '学习管理', '/learning', 'ReadOutlined', 2, 1, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (34, 5, '待办任务', '/module/todo_tasks', 'CheckSquareOutlined', 1, 2, 1, '2026-08-14 11:28:09', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (35, 5, '打卡审核', '/module/checkin_reviews', 'AuditOutlined', 2, 2, 1, '2026-08-14 11:28:09', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (6, 5, '任务管理', '/module/tasks', 'UnorderedListOutlined', 3, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (39, 5, '任务管理（卡片模式）', '/module/card_tasks', 'ProfileOutlined', 4, 2, 1, '2026-08-18 10:00:00', '2026-08-18 10:00:00');
INSERT INTO `t_menus` VALUES (7, 5, '打卡管理', '/module/task_checkins', 'CalendarOutlined', 5, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (28, 5, '合集管理', '/module/task_collections', 'FolderOutlined', 6, 2, 1, '2026-08-12 10:13:18', '2026-08-15 12:20:00');
-- 3. 成员管理
INSERT INTO `t_menus` VALUES (8, 0, '成员管理', '/members', 'UserOutlined', 3, 1, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (9, 8, '用户管理', '/module/users', 'UserOutlined', 1, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (31, 8, '绑定管理', '/module/lp_students', 'LinkOutlined', 2, 2, 1, '2026-08-13 15:59:36', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (36, 8, '孩子档案', '/module/lp_children', 'SolutionOutlined', 3, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (37, 8, '家属关系', '/module/lp_family_members', 'HeartOutlined', 4, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (38, 8, '邀请码管理', '/module/lp_invites', 'KeyOutlined', 5, 2, 1, '2026-08-14 18:21:48', '2026-08-15 12:20:00');
-- 4. 消息通知
INSERT INTO `t_menus` VALUES (19, 0, '消息通知', '/message', 'BellOutlined', 4, 1, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (32, 19, '订阅授权', '/module/subscribe_grants', 'BellOutlined', 1, 2, 1, '2026-08-13 20:57:01', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (33, 19, '发送记录', '/module/subscribe_sends', 'SendOutlined', 2, 2, 1, '2026-08-13 20:57:01', '2026-08-15 12:20:00');
-- 5. 系统监控
INSERT INTO `t_menus` VALUES (15, 0, '系统监控', '/ops', 'FundOutlined', 5, 1, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (16, 15, '服务监控', '/module/monitors', 'MonitorOutlined', 1, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (17, 15, '接口链路', '/module/traces', 'ApiOutlined', 2, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (18, 15, '会话画像', '/module/sessions', 'MobileOutlined', 3, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (21, 15, '用户事件', '/module/user_events', 'ThunderboltOutlined', 4, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (20, 15, '文件上传记录', '/module/file_uploads', 'PictureOutlined', 5, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
-- 6. 系统设置
INSERT INTO `t_menus` VALUES (22, 0, '系统设置', '/system', 'SettingOutlined', 6, 1, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (23, 22, '管理员管理', '/module/staff', 'SafetyOutlined', 1, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (24, 22, '角色管理', '/module/roles', 'TeamOutlined', 2, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (25, 22, '菜单管理', '/module/menus', 'MenuOutlined', 3, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (26, 22, '数据字典', '/module/dicts', 'DatabaseOutlined', 4, 2, 1, '2026-08-11 15:59:48', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (27, 22, '序列管理', '/module/seqs', 'OrderedListOutlined', 5, 2, 1, '2026-08-11 22:07:26', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (29, 22, '操作审计', '/module/staff_events', 'AuditOutlined', 6, 2, 1, '2026-08-12 10:51:24', '2026-08-15 12:20:00');
INSERT INTO `t_menus` VALUES (30, 22, '小程序配置', '/module/apps', 'AppstoreOutlined', 7, 2, 1, '2026-08-11 15:17:58', '2026-08-15 12:20:00');

SET FOREIGN_KEY_CHECKS = 1;
