/**
 * 多小程序表命名规范（逻辑表名 → 物理表名）
 *
 * 隔离策略：用表前缀区分业务归属，业务表不再加 app_id 列
 * - t_      系统表（多小程序共用）：users / staff / menus / seqs / file_uploads / apps ...
 * - t_lp_   课小满业务表：tasks / task_checkins / task_collections ...
 *
 * db.js 通过 Proxy 拦截 db.from(name)，自动把逻辑表名映射为物理表名，
 * 因此各路由代码无需改动，统一按逻辑名书写。
 */
const TABLE_MAP = {
  // ==================== 系统表（t_） ====================
  users: "t_users",
  user_sessions: "t_user_sessions",
  user_events: "t_user_events",
  staff: "t_staff",
  staff_events: "t_staff_events",
  roles: "t_roles",
  menus: "t_menus",
  role_menus: "t_role_menus",
  dict_types: "t_dict_types",
  dict_items: "t_dict_items",
  seqs: "t_seqs",
  service_monitor: "t_service_monitor",
  api_trace: "t_api_trace",
  file_uploads: "t_file_uploads",
  content_audits: "t_content_audits",
  apps: "t_apps",
  staff_apps: "t_staff_apps",

  // ==================== 课小满业务表（t_lp_） ====================
  tasks: "t_lp_tasks",
  task_assignees: "t_lp_task_assignees",
  task_checkins: "t_lp_task_checkins",
  task_collections: "t_lp_task_collections",
  task_timeline: "t_lp_task_timeline",
  point_logs: "t_lp_point_logs",
  badge_unlocks: "t_lp_badge_unlocks",
  lp_students: "t_lp_students",
  lp_invites: "t_lp_invites",
  lp_children: "t_lp_children",
  lp_family_members: "t_lp_family_members",
  subscribe_grants: "t_lp_subscribe_grants",
  subscribe_sends: "t_lp_subscribe_sends",
  notify_templates: "t_lp_notify_templates",
  notifications: "t_lp_notifications",
};

/** 是否已带前缀（物理表名直接透传） */
function isPhysical(name) {
  return /^t_lp_|^t_/.test(name);
}

/**
 * 逻辑表名 → 物理表名
 * @param {string} name 逻辑表名（如 tasks）或已带前缀的物理表名（原样返回）
 */
function mapTable(name) {
  const key = String(name || "");
  if (isPhysical(key)) return key;
  return TABLE_MAP[key] || key;
}

module.exports = { mapTable, TABLE_MAP };
