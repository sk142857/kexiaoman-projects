/**
 * 后台管理路由（cloud admin）
 * - 登录签发 JWT
 * - adminAuth 中间件校验 token
 * - 单一管理员账号，账号初始化/改密通过 SQL 完成（见 sql/init_data.sql）
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql, formatDate, withLock } = require("../utils");
const { uploadImage, logUpload, bindBizId, removeFiles, dupSharedImages, compressVideo, storageFileExists, VIDEO_MAX_SIZE } = require("../storage");
const { crudRouter } = require("./adminApi");
const { nextSeq } = require("../seq");
const { logStaffEvent } = require("../staffAudit");
const { logTaskEvent } = require("../taskTimeline");
const { listStaffApps, listAllApps, isStaffAllowedApp, invalidateAppConfig } = require("../apps");
const { createInvite, inviteById, genUniqueInviteCode, familyScope } = require("./lpAuth");
const { cachedStaffRows, cachedCollectionNames, cachedDictItems, invalidateStaffRows, invalidateCollectionRows, invalidateDictItems, normalizeCheckinType, normalizeTaskSource, applyTaskStatusPoints, awardCheckinApproved, deductCheckinDeleted, deductTaskDeleted, staffPoints, staffPointsMap, recentPointLogs, syncBadgeUnlocks, taskAllRecipientsDone } = require("../learningLib");
const { invalidatePrefix } = require("../cache");
const { invalidateParams } = require("../params");
const { isProtectedStaff } = require("../protect");
const { sendReviewNotification } = require("../subscribeLib");
const { notifyReviewResult, notifyTaskAssigned, notifyTaskDone } = require("../notificationLib");
const { collectPurgeManifest, executePurge, collectUserPurgeManifest, executeUserPurge } = require("../purgeLib");

const router = express.Router();

// JWT 密钥：仅接受环境变量 ADMIN_JWT_SECRET（或 JWT_SECRET）。
// 安全审计 S2：不再回退内置密钥（"123456" 为可预测常量，任何人可伪造管理员 Token），
// 未配置时后台登录/鉴权全部拒绝（fail-closed），小程序业务不受影响。
const JWT_SECRET = (process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || "").trim();
if (!JWT_SECRET) {
  console.error("[admin] 致命错误：未配置 ADMIN_JWT_SECRET（JWT 签名密钥），后台管理已禁用。");
  console.error("[admin] 请立即在云托管控制台配置环境变量 ADMIN_JWT_SECRET（建议 ≥32 位随机串）后重启服务。");
}
const JWT_SECRET_FINAL = JWT_SECRET;
const ADMIN_SECRET_READY = !!JWT_SECRET_FINAL;
const JWT_EXPIRES = process.env.ADMIN_JWT_EXPIRES || "12h";

// ==================== 登录/初始化限流（进程内简单滑动窗口） ====================
const attemptMap = new Map();
function getIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}
/** 是否允许本次尝试（窗口内未超限返回 true） */
function rateAllow(key, max, windowMs) {
  const now = Date.now();
  const rec = attemptMap.get(key);
  if (!rec || now - rec.start >= windowMs) return true;
  return rec.count < max;
}
/** 记录一次尝试（滑动窗口） */
function recordAttempt(key, windowMs) {
  const now = Date.now();
  const rec = attemptMap.get(key);
  if (!rec || now - rec.start >= windowMs) {
    attemptMap.set(key, { start: now, count: 1 });
  } else {
    rec.count += 1;
  }
}
function clearAttempt(key) {
  attemptMap.delete(key);
}

/** 签发 token（未配置密钥时拒绝签发，fail-closed） */
function signToken(staff) {
  if (!ADMIN_SECRET_READY) throw new Error("后台 JWT 密钥未配置，无法登录（请配置 ADMIN_JWT_SECRET）");
  return jwt.sign(
    { staffId: staff.staff_id, username: staff.staff_username, role: staff.staff_role },
    JWT_SECRET_FINAL,
    { expiresIn: JWT_EXPIRES }
  );
}

/** admin 鉴权中间件：校验 Authorization: Bearer <token> */
async function adminAuth(req, res, next) {
  try {
    if (!ADMIN_SECRET_READY) {
      return res.status(500).json({ code: 500, msg: "后台 JWT 密钥未配置，服务已禁用后台管理", data: null });
    }
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) {
      return res.status(401).json({ code: 401, msg: "未登录或登录已过期", data: null });
    }
    const decoded = jwt.verify(token, JWT_SECRET_FINAL);
    // 校验员工仍存在且启用
    const { data: rows, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_role, staff_status")
      .match({ staff_id: decoded.staffId })
      .limit(1);
    if (error) throw error;
    const staff = rows && rows[0];
    if (!staff || staff.staff_status !== 1) {
      return res.status(401).json({ code: 401, msg: "账号不可用", data: null });
    }
    req.staff = { staff_id: String(staff.staff_id), username: staff.staff_username, nickname: staff.staff_nickname, role: staff.staff_role };
    // 加载该管理员可管理的小程序（admin 角色=全部，其余按 staff_apps 授权）
    try {
      req.staff.apps = await listStaffApps(staff.staff_id, staff.staff_role);
    } catch (_) {
      req.staff.apps = [];
    }
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, msg: "登录已过期，请重新登录", data: null });
  }
}

// ==================== 后台小程序上下文（requireAppAccess） ====================
// 多小程序共享后台：所有 /api 模块请求都必须落在某个小程序内。
// 前端通过 query（GET）/ body（POST）或 X-App-Id 头携带 app_id；未携带时默认第一个可管理的小程序。
// 同时做越权校验：请求的小程序不在该员工可管理范围则回退/拒绝。
async function requireAppAccess(req, res, next) {
  try {
    const staff = req.staff || {};
    const reqApp = (req.query && req.query.app)
      || (req.body && req.body.app)
      || (req.headers && (req.headers["x-app-id"] || req.headers["X-App-Id"]))
      || "";
    const apps = Array.isArray(staff.apps) ? staff.apps : await listStaffApps(staff.staff_id, staff.role);
    let current = apps.find(a => a.app_id === reqApp) || null;
    if (!current) current = apps[0] || null;
    if (!current) {
      return res.status(403).json({ code: 403, msg: "该账号未授权管理任何小程序", data: null });
    }
    req.appId = current.app_id;
    req.appName = current.app_name || current.app_id;
    req.staff.apps = apps;
    next();
  } catch (e) {
    console.error("[admin] requireAppAccess error", e);
    return res.json(fail("服务异常", 500));
  }
}

// ==================== 登录 ====================
router.post("/login", async (req, res) => {
  try {
    if (!ADMIN_SECRET_READY) {
      return res.json(fail("后台 JWT 密钥未配置，请先配置 ADMIN_JWT_SECRET 环境变量", 500));
    }
    const { username, password } = req.body;
    const rlKey = `login:${getIp(req)}:${username || ""}`;
    // 同一 IP+账号 15 分钟内最多 5 次尝试
    if (!rateAllow(rlKey, 5, 15 * 60 * 1000)) {
      return res.json(fail("登录尝试过于频繁，请 15 分钟后再试", 429));
    }
    if (!username || !password) {
      recordAttempt(rlKey, 15 * 60 * 1000);
      return res.json(fail("请输入账号和密码"));
    }

    const { data: rows, error } = await db.from("staff")
      .select()
      .eq("staff_username", username)
      .limit(1);
    if (error) throw error;
    const staff = rows && rows[0];
    if (!staff) {
      recordAttempt(rlKey, 15 * 60 * 1000);
      console.warn(`[admin] login failed: ${username} from ${getIp(req)}`);
      logStaffEvent({ req, staff: { username }, eventType: "login_fail", eventName: "登录失败（账号不存在）", module: "auth", apiPath: "/admin/login", extra: { reason: "账号不存在" } });
      return res.json(fail("账号或密码错误"));
    }
    if (staff.staff_status !== 1) {
      recordAttempt(rlKey, 15 * 60 * 1000);
      console.warn(`[admin] login failed(disabled): ${username} from ${getIp(req)}`);
      logStaffEvent({ req, staff: { staff_id: staff.staff_id, username }, eventType: "login_fail", eventName: "登录失败（账号已禁用）", module: "auth", apiPath: "/admin/login", extra: { reason: "账号已禁用" } });
      return res.json(fail("账号已被禁用"));
    }

    const match = bcrypt.compareSync(password, staff.staff_password);
    if (!match) {
      recordAttempt(rlKey, 15 * 60 * 1000);
      console.warn(`[admin] login failed: ${username} from ${getIp(req)}`);
      logStaffEvent({ req, staff: { staff_id: staff.staff_id, username }, eventType: "login_fail", eventName: "登录失败（密码错误）", module: "auth", apiPath: "/admin/login", extra: { reason: "密码错误" } });
      return res.json(fail("账号或密码错误"));
    }

    clearAttempt(rlKey);
    const token = signToken(staff);
    logStaffEvent({ req, staff: { staff_id: staff.staff_id, username: staff.staff_username }, eventType: "login", eventName: "登录成功", module: "auth", apiPath: "/admin/login" });
    res.json(ok({
      token,
      staff: {
        staff_id: String(staff.staff_id),
        username: staff.staff_username,
        nickname: staff.staff_nickname,
        role: staff.staff_role,
      },
    }, "登录成功"));
  } catch (e) {
    console.error("[admin] login error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 当前登录用户 ====================
router.get("/me", adminAuth, (req, res) => {
  res.json(ok({ staff: req.staff }));
});

// ==================== 可管理的小程序列表（后台小程序切换器） ====================
router.get("/myApps", adminAuth, async (req, res) => {
  try {
    const staff = req.staff || {};
    const apps = Array.isArray(staff.apps) && staff.apps.length > 0
      ? staff.apps
      : await listStaffApps(staff.staff_id, staff.role);
    res.json(ok({ apps, current: (req.query.app && apps.find(a => a.app_id === req.query.app)) ? req.query.app : (apps[0] || {}).app_id || "" }));
  } catch (e) {
    console.error("[admin] myApps error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 退出登录（记审计日志；JWT 无状态，服务端仅留痕） ====================
router.post("/logout", adminAuth, (req, res) => {
  logStaffEvent({ req, staff: req.staff, eventType: "logout", eventName: "退出登录", module: "auth", apiPath: "/admin/logout" });
  res.json(ok(null, "已退出登录"));
});

// ==================== 菜单权限中间件（非管理员按角色-菜单鉴权） ====================
// 管理员（admin）拥有全部菜单权限；其余角色只能访问其角色已分配菜单对应的模块
const MODULE_BIZ = ["users", "monitors", "traces", "sessions", "file_uploads", "user_events", "staff", "roles", "menus", "tasks", "task_checkins", "task_collections", "subjects", "lp_students", "lp_children", "lp_family_members", "lp_family_tree", "dict_types", "dict_items", "seqs", "staff_events", "apps", "subscribe_grants", "subscribe_sends", "todo_tasks", "checkin_reviews", "content_audits", "notify_templates", "notifications", "system_params", "account_cancellations", "system_error_logs", "staff_purges"];
// 共享参考数据模块：任意角色均可读取（下拉选项/筛选条件依赖，如任务的科目字典），写入仍需模块权限
const REFERENCE_READ_BIZ = ["dict_types", "dict_items"];
// 字典读写接口统一归属「数据字典」菜单（/module/dicts），写操作按该菜单路径鉴权
const DICT_WRITE_BIZ = ["dict_types", "dict_items"];
// 某些菜单复用其它模块的后端接口：如「任务管理（卡片模式）」( /module/card_tasks ) 页面复用 /api/tasks 接口
const BIZ_ALIAS_PATHS = { tasks: ["/module/tasks", "/module/card_tasks"] };
async function requireModulePermission(req, res, next) {
  try {
    const role = (req.staff && req.staff.role) || "admin";
    if (role === "admin") return next();
    const biz = (req.params && req.params.biz) || "";
    // 非模块级接口（如 /api/upload）不参与菜单校验
    if (!biz || !MODULE_BIZ.includes(biz)) return next();
    // 共享参考数据：GET（list/detail）开放给所有角色，其余操作仍走模块权限校验
    if (REFERENCE_READ_BIZ.includes(biz) && (req.method || "").toUpperCase() === "GET") return next();
    // 字典写操作（create/update/delete）统一按「数据字典」菜单（/module/dicts）鉴权
    const moduleBiz = DICT_WRITE_BIZ.includes(biz) ? "dicts" : biz;

    const { data: rmRows, error: rmErr } = await db.from("role_menus")
      .select("menu_id")
      .eq("role_code", role)
      .limit(500);
    if (rmErr) throw rmErr;
    const menuIds = (rmRows || []).map(r => r.menu_id);
    // 以数据库授权为准：角色无任何菜单授权时直接拒绝
    if (menuIds.length === 0) {
      console.warn(`[admin] 菜单权限校验拒绝：角色 ${role} 无任何菜单授权（role_menus 为空）`);
      return res.json(fail("无权访问该模块", 403));
    }

    const { data: mRows, error: mErr } = await db.from("menus")
      .select("menu_path")
      .in("menu_id", menuIds)
      .match({ menu_status: 1 })
      .limit(500);
    if (mErr) throw mErr;
    const paths = (mRows || []).map(m => m.menu_path || "").filter(Boolean);

    const allowedPaths = BIZ_ALIAS_PATHS[moduleBiz] || [`/module/${moduleBiz}`];
    if (paths.some(p => allowedPaths.includes(p))) return next();
    console.warn(`[admin] 菜单权限校验拒绝：角色 ${role} 访问 /module/${moduleBiz} 未授权（期望=[${allowedPaths.join(",")}], menuIds=[${menuIds.join(",")}], paths=[${paths.join(",")}]）`);
    return res.json(fail("无权访问该模块", 403));
  } catch (e) {
    console.error("[admin] 菜单权限校验异常", e);
    return res.json(fail("服务异常", 500));
  }
}

// ==================== 内置默认菜单（兜底：数据库菜单缺失/迁移未执行时也能用） ====================
// 与 sql/init_data.sql、sql/init_menus.sql 种子保持一致（课小满后台专用，menu_id 稳定 1~38）
// 一级分组：仪表盘 / 学习管理 / 成员管理 / 消息通知 / 系统监控 / 系统设置
const DEFAULT_MENU_GROUPS = [
  { id: "1", parent_id: "0", name: "仪表盘", path: "/dashboard", icon: "DashboardOutlined", sort: 1, type: "group", status: 1, children: [
    { id: "3", name: "监控仪表盘", path: "/dashboard/monitor", icon: "LineChartOutlined", type: "leaf" },
    { id: "4", name: "学习仪表盘", path: "/dashboard/learning", icon: "BookOutlined", type: "leaf" },
  ]},
  { id: "5", parent_id: "0", name: "学习管理", path: "/learning", icon: "ReadOutlined", sort: 2, type: "group", status: 1, children: [
    { id: "34", name: "待办任务", path: "/module/todo_tasks", icon: "CheckSquareOutlined", type: "leaf" },
    { id: "35", name: "打卡审核", path: "/module/checkin_reviews", icon: "AuditOutlined", type: "leaf" },
    { id: "6", name: "任务管理", path: "/module/tasks", icon: "UnorderedListOutlined", type: "leaf" },
    { id: "39", name: "任务管理（卡片模式）", path: "/module/card_tasks", icon: "ProfileOutlined", type: "leaf" },
    { id: "7", name: "打卡管理", path: "/module/task_checkins", icon: "CalendarOutlined", type: "leaf" },
    { id: "28", name: "合集管理", path: "/module/task_collections", icon: "FolderOutlined", type: "leaf" },
    { id: "46", name: "科目管理", path: "/module/subjects", icon: "BookOutlined", type: "leaf" },
  ]},
  { id: "8", parent_id: "0", name: "成员管理", path: "/members", icon: "UserOutlined", sort: 3, type: "group", status: 1, children: [
    { id: "9", name: "用户管理", path: "/module/users", icon: "UserOutlined", type: "leaf" },
    { id: "31", name: "绑定管理", path: "/module/lp_students", icon: "LinkOutlined", type: "leaf" },
    { id: "36", name: "孩子档案", path: "/module/lp_children", icon: "SolutionOutlined", type: "leaf" },
    { id: "37", name: "家属关系", path: "/module/lp_family_members", icon: "HeartOutlined", type: "leaf" },
    { id: "38", name: "邀请码管理", path: "/module/lp_invites", icon: "KeyOutlined", type: "leaf" },
    { id: "40", name: "家庭关系", path: "/module/lp_family_tree", icon: "ApartmentOutlined", type: "leaf" },
    { id: "45", name: "注销管理", path: "/module/account_cancellations", icon: "StopOutlined", type: "leaf" },
    { id: "50", name: "物理清除审计", path: "/module/staff_purges", icon: "DeleteOutlined", type: "leaf" },
  ]},
  { id: "19", parent_id: "0", name: "消息通知", path: "/message", icon: "BellOutlined", sort: 4, type: "group", status: 1, children: [
    { id: "32", name: "订阅授权", path: "/module/subscribe_grants", icon: "BellOutlined", type: "leaf" },
    { id: "33", name: "发送记录", path: "/module/subscribe_sends", icon: "SendOutlined", type: "leaf" },
    { id: "42", name: "通知模板", path: "/module/notify_templates", icon: "FormOutlined", type: "leaf" },
    { id: "43", name: "系统通知", path: "/module/notifications", icon: "BellOutlined", type: "leaf" },
  ]},
  { id: "15", parent_id: "0", name: "系统监控", path: "/ops", icon: "FundOutlined", sort: 5, type: "group", status: 1, children: [
    { id: "16", name: "服务监控", path: "/module/monitors", icon: "MonitorOutlined", type: "leaf" },
    { id: "17", name: "接口链路", path: "/module/traces", icon: "ApiOutlined", type: "leaf" },
    { id: "18", name: "会话画像", path: "/module/sessions", icon: "MobileOutlined", type: "leaf" },
    { id: "21", name: "用户事件", path: "/module/user_events", icon: "ThunderboltOutlined", type: "leaf" },
    { id: "20", name: "文件上传记录", path: "/module/file_uploads", icon: "PictureOutlined", type: "leaf" },
    { id: "41", name: "内容安全", path: "/module/content_audits", icon: "SafetyOutlined", type: "leaf" },
    { id: "47", name: "错误日志", path: "/module/system_error_logs", icon: "BugOutlined", type: "leaf" },
  ]},
  { id: "22", parent_id: "0", name: "系统设置", path: "/system", icon: "SettingOutlined", sort: 6, type: "group", status: 1, children: [
    { id: "23", name: "管理员管理", path: "/module/staff", icon: "SafetyOutlined", type: "leaf" },
    { id: "24", name: "角色管理", path: "/module/roles", icon: "TeamOutlined", type: "leaf" },
    { id: "25", name: "菜单管理", path: "/module/menus", icon: "MenuOutlined", type: "leaf" },
    { id: "26", name: "数据字典", path: "/module/dicts", icon: "DatabaseOutlined", type: "leaf" },
    { id: "27", name: "序列管理", path: "/module/seqs", icon: "OrderedListOutlined", type: "leaf" },
    { id: "29", name: "操作审计", path: "/module/staff_events", icon: "AuditOutlined", type: "leaf" },
    { id: "30", name: "小程序配置", path: "/module/apps", icon: "AppstoreOutlined", type: "leaf" },
    { id: "44", name: "系统参数", path: "/module/system_params", icon: "SlidersOutlined", type: "leaf" },
  ]},
];

/** 内置默认菜单兜底树（按角色过滤：管理员全部，学生/家长/家属仅学习管理） */
function buildDefaultTree(role) {
  if (role === "admin") return DEFAULT_MENU_GROUPS;
  if (["student", "parent", "family"].includes(role)) return [DEFAULT_MENU_GROUPS[1]];
  return [];
}

/** 自愈：menus/roles/role_menus 表存在但为空时写入默认数据（幂等） */
async function ensureDefaultMenus() {
  try {
    const { data: menuRows, error: mErr } = await db.from("menus").select("menu_id").limit(1);
    if (mErr || (menuRows && menuRows.length > 0)) return;

    const flatten = [];
    for (const g of DEFAULT_MENU_GROUPS) {
      const gid = await nextSeq("menu_id");
      flatten.push({ menu_id: gid, parent_id: 0, menu_name: g.name, menu_path: g.path, menu_icon: g.icon, sort: g.sort || 1, menu_type: g.type === 'leaf' ? 2 : 1, menu_status: 1, created_at: nowSql(), updated_at: nowSql() });
      for (const c of (g.children || [])) {
        flatten.push({ menu_id: await nextSeq("menu_id"), parent_id: gid, menu_name: c.name, menu_path: c.path, menu_icon: c.icon, sort: c.sort || 1, menu_type: 2, menu_status: 1, created_at: nowSql(), updated_at: nowSql() });
      }
    }
    for (const m of flatten) await db.from("menus").insert(m);

    const { data: roleRows, error: rErr } = await db.from("roles").select("role_id").limit(1);
    if (!rErr && !(roleRows && roleRows.length > 0)) {
      await db.from("roles").insert({ role_id: await nextSeq("role_id"), role_code: "admin", role_name: "管理员", role_status: 1, created_at: nowSql(), updated_at: nowSql() });
      await db.from("roles").insert({ role_id: await nextSeq("role_id"), role_code: "student", role_name: "学生", role_status: 1, created_at: nowSql(), updated_at: nowSql() });
      await db.from("roles").insert({ role_id: await nextSeq("role_id"), role_code: "parent", role_name: "主家长", role_status: 1, created_at: nowSql(), updated_at: nowSql() });
      await db.from("roles").insert({ role_id: await nextSeq("role_id"), role_code: "family", role_name: "家属", role_status: 1, created_at: nowSql(), updated_at: nowSql() });
      await db.from("roles").insert({ role_id: await nextSeq("role_id"), role_code: "personal", role_name: "个人", role_status: 1, created_at: nowSql(), updated_at: nowSql() });
    }

    const { data: rmRows, error: rmErr } = await db.from("role_menus").select("id").limit(1);
    if (!rmErr && !(rmRows && rmRows.length > 0)) {
      const all = flatten.map(m => ({ role_code: "admin", menu_id: m.menu_id }));
      // 学生仅学习相关菜单（按路径匹配，避免依赖序列分配的 menu_id 数字）：学习仪表盘 + 学习管理分组及子页
      // 安全审计 S5：lp_students / lp_children / lp_family_members / task_checkins 为敏感管理数据，不再授权给学生角色
      const STUDENT_MENU_PATHS = ["/dashboard", "/dashboard/learning", "/learning", "/module/todo_tasks", "/module/tasks", "/module/card_tasks", "/module/task_collections", "/module/subjects"];
      const student = flatten.filter(m => STUDENT_MENU_PATHS.includes(m.menu_path))
        .map(m => ({ role_code: "student", menu_id: m.menu_id }));
      for (const r of [...all, ...student]) {
        await db.from("role_menus").insert({ id: await nextSeq("role_menu_id"), role_code: r.role_code, menu_id: r.menu_id, created_at: nowSql() });
      }
    }
    console.log("[admin] 已自愈写入默认菜单/角色数据");
  } catch (e) {
    console.warn("[admin] 菜单自愈失败（表可能未迁移），将回退内置默认菜单", e.message);
  }
}

/** 自愈：数据字典表存在但为空时写入默认字典（科目等），幂等 */
async function ensureDefaultDicts() {
  try {
    const { data: typeRows, error: tErr } = await db.from("dict_types").select("dict_id").limit(1);
    if (tErr) throw tErr;
    if (typeRows && typeRows.length > 0) return;
    await db.from("dict_types").insert([
      { dict_id: await nextSeq("dict_type_id"), dict_code: "subject", dict_name: "科目", dict_status: 1, created_at: nowSql(), updated_at: nowSql() },
      { dict_id: await nextSeq("dict_type_id"), dict_code: "gender", dict_name: "性别", dict_status: 1, created_at: nowSql(), updated_at: nowSql() },
      { dict_id: await nextSeq("dict_type_id"), dict_code: "task_status", dict_name: "任务状态", dict_status: 1, created_at: nowSql(), updated_at: nowSql() },
    ]);
    const items = [
      ["subject", "语文", "语文"], ["subject", "数学", "数学"], ["subject", "英语", "英语"],
      ["subject", "阅读", "阅读"], ["subject", "作业", "作业"], ["subject", "运动", "运动"],
      ["gender", "0", "保密"], ["gender", "1", "男"], ["gender", "2", "女"],
      ["task_status", "todo", "待完成"], ["task_status", "doing", "进行中"], ["task_status", "done", "已完成"],
    ];
    for (const [code, value, label] of items) {
      await db.from("dict_items").insert({ item_id: await nextSeq("dict_item_id"), dict_code: code, item_value: value, item_label: label, sort: 1, item_status: 1, created_at: nowSql(), updated_at: nowSql() });
    }
    invalidateDictItems(["subject", "gender", "task_status"]);
    console.log("[admin] 已自愈写入默认数据字典");
  } catch (e) {
    console.warn("[admin] 数据字典自愈失败（表可能未迁移）", e.message);
  }
}

/** 获取角色可见菜单树（动态菜单来源） */
async function buildMenuTreeForRole(role) {
  let menuRows = [];
  if (role === "admin") {
    const { data, error } = await db.from("menus")
      .select("menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status")
      .match({ menu_status: 1 })
      .order("sort", { ascending: true })
      .limit(200);
    if (error) throw error;
    menuRows = data || [];
  } else {
    const { data: rmRows, error: rmErr } = await db.from("role_menus")
      .select("menu_id").eq("role_code", role).limit(500);
    if (rmErr) throw rmErr;
    const ids = (rmRows || []).map(r => r.menu_id);
    if (ids.length === 0) return [];
    const { data, error } = await db.from("menus")
      .select("menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status")
      .in("menu_id", ids)
      .match({ menu_status: 1 })
      .order("sort", { ascending: true })
      .limit(200);
    if (error) throw error;
    menuRows = data || [];

    // 自动补全已授权菜单的祖先分组（如子菜单已授权但父级分组未授权时，保留层级结构而非顶成一级）
    let parentIds = [...new Set((menuRows || []).map(m => m.parent_id).filter(p => p && p !== 0))];
    let guard = 0;
    while (parentIds.length > 0 && guard < 10) {
      const owned = new Set((menuRows || []).map(m => String(m.menu_id)));
      const missing = parentIds.filter(p => !owned.has(String(p)));
      if (missing.length === 0) break;
      const { data: parents, error: pErr } = await db.from("menus")
        .select("menu_id, parent_id, menu_name, menu_path, menu_icon, sort, menu_type, menu_status")
        .in("menu_id", missing)
        .match({ menu_type: 1, menu_status: 1 })
        .limit(200);
      if (pErr) throw pErr;
      const found = (parents || []).filter(p => !owned.has(String(p.menu_id)));
      if (found.length === 0) break;
      menuRows = [...menuRows, ...found];
      parentIds = [...new Set(found.map(p => p.parent_id).filter(p => p && p !== 0))];
      guard++;
    }
  }
  const nodes = new Map();
  menuRows.forEach(m => nodes.set(String(m.menu_id), {
    id: String(m.menu_id),
    parent_id: String(m.parent_id || 0),
    name: m.menu_name,
    path: m.menu_path || "",
    icon: m.menu_icon || "",
    sort: m.sort || 0,
    type: m.menu_type === 1 ? 'group' : 'leaf',
    status: m.menu_status,
    children: [],
  }));
  const roots = [];
  menuRows.forEach(m => {
    const node = nodes.get(String(m.menu_id));
    const parent = nodes.get(String(m.parent_id || 0));
    if (parent && parent.id !== node.id) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

// ==================== 动态菜单接口 ====================
router.get("/menus", adminAuth, async (req, res) => {
  const role = req.staff.role || "admin";
  try {
    await ensureDefaultMenus();
    await ensureDefaultDicts();
    const tree = await buildMenuTreeForRole(role);
    // 菜单完全以数据库 role_menus/menus 为准：无授权即不展示（与 requireModulePermission 校验一致，避免菜单可见但点击被拒）
    res.json(ok({ menus: tree, role }));
  } catch (e) {
    console.error("[admin] menus error，回退内置默认菜单", e);
    res.json(ok({ menus: buildDefaultTree(role), role }));
  }
});

// 全量菜单树（角色分配/菜单管理用，仅管理员）
router.get("/menus/all", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    await ensureDefaultMenus();
    const tree = await buildMenuTreeForRole("admin");
    res.json(ok({ menus: (tree && tree.length > 0) ? tree : buildDefaultTree("admin") }));
  } catch (e) {
    console.error("[admin] menus/all error，回退内置默认菜单", e);
    res.json(ok({ menus: buildDefaultTree("admin") }));
  }
});

// ==================== 业务 CRUD 模块（adminAuth 鉴权保护） ====================
// 所有业务模块挂在 /api 下，先过 adminAuth 鉴权；再确定小程序上下文（requireAppAccess）；
// 最后按角色-菜单做模块级权限控制
router.use("/api", adminAuth);
router.use("/api", requireAppAccess);
router.use("/api/:biz", requireModulePermission);

/** 头像字符：昵称首字符，字母转大写 */
function avatarChar(nickname) {
  const n = String(nickname || "").trim();
  const ch = n.charAt(0) || "微";
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

// 用户管理（可写：昵称/性别/头像/状态；额外资料审核路由 /reviewProfile）
router.post("/api/users/reviewProfile", adminAuth, async (req, res) => {
  try {
    const { id, action, note } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("users").select().eq("user_id", id).limit(1);
    if (error) throw error;
    const u = rows && rows[0];
    if (!u) return res.json(fail("用户不存在"));
    const values = {
      profile_reviewed_at: nowSql(),
      profile_reviewer: (req.staff && req.staff.username) || "",
    };
    if (action === "reject") {
      values.profile_review_status = "rejected";
      values.nickname_pending = "";
      values.avatar_pending = "";
      values.avatar_hd_pending = "";
      values.gender_pending = 0;
    } else {
      values.profile_review_status = "approved";
      if (u.nickname_pending) {
        values.nickname = u.nickname_pending;
        values.avatar_emoji = avatarChar(u.nickname_pending);
      }
      if (u.avatar_pending) {
        values.avatar = u.avatar_pending;
        values.avatar_hd = u.avatar_hd_pending || "";
      }
      if (u.gender_pending) values.gender = Number(u.gender_pending);
      values.nickname_pending = "";
      values.avatar_pending = "";
      values.avatar_hd_pending = "";
      values.gender_pending = 0;
    }
    const { error: upErr } = await db.from("users").update(values).eq("user_id", id);
    if (upErr) throw upErr;
    logStaffEvent({ req, staff: req.staff, eventType: "review", eventName: `审核用户资料（${action === "reject" ? "驳回" : "通过"}）`, module: "users", apiPath: "/api/users/reviewProfile", bizId: id, extra: note ? { action, note } : { action } });
    res.json(ok(null, action === "reject" ? "已驳回" : "审核通过"));
  } catch (e) {
    console.error("[admin] users reviewProfile error", e);
    res.json(fail("服务异常", 500));
  }
});
router.use("/api/users", crudRouter({
  table: "users", pk: "user_id",
  writable: ["nickname", "gender", "avatar", "avatar_hd", "user_status", "nickname_pending", "avatar_pending", "profile_review_status"],
  search: ["openid", "nickname", "user_uid"],
  filters: ["user_status", "profile_review_status"],
  appField: "app_id",
  // 丰富展示：绑定身份角色、绑定账号、邀请码、账号锁定状态（列表/详情均附加）
  enrich: enrichUsersLp,
  // 删除小程序用户：全量级联清理（画像/事件/媒体 + 绑定的学生/家长/家属账号及其数据），与员工删除同等最高权限
  onAfterDelete: async (req, record, id) => {
    await cascadeDeleteUserData(record && record.openid, (req.staff && req.staff.staff_id) || 0);
  },
}));

// ==================== 用户列表丰富展示 ====================
// 用户 ↔ 绑定（lp_students）↔ 员工角色（staff）↔ 绑定邀请码（lp_invites.bound_openid）
async function enrichUsersLp(list) {
  const rows = Array.isArray(list) ? list : (list ? [list] : []);
  if (rows.length === 0) return list;
  const openids = [...new Set(rows.map(r => r.openid).filter(Boolean))];
  const bindMap = {};
  const staffMap = {};
  const inviteMap = {};
  try {
    if (openids.length > 0) {
      const { data: binds, error: bErr } = await db.from("lp_students")
        .select("openid, staff_id, bound_status").eq("app_id", "miniprogram-kxm")
        .in("openid", openids).limit(openids.length);
      if (!bErr) (binds || []).forEach(b => { if (!bindMap[b.openid]) bindMap[b.openid] = b; });
      const staffIds = [...new Set((binds || []).map(b => Number(b.staff_id)).filter(v => v > 0))];
      if (staffIds.length > 0) {
        const { data: staffs, error: sErr } = await db.from("staff")
          .select("staff_id, staff_nickname, staff_role").in("staff_id", staffIds).limit(staffIds.length);
        if (!sErr) (staffs || []).forEach(s => { staffMap[String(s.staff_id)] = s; });
      }
      const { data: invites, error: iErr } = await db.from("lp_invites")
        .select("invite_id, invite_code, status, bound_openid")
        .eq("app_id", "miniprogram-kxm").in("bound_openid", openids)
        .order("invite_id", { ascending: false }).limit(Math.max(50, openids.length * 2));
      if (!iErr) (invites || []).forEach(iv => { if (!inviteMap[iv.bound_openid]) inviteMap[iv.bound_openid] = iv; });
    }
  } catch (_) { /* 关联信息缺失不影响主列表 */ }
  const now = Date.now();
  return rows.map(r => {
    const bind = bindMap[r.openid] || null;
    const staff = bind ? staffMap[String(bind.staff_id)] : null;
    const inv = inviteMap[r.openid] || null;
    const lockedUntil = r.locked_until ? new Date(r.locked_until).getTime() : 0;
    const lockActive = lockedUntil > now;
    return {
      ...r,
      _boundStaffId: bind ? String(bind.staff_id) : "",
      _boundStaffNickname: staff ? staff.staff_nickname : "",
      _role: staff ? staff.staff_role : "",
      _boundStatus: bind ? bind.bound_status : 0,
      _inviteCode: inv ? inv.invite_code : "",
      _inviteStatus: inv ? inv.status : "",
      _lockActive: lockActive,
      _lockStatus: lockActive ? "locked" : (Number(r.user_status) === 0 ? "disabled" : "normal"),
      _lockRemainMs: lockActive ? lockedUntil - now : 0,
    };
  });
}

// ==================== 用户账号锁定（按 user_id，含时效） ====================
// 锁定后该用户小程序登录/请求实时被拦（lpAuth 按 t_users.locked_until 复核）；
// 锁定与解锁均写入 staff_events 审计，便于追踪操作人/原因/时效
router.post("/api/users/lock", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id, hours, reason } = req.body || {};
    const uid = Number(id);
    if (!uid) return res.json(fail("缺少用户ID"));
    const { data: rows } = await db.from("users")
      .select("openid, user_uid, nickname").eq("user_id", uid).limit(1);
    const u = rows && rows[0];
    if (!u) return res.json(fail("用户不存在"));
    const h = Math.max(1, Math.min(Number(hours) || 24, 24 * 365)); // 1 小时 ~ 365 天
    const until = new Date(Date.now() + h * 3600 * 1000);
    await db.from("users").update({
      locked_until: until,
      locked_reason: String(reason || "").slice(0, 255),
      locked_by: (req.staff && req.staff.username) || "",
      locked_at: nowSql(),
      updated_at: nowSql(),
    }).eq("user_id", uid);
    const durationText = h % 24 === 0 ? `${h / 24} 天` : `${h} 小时`;
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "锁定用户账号", module: "users", apiPath: "/api/users/lock", bizId: uid, extra: { user_uid: u.user_uid, nickname: u.nickname, hours: h, until: until.toISOString(), reason: reason || "" } });
    res.json(ok({ locked_until: until, durationText }, `已锁定 ${durationText}`));
  } catch (e) {
    console.error("[admin] users lock error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/api/users/unlock", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id } = req.body || {};
    const uid = Number(id);
    if (!uid) return res.json(fail("缺少用户ID"));
    const { data: rows } = await db.from("users")
      .select("openid, user_uid, nickname").eq("user_id", uid).limit(1);
    const u = rows && rows[0];
    if (!u) return res.json(fail("用户不存在"));
    await db.from("users").update({
      locked_until: null,
      locked_reason: "",
      updated_at: nowSql(),
    }).eq("user_id", uid);
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "解锁用户账号", module: "users", apiPath: "/api/users/unlock", bizId: uid, extra: { user_uid: u.user_uid, nickname: u.nickname } });
    res.json(ok(null, "已解锁"));
  } catch (e) {
    console.error("[admin] users unlock error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 用户冗余数据物理清理（用户管理 → 物理清理） ====================
// 两段式：purgePreview 返回完整删除审计清单（openid 维度数据 + 因此孤儿化的业务账号数据），
// purge 执行物理删除并写入「物理清除审计」（target_kind=user）。
// 仅删除该用户（openid）自己相关的数据/绑定/关联；若绑定的业务账号因此完全孤儿化，按单账号模式一并清除，
// 绝不触碰其它 openid 关联的家庭成员/孩子数据。
async function loadOpenidByUserId(userId) {
  const { data } = await db.from("users").select("openid").eq("user_id", Number(userId)).limit(1);
  return (data && data[0] && data[0].openid) || "";
}

router.get("/api/users/purgePreview", adminAuth, async (req, res) => {
  try {
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可操作", 403));
    const { userId } = req.query;
    if (!userId) return res.json(fail("缺少用户 ID"));
    const openid = await loadOpenidByUserId(userId);
    if (!openid) return res.json(fail("用户不存在"));
    const manifest = await collectUserPurgeManifest(openid);
    const { orphan_staff_ids, ...out } = manifest;
    res.json(ok(out));
  } catch (e) {
    console.error("[admin] users purgePreview error", e);
    res.json(fail((e && e.message) || "服务异常", 400));
  }
});

router.post("/api/users/purge", adminAuth, async (req, res) => {
  try {
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可操作", 403));
    const { userId } = req.body || {};
    if (!userId) return res.json(fail("缺少用户 ID"));
    const openid = await loadOpenidByUserId(userId);
    if (!openid) return res.json(fail("用户不存在"));
    const result = await executeUserPurge(openid, (req.staff && req.staff.staff_id) || 0, req);
    // 操作审计留痕（staff_events）
    logStaffEvent({
      req, staff: req.staff, eventType: "delete", eventName: "物理清理微信用户",
      module: "users", apiPath: "/api/users/purge", bizId: userId,
      extra: { purge_id: result.purge_id, target: result.target, orphan_staff_ids: result.orphan_staff_ids, summary: result.items, media_files: result.media_files, status: result.status },
    });
    res.json(ok(result, "已物理清理"));
  } catch (e) {
    console.error("[admin] users purge error", e);
    res.json(fail((e && e.message) || "服务异常", 400));
  }
});

// 服务监控（只读）
router.use("/api/monitors", crudRouter({
  table: "service_monitor", pk: "monitor_id",
  writable: [],
  search: ["instance_id", "env_id"],
  filters: ["instance_id", "env_id"],
  readonly: true,
}));

// 接口链路（只读；展示用户ID，按 user_id 搜索，关联用户信息兜底）
router.use("/api/traces", crudRouter({
  table: "api_trace", pk: "request_id",
  writable: [],
  search: ["user_id", "api_path"],
  filters: ["api_method", "trace_status"],
  readonly: true,
  enrichUsers: true,
  orderField: "created_at",
}));

// 会话画像（只读 + 用户信息）
router.use("/api/sessions", crudRouter({
  table: "user_sessions", pk: "session_id",
  writable: [],
  search: ["openid", "platform"],
  readonly: true,
  enrichUsers: true,
  appField: "app_id",
  orderField: "created_at",
}));

// 图片上传记录（只读，审核/合规审计用 + 用户信息）
router.use("/api/file_uploads", crudRouter({
  table: "file_uploads", pk: "file_id",
  writable: [],
  search: ["openid", "file_path", "biz"],
  filters: ["biz", "file_status"],
  readonly: true,
  enrichUsers: true,
}));

// 内容安全审核记录（只读：机器检测结果侧表，业务表零改动；按 app 隔离）
router.use("/api/content_audits", adminAuth, crudRouter({
  table: "content_audits", pk: "audit_id",
  writable: [],
  search: ["content", "biz_id"],
  filters: ["status", "media_type", "biz_type"],
  appField: "app_id",
  // 本表无 created_at，时间范围过滤按入队时间
  timeField: "enqueued_at",
  readonly: true,
}));

// 系统错误日志（只读：errorLog.js 统一入库，后台查看与审计）
router.use("/api/system_error_logs", adminAuth, crudRouter({
  table: "system_error_logs", pk: "log_id",
  writable: [],
  search: ["message", "module", "api_path"],
  filters: ["level", "error_code", "app_id"],
  readonly: true,
  orderField: "created_at",
}));

// 文件批量删除：物理删除腾讯云存储对象 + 同步删除 file_uploads 登记记录
// 注意与打卡删除的 markRemoved（仅审计标记、不删存储）不同，本接口是真实清理存储
router.post("/api/file_uploads/batchDelete", adminAuth, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.json(fail("请选择要删除的文件"));
    if (ids.length > 200) return res.json(fail("单次最多删除 200 个文件"));
    const idList = [...new Set(ids.map(String).filter(Boolean))];
    if (idList.length === 0) return res.json(fail("请选择要删除的文件"));

    const { data: rows, error } = await db.from("file_uploads")
      .select("file_id, file_path, file_cos_id, file_name")
      .in("file_id", idList)
      .limit(idList.length);
    if (error) throw error;
    if (!rows || rows.length === 0) return res.json(fail("未找到对应的文件记录"));

    // 0) 使用中校验：正在被业务数据引用的文件严禁直接删除，仅能通过删除任务/打卡/头像等业务数据级联清理
    const refPaths = await collectReferencedFilePaths();
    const blocked = rows.filter(r => {
      const p = String(r.file_path || "").trim().replace(/^\/+/, "");
      return !!p && refPaths.has(p);
    });
    if (blocked.length > 0) {
      const names = blocked.slice(0, 5).map(r => r.file_name || r.file_path).join("、");
      const more = blocked.length > 5 ? ` 等 ${blocked.length} 个` : "";
      return res.json(fail(`文件正在被业务数据使用，严禁直接删除（${names}${more}）。请先删除引用该文件的任务/打卡/头像等业务数据，由系统级联清理。`));
    }

    // 1) 物理删除腾讯云存储对象（成功失败分别统计）
    const paths = rows.map(r => r.file_path).filter(Boolean);
    const { deleted, failed } = await removeFiles(paths);

    // 2) 物理删除成功的文件，同步删除登记记录（失败的保留，便于重试）
    const deletedSet = new Set(deleted);
    const toRemove = rows.filter(r => deletedSet.has(r.file_path));
    if (toRemove.length > 0) {
      const { error: delErr } = await db.from("file_uploads")
        .delete()
        .in("file_id", toRemove.map(r => r.file_id));
      if (delErr) throw delErr;
    }

    logStaffEvent({
      req, staff: req.staff,
      eventType: "delete",
      eventName: `批量删除文件（${toRemove.length} 个，失败 ${failed.length} 个）`,
      module: "file_uploads",
      apiPath: "/api/file_uploads/batchDelete",
      extra: { ids: idList, failed: failed.map(f => f.path) },
    });

    if (failed.length > 0) {
      res.json(ok({ deleted: toRemove.length, failed: failed.length }, `已删除 ${toRemove.length} 个文件，${failed.length} 个删除失败（记录已保留）`));
    } else {
      res.json(ok({ deleted: toRemove.length }, `已删除 ${toRemove.length} 个文件`));
    }
  } catch (e) {
    console.error("[admin] file_uploads batchDelete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 图片清理：回收业务系统已不再引用的文件 ====================
// 找出 file_uploads 登记中「业务表已不再引用」的文件（用户改头像后旧头像、任务/打卡编辑移除的图片、
// 打卡删除仅审计标记未删存储的 removed 记录、上传后未保存的脏数据等），
// 物理删除腾讯云存储对象 + 同步清理登记记录（两段式：preview=1 仅统计预览，preview=0 实际执行）。
// 与「打卡删除 markRemoved（仅审计标记）」不同，本接口是真实回收历史脏数据。
// 安全边界：不触碰任何仍被 users/staff/tasks/task_checkins/task_collections 引用的路径。
async function fetchAllRows(table, cols, batchSize = 2000) {
  const out = [];
  let offset = 0;
  for (;;) {
    let rows = null;
    const rangeRes = await db.from(table).select(cols).range(offset, offset + batchSize - 1);
    if (!rangeRes.error && Array.isArray(rangeRes.data)) {
      rows = rangeRes.data;
    } else {
      // range 兜底：limit + 内存切片（上限 10000 行，超出部分无法分页时放弃）
      const fetchLimit = Math.min(offset + batchSize, 10000);
      const { data, error } = await db.from(table).select(cols).limit(fetchLimit);
      if (error) throw error;
      rows = (data || []).slice(offset, offset + batchSize);
    }
    if (!rows || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < batchSize) break;
    offset += batchSize;
  }
  return out;
}

/** 并发受控的异步池（限制同时进行的存在性探测，避免瞬时打满 RDB/存储） */
function mapLimit(items, limit, fn) {
  return new Promise((resolveAll, rejectAll) => {
    let cursor = 0;
    let active = 0;
    let resolved = false;
    const results = new Array(items.length);
    const worker = async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        active += 1;
        try {
          results[idx] = await fn(items[idx]);
        } catch (e) {
          results[idx] = undefined;
        } finally {
          active -= 1;
        }
      }
      if (active === 0 && !resolved) {
        resolved = true;
        resolveAll(results);
      }
    };
    const n = Math.min(limit, items.length || 1);
    for (let i = 0; i < n; i++) worker();
  });
}

// 收集业务系统当前仍引用的文件路径集合：
//   users.avatar|avatar_hd|avatar_pending|avatar_hd_pending / staff.staff_avatar /
//   tasks.images / task_checkins.checkin_images|voice_url|video_url|video_cover / task_collections.cover_images
// 供「批量删除」做使用中校验与「图片清理」回收判定共用，确保不误删仍被业务引用的文件
async function collectReferencedFilePaths() {
  const refPaths = new Set();
  const addRef = (v) => {
    if (!v) return;
    const s = String(v).trim().replace(/^\/+/, "");
    if (s) refPaths.add(s);
  };
  const addRefs = (list) => (Array.isArray(list) ? list.forEach(addRef) : addRef(list));

  const [usersRes, staffRes, tasksRes, checkinsRes, collsRes] = await Promise.all([
    fetchAllRows("users", "avatar, avatar_hd, avatar_pending, avatar_hd_pending"),
    fetchAllRows("staff", "staff_avatar"),
    fetchAllRows("tasks", "images"),
    fetchAllRows("task_checkins", "checkin_images, voice_url, video_url, video_cover"),
    fetchAllRows("task_collections", "cover_images"),
  ]);
  for (const u of usersRes) addRefs([u.avatar, u.avatar_hd, u.avatar_pending, u.avatar_hd_pending]);
  for (const s of staffRes) addRef(s.staff_avatar);
  for (const t of tasksRes) addRefs(parseImgList(t.images));
  for (const c of checkinsRes) {
    addRefs(parseImgList(c.checkin_images));
    addRef(c.voice_url);
    addRef(c.video_url);
    addRef(c.video_cover);
  }
  for (const c of collsRes) addRefs(parseImgList(c.cover_images));
  return refPaths;
}

router.post("/api/file_uploads/cleanup", adminAuth, async (req, res) => {
  const CLEANUP_LIMIT = 500; // 单次执行最多回收条数（避免超时；超出请分批）
  try {
    const preview = !!(req.body && req.body.preview);

    // 1) 收集业务系统仍在引用的文件路径集合
    const refPaths = await collectReferencedFilePaths();

    // 2) 拉取 file_uploads 全部登记（active/removed 都纳入回收范围：removed=打卡删除时仅审计标记未删存储）
    const uploads = await fetchAllRows("file_uploads", "file_id, file_path, biz, file_name, content_type, file_size, file_status, created_at");

    // 候选：登记路径不在业务引用集合中（含空路径登记）
    const candidates = (uploads || []).filter(r => {
      const p = String(r.file_path || "").trim().replace(/^\/+/, "");
      return !p || !refPaths.has(p);
    });
    const emptyRecords = candidates.filter(r => !String(r.file_path || "").trim());
    const pathCandidates = candidates.filter(r => String(r.file_path || "").trim());

    if (preview) {
      const samples = pathCandidates.slice(0, 20).map(r => ({
        file_id: r.file_id, file_path: r.file_path, biz: r.biz,
        file_name: r.file_name, file_size: r.file_size, file_status: r.file_status,
      }));
      const truncated = pathCandidates.length > CLEANUP_LIMIT;
      return res.json(ok({
        preview: true,
        total: candidates.length,
        empty: emptyRecords.length,
        pathCount: pathCandidates.length,
        cap: CLEANUP_LIMIT,
        truncated,
        samples,
      }, `发现 ${candidates.length} 个不再被业务引用的文件${emptyRecords.length ? `（含 ${emptyRecords.length} 条无路径登记）` : ""}`));
    }

    // 3) 执行：单次最多 CLEANUP_LIMIT 条（含空路径登记）
    const targets = pathCandidates.slice(0, CLEANUP_LIMIT);
    const emptyTargets = emptyRecords.slice(0, CLEANUP_LIMIT);

    // 3.1) 探测存储存在性：存在→物理删除；缺失→仅清登记；未知→尝试物理删除（文件已不被引用，尽力而为）
    const existsFlags = await mapLimit(targets, 8, async (r) => {
      try {
        return await storageFileExists(r.file_path);
      } catch (_) {
        return null;
      }
    });
    const toRemove = [];
    const missing = [];
    targets.forEach((r, i) => {
      if (existsFlags[i] === false) missing.push(r);
      else toRemove.push(r);
    });

    // 3.2) 物理删除云存储对象（成功失败分别统计，失败保留登记便于重试）
    const { deleted, failed } = await removeFiles(toRemove.map(r => r.file_path));

    // 3.3) 清理登记记录：物理删除成功的 + 存储已缺失的 + 空路径登记；删除失败的保留登记便于重试
    const recordIds = new Set();
    const failedPaths = new Set(failed.map(f => f.path));
    for (const r of toRemove) {
      if (failedPaths.has(r.file_path)) continue;
      recordIds.add(r.file_id);
    }
    for (const r of missing) recordIds.add(r.file_id);
    for (const r of emptyTargets) recordIds.add(r.file_id);

    if (recordIds.size > 0) {
      // 分片删除登记记录（避免单条 IN 过长）
      const idList = [...recordIds];
      for (let i = 0; i < idList.length; i += 200) {
        const { error: delErr } = await db.from("file_uploads")
          .delete()
          .in("file_id", idList.slice(i, i + 200));
        if (delErr) throw delErr;
      }
    }

    logStaffEvent({
      req, staff: req.staff,
      eventType: "delete",
      eventName: `清理未引用图片（回收 ${recordIds.size} 条登记，物理删除 ${deleted.length} 个文件）`,
      module: "file_uploads",
      apiPath: "/api/file_uploads/cleanup",
      extra: {
        total: candidates.length, recordCleaned: recordIds.size,
        deleted: deleted.length, missing: missing.length, failed: failed.length, empty: emptyTargets.length,
      },
    });

    const parts = [`已回收 ${recordIds.size} 条登记记录`];
    if (deleted.length) parts.push(`物理删除 ${deleted.length} 个文件`);
    if (missing.length) parts.push(`${missing.length} 个存储已缺失（仅清登记）`);
    if (emptyTargets.length) parts.push(`${emptyTargets.length} 条无路径登记`);
    if (failed.length) parts.push(`${failed.length} 个删除失败（登记已保留，可重试）`);
    res.json(ok({
      total: candidates.length, recordCleaned: recordIds.size,
      deleted: deleted.length, missing: missing.length, failed: failed.length, empty: emptyTargets.length,
    }, `${parts.join("，")}`));
  } catch (e) {
    console.error("[admin] file_uploads cleanup error", e);
    res.json(fail("服务异常", 500));
  }
});

// 用户操作事件（只读，埋点审计用 + 用户信息）
router.use("/api/user_events", crudRouter({
  table: "user_events", pk: "event_id",
  writable: [],
  search: ["openid", "event_name", "page_path"],
  filters: ["event_type", "app_id"],
  readonly: true,
  enrichUsers: true,
  appField: "app_id",
}));

// 后台操作审计（只读，staff 登录/登出/点击菜单/增删改查留痕 + 员工信息）
// 列表按 event_id（毫秒时间戳主键）倒序 → 即事件时间倒序
router.use("/api/staff_events", adminAuth, crudRouter({
  table: "staff_events", pk: "event_id",
  writable: [],
  search: ["staff_username", "event_name", "module", "client_ip"],
  filters: ["event_type", "module", "staff_id"],
  readonly: true,
  enrich: attachStaffName,
  appField: "app_id",
}));

// 前端操作事件上报（点击菜单/页面访问等），写入 staff_events 审计表
// 供 Dashboard 侧边菜单点击、路由切换等埋点使用
router.post("/api/audit/report", adminAuth, async (req, res) => {
  try {
    const { eventType, eventName, module, pagePath, bizId, extra } = req.body || {};
    if (!eventType || !eventName) return res.json(fail("缺少事件参数"));
    logStaffEvent({
      req,
      staff: req.staff,
      eventType,
      eventName,
      module: module || "",
      apiPath: pagePath || req.originalUrl || "",
      bizId,
      extra,
    });
    res.json(ok(null, "已记录"));
  } catch (e) {
    console.error("[admin] audit report error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 员工删除/停用后的课小满关联数据清理 ====================
// 后台删除或停用 t_staff（学生/家长/家属）时同步作废其相关邀请码，
// 避免孤儿码仍显示「待绑定」、已绑定码指向已不存在的账号：
//   1) 其名下仍为 available 的邀请码（学生码/家属共享码）→ 作废（绑定校验依赖 owner 在职）
//   2) 已绑定到该员工（bound_staff_id）的邀请码 → 作废（该小程序用户访问已由 lpAuth 实时锁定）
async function cleanupStaffLpData(staffId) {
  const id = Number(staffId);
  if (!id) return;
  await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
    .eq("owner_staff_id", id).eq("status", "available");
  await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
    .eq("bound_staff_id", id).eq("status", "bound");
}

/**
 * 删除员工账号后的全量级联清理：解除并删除其名下所有关联记录，并进一步清理
 * 因此成为孤儿的小程序用户（微信用户）。
 * 覆盖：创建的任务（含打卡/媒体/派发/积分回扣）、在他人任务下的打卡、创建的合集、
 * 派发关联、小程序绑定、邀请码、孩子档案、家属关系、订阅授权/发送、系统通知、
 * 积分账本/余额、徽章解锁、小程序授权，以及绑定的小程序用户（users 及其画像/事件/媒体）。
 * 每步独立 try/catch，单项失败不阻断其余清理；审计日志（staff_events/task_timeline）保留。
 * @param {object} ctx 级联上下文（visited.staff / visited.openid），防共享微信菱形引用导致重复/递归删除
 */
async function cascadeDeleteStaffData(staffId, actorStaffId, ctx) {
  const id = Number(staffId);
  if (!id) return;
  // 超级管理员强保护：受保护账号（999999 超管）禁止任何级联删除，直接跳过
  if (isProtectedStaff(id)) return;
  const actor = Number(actorStaffId) || 0;
  const visited = ctx || { staff: new Set(), openid: new Set() };
  if (visited.staff.has(id)) return;
  visited.staff.add(id);

  // 1) 该员工创建的任务：回扣积分 + 删打卡/媒体 + 删派发 + 删任务（与任务删除级联同构）
  try {
    const { data: tasks } = await db.from("tasks").select().eq("created_by", id).limit(10000);
    const taskList = tasks || [];
    for (const task of taskList) {
      const tid = task.task_id;
      try { await deductTaskDeleted(task, actor); } catch (_) {}
      try {
        const { data: ckRows } = await db.from("task_checkins")
          .select("checkin_images, voice_url, video_url, video_cover").eq("task_id", tid).limit(10000);
        const paths = [...parseImgList(task.images)];
        (ckRows || []).forEach(c => {
          paths.push(...parseImgList(c.checkin_images));
          if (c.voice_url) paths.push(c.voice_url);
          if (c.video_url) paths.push(c.video_url);
          if (c.video_cover) paths.push(c.video_cover);
        });
        if (paths.length > 0) {
          const { deleted } = await removeFiles(paths);
          if (deleted.length > 0) {
            try { await db.from("file_uploads").delete().in("file_path", deleted); } catch (_) {}
          }
        }
        await db.from("task_checkins").delete().eq("task_id", tid);
      } catch (e) {
        console.error(`[admin] cascade staff task #${tid} error`, e);
      }
      try { await db.from("task_assignees").delete().eq("task_id", tid); } catch (_) {}
    }
    const taskIds = taskList.map(t => t.task_id);
    if (taskIds.length > 0) await db.from("tasks").delete().in("task_id", taskIds);
  } catch (e) {
    console.error("[admin] cascade staff tasks error", e);
  }

  // 2) 该员工在他人任务下提交的打卡：回扣积分 + 删媒体 + 扣减任务计数 + 删打卡
  try {
    const { data: ckRows } = await db.from("task_checkins").select().eq("created_by", id).limit(10000);
    const ckList = ckRows || [];
    for (const c of ckList) {
      try { await deductCheckinDeleted(c, actor); } catch (_) {}
      const mediaPaths = [c.voice_url, c.video_url, c.video_cover].filter(Boolean);
      if (mediaPaths.length > 0) {
        try {
          const { deleted } = await removeFiles(mediaPaths);
          if (deleted.length > 0) {
            try { await db.from("file_uploads").delete().in("file_path", deleted); } catch (_) {}
          }
        } catch (_) {}
      }
      try {
        await withLock(`task:count:${c.task_id}`, async () => {
          const { data: tRows } = await db.from("tasks").select("checkin_count").eq("task_id", c.task_id).limit(1);
          if (tRows && tRows[0]) {
            const cnt = Math.max(0, (tRows[0].checkin_count || 0) - 1);
            await db.from("tasks").update({ checkin_count: cnt, updated_at: nowSql() }).eq("task_id", c.task_id);
          }
        });
      } catch (_) {}
    }
    const ckIds = ckList.map(c => c.checkin_id);
    if (ckIds.length > 0) await db.from("task_checkins").delete().in("checkin_id", ckIds);
  } catch (e) {
    console.error("[admin] cascade staff checkins error", e);
  }

  // 3) 该员工创建的合集：解除任务归属 + 删合集
  try {
    const { data: colRows } = await db.from("task_collections").select("collection_id").eq("created_by", id).limit(10000);
    const colIds = (colRows || []).map(c => c.collection_id);
    if (colIds.length > 0) {
      await db.from("tasks").update({ collection_id: 0, updated_at: nowSql() }).in("collection_id", colIds);
      await db.from("task_collections").delete().in("collection_id", colIds);
      invalidateCollectionRows(colIds);
    }
  } catch (e) {
    console.error("[admin] cascade staff collections error", e);
  }

  // 4) 派发关联（他人任务派发给该员工）
  try { await db.from("task_assignees").delete().eq("staff_id", id); } catch (_) {}

  // 5) 收集绑定的小程序用户 openid（删除绑定前），供随后清理成为孤儿的微信用户
  let boundOpenids = [];
  try {
    const { data: bindRows } = await db.from("lp_students").select("openid").eq("staff_id", id).limit(10000);
    boundOpenids = [...new Set((bindRows || []).map(r => r.openid).filter(Boolean))];
  } catch (_) {}
  try { await db.from("lp_students").delete().eq("staff_id", id); } catch (_) {}

  // 6) 邀请码 / 孩子档案 / 家属关系 / 订阅 / 通知 / 积分 / 徽章 / 小程序授权
  try { await db.from("lp_invites").delete().or(`owner_staff_id.eq.${id},bound_staff_id.eq.${id}`); } catch (_) {}
  try { await db.from("lp_children").delete().or(`parent_staff_id.eq.${id},student_staff_id.eq.${id}`); } catch (_) {}
  try { await db.from("lp_family_members").delete().or(`owner_staff_id.eq.${id},member_staff_id.eq.${id}`); } catch (_) {}
  try { await db.from("subscribe_grants").delete().eq("staff_id", id); } catch (_) {}
  try { await db.from("subscribe_sends").delete().eq("staff_id", id); } catch (_) {}
  try { await db.from("notifications").delete().eq("staff_id", id); } catch (_) {}
  try { await db.from("point_logs").delete().eq("staff_id", id); } catch (_) {}
  try { await db.from("point_balances").delete().eq("staff_id", id); } catch (_) {}
  try { await db.from("badge_unlocks").delete().eq("staff_id", id); } catch (_) {}
  try { await db.from("staff_apps").delete().eq("staff_id", id); } catch (_) {}

  // 7) 清理成为孤儿的小程序用户（删除绑定后已无其它绑定的微信用户）
  for (const openid of boundOpenids) {
    try {
      if (await isOpenidOrphan(openid)) await cascadeDeleteUserData(openid, actor, visited);
    } catch (e) {
      console.error(`[admin] cascade staff -> user ${openid} error`, e);
    }
  }

  // 8) 参考数据缓存失效（员工行 / 合集 / 小程序授权）
  invalidateStaffRows([id]);
  try { invalidatePrefix("staffapps:"); } catch (_) {}
}

/** 判断某 openid 是否已无任何绑定（删除绑定后仍无其它绑定则视为孤儿微信用户） */
async function isOpenidOrphan(openid) {
  try {
    const { data } = await db.from("lp_students").select("id").eq("openid", openid).limit(1);
    return !(data && data.length > 0);
  } catch (_) {
    return false;
  }
}

/** 判断某账号是否应随小程序用户删除而级联删除：绑定已清空且非管理员 */
async function staffOrphanForDelete(staffId) {
  const sid = Number(staffId);
  if (!sid) return false;
  // 超级管理员强保护：受保护账号（999999 超管）永不随级联删除
  if (isProtectedStaff(sid)) return false;
  try {
    const { data: sRows } = await db.from("staff").select("staff_role").eq("staff_id", sid).limit(1);
    if (!(sRows && sRows[0])) return false;
    if (sRows[0].staff_role === "admin") return false;
    const { data: binds } = await db.from("lp_students").select("id").eq("staff_id", sid).limit(1);
    return !(binds && binds.length > 0);
  } catch (_) {
    return false;
  }
}

/**
 * 删除小程序用户（微信用户）后的全量级联清理：删除其画像/会话/事件/链路/内容安全/媒体文件、
 * 订阅、绑定关系，并进一步清理因此成为孤儿的学生/家长/家属账号。
 * 与员工账号删除互为对等（同等最高权限，双向级联）。
 */
async function cascadeDeleteUserData(openid, actorStaffId, ctx) {
  const oid = String(openid || "").trim();
  if (!oid) return;
  const actor = Number(actorStaffId) || 0;
  const visited = ctx || { staff: new Set(), openid: new Set() };
  if (visited.openid.has(oid)) return;
  visited.openid.add(oid);

  // 1) 收集绑定的账号 staff_id（删除绑定前），供随后清理成为孤儿的账号
  let boundStaffIds = [];
  try {
    const { data: bindRows } = await db.from("lp_students").select("staff_id").eq("openid", oid).limit(10000);
    boundStaffIds = [...new Set((bindRows || []).map(r => Number(r.staff_id)).filter(v => v))];
  } catch (_) {}

  // 2) 删除该用户上传的媒体文件（物理删 COS + 登记记录）
  try {
    const { data: files } = await db.from("file_uploads").select("file_path").eq("openid", oid).limit(10000);
    const paths = [...new Set((files || []).map(f => f.file_path).filter(Boolean))];
    if (paths.length > 0) {
      try {
        const { deleted } = await removeFiles(paths);
        if (deleted.length > 0) {
          try { await db.from("file_uploads").delete().in("file_path", deleted); } catch (_) {}
        }
      } catch (_) {}
    }
    await db.from("file_uploads").delete().eq("openid", oid);
  } catch (e) {
    console.error("[admin] cascade user files error", e);
    try { await db.from("file_uploads").delete().eq("openid", oid); } catch (_) {}
  }

  // 3) 删除用户画像/会话/事件/链路/内容安全/订阅记录
  try { await db.from("user_sessions").delete().eq("openid", oid); } catch (_) {}
  try { await db.from("user_events").delete().eq("openid", oid); } catch (_) {}
  try { await db.from("api_trace").delete().eq("openid", oid); } catch (_) {}
  try { await db.from("content_audits").delete().eq("openid", oid); } catch (_) {}
  try { await db.from("subscribe_grants").delete().eq("openid", oid); } catch (_) {}
  try { await db.from("subscribe_sends").delete().eq("openid", oid); } catch (_) {}

  // 4) 作废以该用户绑定过的邀请码（保留邀请码本身，避免影响其它归属账号）
  try {
    await db.from("lp_invites").update({ bound_openid: "", bound_staff_id: 0, status: "revoked", updated_at: nowSql() })
      .eq("bound_openid", oid);
  } catch (_) {}

  // 5) 删除该用户的家属 openid 关联（member_openid）与绑定关系
  try { await db.from("lp_family_members").delete().eq("member_openid", oid); } catch (_) {}
  try { await db.from("lp_students").delete().eq("openid", oid); } catch (_) {}

  // 6) 删除用户主记录
  try { await db.from("users").delete().eq("openid", oid); } catch (_) {}

  // 7) 清理成为孤儿的账号（删除绑定后已无其它绑定的学生/家长/家属）
  for (const sid of boundStaffIds) {
    // 超级管理员强保护：受保护账号（999999 超管）不参与级联删除
    if (isProtectedStaff(sid)) continue;
    try {
      if (await staffOrphanForDelete(sid)) await cascadeDeleteStaffData(sid, actor, visited);
    } catch (e) {
      console.error(`[admin] cascade user -> staff ${sid} error`, e);
    }
  }
}

/**
 * 员工删除前风控核验：统计该账号名下关联的业务数据
 * - 任务类（核心）：作为创建人的任务 / 作为派发人的任务 / 创建的打卡 / 创建的合集
 * - 关系类（提示）：绑定的小程序用户 / 孩子档案 / 家属关系 / 订阅授权
 * 用于：删除确认弹窗提示（deleteStats 接口，展示级联清理范围）
 * 附返回前 5 个关联任务（task_id + title），供删除确认弹窗直接展示
 */
async function countStaffBiz(staffId) {
  const id = String(staffId);
  const num = (r) => (r && !r.error && typeof r.count === "number" ? r.count : 0);
  // 去掉 tc 与 createdRows 的冗余：task_created 直接由 createdRows 去重后长度得到
  const [ck, col, stu, chd, fam, sub, createdRows, assigneeRows] = await Promise.all([
    db.from("task_checkins").select("checkin_id", { count: "exact" }).eq("created_by", id).limit(1),
    db.from("task_collections").select("collection_id", { count: "exact" }).eq("created_by", id).limit(1),
    db.from("lp_students").select("id", { count: "exact" }).eq("staff_id", id).limit(1),
    db.from("lp_children").select("child_id", { count: "exact" }).or(`parent_staff_id.eq.${id},student_staff_id.eq.${id}`).limit(1),
    db.from("lp_family_members").select("id", { count: "exact" }).or(`owner_staff_id.eq.${id},member_staff_id.eq.${id}`).limit(1),
    db.from("subscribe_grants").select("grant_id", { count: "exact" }).eq("staff_id", id).limit(1),
    db.from("tasks").select("task_id").eq("created_by", id).limit(5000),
    db.from("task_assignees").select("task_id").eq("staff_id", id).limit(5000),
  ]);
  const createdIds = (createdRows && !createdRows.error && Array.isArray(createdRows.data))
    ? createdRows.data.map(r => Number(r.task_id)).filter(v => v)
    : [];
  const assigneeIds = (assigneeRows && !assigneeRows.error && Array.isArray(assigneeRows.data))
    ? assigneeRows.data.map(r => Number(r.task_id)).filter(v => v)
    : [];
  // 派发任务先去孤儿：task_assignees 可能残留已删除任务的记录，直接计数会出现
  // 「账号名下没有任务却提示存在任务」的假象。因此仅统计/展示仍真实存在的任务。
  let assignedIds = [];
  if (assigneeIds.length > 0) {
    const { data: existRows } = await db.from("tasks")
      .select("task_id").in("task_id", assigneeIds).limit(assigneeIds.length);
    if (Array.isArray(existRows)) assignedIds = existRows.map(r => Number(r.task_id)).filter(v => v);
  }
  // 任务并集（创建 ∪ 派发），task_count 取真实去重后的数量，避免自建任务被重复统计
  const unionIds = [...new Set([...createdIds, ...assignedIds])];
  // 关联任务列表（最近 5 条：task_id + title，供删除确认弹窗展示）
  let taskList = [];
  if (unionIds.length > 0) {
    const top = [...unionIds].sort((a, b) => b - a).slice(0, 5);
    const { data: titleRows } = await db.from("tasks")
      .select("task_id, title").in("task_id", top).limit(top.length);
    if (Array.isArray(titleRows)) {
      taskList = titleRows
        .map(t => ({ task_id: t.task_id, title: t.title || "" }))
        .sort((a, b) => Number(b.task_id) - Number(a.task_id));
    }
  }
  return {
    task_created: createdIds.length,
    task_assigned: assignedIds.length,
    task_count: unionIds.length,
    checkin_count: num(ck),
    collection_count: num(col),
    bind_count: num(stu),
    child_count: num(chd),
    family_count: num(fam),
    sub_grant_count: num(sub),
    task_list: taskList,
  };
}

// 员工删除前风控核验统计（供前端删除确认弹窗提示）
router.get("/api/staff/deleteStats", adminAuth, async (req, res) => {
  try {
    const { staffId } = req.query;
    if (!staffId) return res.json(fail("缺少员工 ID"));
    res.json(ok(await countStaffBiz(staffId)));
  } catch (e) {
    console.error("[admin] staff deleteStats error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 物理清除（一键删除账号及全部关联数据，物理删除 + 完整审计） ====================
// purgePreview：删除前返回「完整删除审计清单」（目标/家庭范围/逐表计数/样本行/媒体文件数），供审阅。
// purge：执行物理清除（含整棵家庭树 + 云存储媒体文件），并把清单落库到 t_lp_staff_purges 供回看。
// 与普通删除的区别：普通删除按单人级联（cascadeDeleteStaffData）；物理清除以账号为中心沿家庭图
// 扩散到「主家长 + 名下孩子 + 家属」整棵家庭树，物理删除云存储媒体并留存完整审计。
router.get("/api/staff/purgePreview", adminAuth, async (req, res) => {
  try {
    // 破坏性操作：仅平台管理员（admin 角色）可用（菜单权限中间件已按 /module/staff 二次拦截）
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可操作", 403));
    const { staffId } = req.query;
    if (!staffId) return res.json(fail("缺少员工 ID"));
    const manifest = await collectPurgeManifest(staffId);
    const { _biz, ...out } = manifest;
    res.json(ok(out));
  } catch (e) {
    console.error("[admin] staff purgePreview error", e);
    res.json(fail((e && e.message) || "服务异常", 400));
  }
});

router.post("/api/staff/purge", adminAuth, async (req, res) => {
  try {
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可操作", 403));
    const { staffId } = req.body || {};
    if (!staffId) return res.json(fail("缺少员工 ID"));
    const staffIdNum = Number(staffId);
    // 自我保护：不能物理清除自己
    if (String(staffIdNum) === String((req.staff && req.staff.staff_id) || "")) {
      return res.json(fail("不能物理清除自己的账号", 403));
    }
    const result = await executePurge(staffIdNum, (req.staff && req.staff.staff_id) || 0, req);
    // 操作审计留痕（staff_events）
    logStaffEvent({
      req, staff: req.staff, eventType: "delete", eventName: "物理清除账号",
      module: "staff", apiPath: "/api/staff/purge", bizId: staffId,
      extra: { purge_id: result.purge_id, target: result.target, summary: result.items, media_files: result.media_files, status: result.status },
    });
    res.json(ok(result, "已物理清除"));
  } catch (e) {
    console.error("[admin] staff purge error", e);
    res.json(fail((e && e.message) || "服务异常", 400));
  }
});

// 管理员管理
// - passwordFields：staff_password 只在非空时写入并做 bcrypt 哈希（新增/重置密码）
// - exclude：列表/详情响应剔除密码哈希，避免泄露
router.use("/api/staff", adminAuth, crudRouter({
  table: "staff", pk: "staff_id",
  writable: ["staff_username", "staff_nickname", "staff_role", "staff_status", "staff_password"],
  search: ["staff_username", "staff_nickname"],
  passwordFields: ["staff_password"],
  exclude: ["staff_password"],
  filters: ["staff_role", "staff_status"],
  // 自我保护：禁止删除/禁用/修改自己的账号，避免误操作锁死后台
  protectSelf: true,
  pkGenerator: () => nextSeq("staff_id"),
  // 删除改为全量级联清理（见 cascadeDeleteStaffData）：不再拦截，名下所有关联记录一并删除
  onBeforeDelete: async (req, record) => {
    // 超级管理员强保护：禁止删除 999999 超管账号（级联删除同样受 cascadeDeleteStaffData 跳过保护）
    if (record && isProtectedStaff(record.staff_id)) {
      return "超级管理员账号受强保护，禁止删除";
    }
    return null;
  },
  onAfterUpdate: async (req, values, id) => {
    invalidateStaffRows([id]);
    // 停用员工（staff_status→0）时同步作废其邀请码，避免「待绑定」孤儿码
    if (values && Number(values.staff_status) === 0) await cleanupStaffLpData(id);
  },
  onAfterDelete: async (req, record, id) => {
    await cascadeDeleteStaffData(id, (req.staff && req.staff.staff_id) || 0);
  },
}));

// ==================== 管理员-小程序授权（staff_apps） ====================
// 为员工分配可管理的小程序；admin 角色默认拥有全部（无需授权，分配会被忽略）
router.get("/api/staff/apps", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id } = req.query;
    if (!id) return res.json(fail("缺少 staff_id"));
    const all = await listAllApps();
    const { data: rows, error } = await db.from("staff_apps")
      .select("app_id").eq("staff_id", id).limit(100);
    if (error) throw error;
    const allowed = new Set((rows || []).map(r => r.app_id));
    res.json(ok({
      list: all,
      allowed: all.filter(a => allowed.has(a.app_id)).map(a => a.app_id),
    }));
  } catch (e) {
    console.error("[admin] staff apps get error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/api/staff/apps", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id, appIds } = req.body || {};
    if (!id) return res.json(fail("缺少 staff_id"));
    const { data: sRows, error: sErr } = await db.from("staff")
      .select("staff_role").eq("staff_id", id).limit(1);
    if (sErr) throw sErr;
    const staff = sRows && sRows[0];
    if (!staff) return res.json(fail("员工不存在"));
    // admin 角色拥有全部小程序，无需授权
    if (staff.staff_role === "admin") return res.json(ok(null, "管理员默认拥有全部小程序"));
    await db.from("staff_apps").delete().eq("staff_id", id);
    const ids = [...new Set((Array.isArray(appIds) ? appIds : []).map(x => String(x)).filter(Boolean))];
    if (ids.length > 0) {
      await db.from("staff_apps").insert(ids.map(appId => ({ staff_id: id, app_id: appId, created_at: nowSql() })));
    }
    invalidatePrefix("staffapps:");
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "分配小程序权限", module: "staff", apiPath: "/api/staff/apps", bizId: id, extra: { appIds: ids } });
    res.json(ok(null, "已保存"));
  } catch (e) {
    console.error("[admin] staff apps set error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 课小满邀请码管理（独立模块，与 staff 解耦） ====================
// 邀请码独立维护在 t_lp_invites：kind=student 学生码 / kind=parent 家长码 / kind=family 家属共享码。
// 支持后台新增/编辑/删除（管理员），新增时自动生成 6 位邀请码并校验归属角色；
// 删除已绑定/已作废的学生码、家长码时同步锁定对应账号的小程序访问（与作废语义一致）。
const INVITE_KIND_OWNER_ROLE = { student: "student", parent: "parent", family: "parent" };
const INVITE_KIND_ERR = {
  student: "学生码归属账号必须是有效学生账号（角色=学生、状态=启用）",
  parent: "家长码归属账号必须是有效主家长账号（角色=主家长、状态=启用；若暂无主家长账号，请先在「管理员管理」创建）",
  family: "家属共享码归属账号必须是有效主家长账号（角色=主家长、状态=启用）",
};
const INVITE_KIND_MSG = "邀请码类型无效（student 学生码 / parent 家长码 / family 家属共享码）";

router.use("/api/lp_invites", adminAuth, crudRouter({
  table: "lp_invites", pk: "invite_id",
  writable: ["kind", "owner_staff_id", "child_id", "status"],
  search: ["invite_code"],
  filters: ["kind", "status"],
  pkGenerator: () => nextSeq("invite_id"),
  defaults: (req) => ({
    app_id: "miniprogram-kxm",
    created_by: Number(req.staff && req.staff.staff_id) || 0,
  }),
  // 非管理员仅可查看/操作自己名下的邀请码（管理员全部）
  readScopeFn: (req) => (req.staff && req.staff.role) === "admin"
    ? null
    : { field: "owner_staff_id", value: req.staff.staff_id },
  scopeFn: (req) => (req.staff && req.staff.role) === "admin"
    ? null
    : { field: "owner_staff_id", value: req.staff.staff_id },
  onBeforeCreate: async (req, values) => {
    const kind = String(values.kind || "");
    if (!(kind in INVITE_KIND_OWNER_ROLE)) return INVITE_KIND_MSG;
    const ownerId = Number(values.owner_staff_id);
    if (!ownerId) return "请选择归属账号";
    const needRole = INVITE_KIND_OWNER_ROLE[kind];
    const { data } = await db.from("staff")
      .select("staff_id, staff_role, staff_status").eq("staff_id", ownerId).limit(1);
    const owner = data && data[0];
    if (!owner || owner.staff_role !== needRole || owner.staff_status !== 1) {
      return INVITE_KIND_ERR[kind];
    }
    values.kind = kind;
    values.owner_staff_id = ownerId;
    values.child_id = Number(values.child_id) || 0;
    values.status = "available";
    values.bound_openid = "";
    values.bound_staff_id = 0;
    values.bound_at = null;
    values.invite_code = await genUniqueInviteCode();
    return null;
  },
  onBeforeUpdate: async (req, oldRecord, values) => {
    const kind = values.kind !== undefined ? String(values.kind) : (oldRecord && oldRecord.kind);
    if (kind && !(kind in INVITE_KIND_OWNER_ROLE)) return INVITE_KIND_MSG;
    // 状态白名单：bound 只能由小程序绑定产生，禁止手动改为 bound（原值已是 bound 时允许保留）；
    // revoked 只能由「作废」接口产生（会同步锁定绑定访问），禁止表单手动作废；已作废为终态不可恢复
    if (values.status !== undefined) {
      const oldStatus = oldRecord && oldRecord.status;
      const newStatus = String(values.status);
      if (!["available", "bound", "revoked"].includes(newStatus)) return "邀请码状态无效";
      if (newStatus === "bound" && oldStatus !== "bound") return "不能手动置为已绑定状态，请走小程序绑定";
      if (newStatus === "revoked" && oldStatus !== "revoked") return "请使用「作废」操作作废邀请码（将同步处理绑定访问）";
      if (newStatus === "available" && oldStatus === "revoked") return "已作废的邀请码不可恢复，如需新码请使用「重新生成」";
    }
    // 改了类型或归属账号时，校验归属角色匹配
    if (values.kind !== undefined || values.owner_staff_id !== undefined) {
      const ownerId = values.owner_staff_id !== undefined ? Number(values.owner_staff_id) : Number(oldRecord && oldRecord.owner_staff_id);
      if (!ownerId) return "请选择归属账号";
      const needRole = INVITE_KIND_OWNER_ROLE[kind];
      const { data } = await db.from("staff")
        .select("staff_id, staff_role, staff_status").eq("staff_id", ownerId).limit(1);
      const owner = data && data[0];
      if (!owner || owner.staff_role !== needRole || owner.staff_status !== 1) {
        return INVITE_KIND_ERR[kind];
      }
      values.owner_staff_id = ownerId;
    }
    if (values.child_id !== undefined) values.child_id = Number(values.child_id) || 0;
    return null;
  },
  onBeforeDelete: async (req, record) => {
    // 删除已绑定的学生码/家长码：同步锁定对应账号的小程序访问，避免「绑定在、邀请码无」的悬空态
    if (record && ["student", "parent"].includes(record.kind) && Number(record.bound_staff_id) > 0) {
      try {
        await db.from("lp_students").update({ bound_status: 0, updated_at: nowSql() })
          .eq("staff_id", Number(record.bound_staff_id));
      } catch (_) {}
    }
    return null;
  },
  enrich: async (rows) => {
    const list = rows || [];
    if (list.length === 0) return list;
    const staffIds = [...new Set(list.flatMap(r => [Number(r.owner_staff_id), Number(r.bound_staff_id)]).filter(v => v > 0))];
    const staffMap = {};
    if (staffIds.length > 0) {
      const { data } = await db.from("staff")
        .select("staff_id, staff_nickname, staff_username").in("staff_id", staffIds).limit(staffIds.length);
      (data || []).forEach(s => { staffMap[String(s.staff_id)] = s; });
    }
    const childIds = [...new Set(list.map(r => Number(r.child_id)).filter(v => v > 0))];
    const childMap = {};
    if (childIds.length > 0) {
      const { data } = await db.from("lp_children")
        .select("child_id, child_name").in("child_id", childIds).limit(childIds.length);
      (data || []).forEach(c => { childMap[String(c.child_id)] = c; });
    }
    const openids = [...new Set(list.map(r => r.bound_openid).filter(Boolean))];
    const userMap = {};
    if (openids.length > 0) {
      const { data } = await db.from("users")
        .select("openid, nickname").in("openid", openids).limit(openids.length);
      (data || []).forEach(u => { userMap[u.openid] = u; });
    }
    return list.map(r => ({
      ...r,
      _ownerNickname: (staffMap[String(r.owner_staff_id)] || {}).staff_nickname || "",
      _boundNickname: (staffMap[String(r.bound_staff_id)] || {}).staff_nickname || "",
      _childName: (childMap[String(r.child_id)] || {}).child_name || "",
      _boundUserNickname: (userMap[r.bound_openid] || {}).nickname || "",
    }));
  },
}));

// 作废邀请码（仅管理员）：kind=student/parent 且已绑定时同步锁定对应账号名下小程序访问
router.post("/api/lp_invites/revoke", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 invite_id"));
    const inv = await inviteById(id);
    if (!inv) return res.json(fail("邀请码不存在"));
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() }).eq("invite_id", inv.invite_id);
    if (["student", "parent"].includes(inv.kind) && Number(inv.bound_staff_id) > 0) {
      try {
        await db.from("lp_students").update({ bound_status: 0, updated_at: nowSql() }).eq("staff_id", Number(inv.bound_staff_id));
      } catch (_) {}
    }
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "作废邀请码（锁定小程序访问）", module: "lp_invites", apiPath: "/api/lp_invites/revoke", bizId: inv.invite_id, extra: { invite_code: inv.invite_code, kind: inv.kind } });
    res.json(ok(null, "邀请码已作废" + (["student", "parent"].includes(inv.kind) && Number(inv.bound_staff_id) > 0 ? "，对应账号的小程序访问已锁定" : "")));
  } catch (e) {
    console.error("[admin] lp_invites revoke error", e);
    res.json(fail("服务异常", 500));
  }
});

// 重新生成学生/家长邀请码（仅管理员）：作废该账号当前可用的可用码并发新码，恢复其名下小程序访问
router.post("/api/lp_invites/regenerate", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 invite_id"));
    const inv = await inviteById(id);
    if (!inv || !["student", "parent"].includes(inv.kind)) return res.json(fail("仅学生码、家长码可重新生成"));
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("kind", inv.kind).eq("owner_staff_id", inv.owner_staff_id).eq("status", "available");
    const next = await createInvite({ kind: inv.kind, ownerStaffId: Number(inv.owner_staff_id), childId: Number(inv.child_id) || 0, createdBy: Number(req.staff.staff_id) || 0 });
    try {
      await db.from("lp_students").update({ bound_status: 1, updated_at: nowSql() }).eq("staff_id", Number(inv.owner_staff_id));
    } catch (_) {}
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "重新生成邀请码", module: "lp_invites", apiPath: "/api/lp_invites/regenerate", bizId: inv.owner_staff_id, extra: { old_code: inv.invite_code, new_code: next.invite_code, kind: inv.kind } });
    res.json(ok({ invite_code: next.invite_code }, "新邀请码已生成"));
  } catch (e) {
    console.error("[admin] lp_invites regenerate error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 课小满绑定关系管理（lp_students 统一维护） ====================
// t_lp_students：小程序用户 openid ↔ staff 绑定映射（邀请码准入）。
// 绑定由用户在小程序输码自动完成，后台无需手动新增绑定；
// 权限：管理员可管理全部绑定；非管理员（学生）仅可查看自己的绑定（只读，不能操作）。
// 统一维护：列表/详情（含员工与小程序用户画像）、解除绑定、变更绑定（换绑到其他账号）。
// 可被后台「绑定管理」重绑/开通的账号角色：学生/家长/家属/管理员（t_lp_students 覆盖全部 LP 角色）
const LP_BIND_STAFF_ROLES = ["student", "admin", "parent", "family"];

/** 是否为管理员可管理绑定（非管理员仅本人只读） */
function canManageBinding(req) {
  return (req.staff && req.staff.role) === "admin";
}

/** 绑定范围过滤：非管理员强制限定本人（管理员可看全部） */
function bindingScopeQuery(req, q) {
  if (canManageBinding(req)) return q;
  const selfId = String((req.staff && req.staff.staff_id) || "");
  return selfId ? q.eq("staff_id", Number(selfId)) : q;
}

/** 绑定列表附加关联信息：学生/管理员账号（staff_nickname/staff_username/staff_role）+ 邀请码（t_lp_invites 独立表）+ 小程序用户画像（_userId/_userNickname/_userAvatar） */
async function attachBindingInfo(rows) {
  const list = rows || [];
  if (list.length === 0) return list;
  const staffIds = [...new Set(list.map(r => r.staff_id).filter(v => v !== undefined && v !== null && v !== ""))];
  const staffMap = {};
  if (staffIds.length > 0) {
    const { data: staffs, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_role")
      .in("staff_id", staffIds).limit(staffIds.length);
    if (!error && Array.isArray(staffs)) staffs.forEach(s => { staffMap[String(s.staff_id)] = s; });
  }
  // 该账号最新的学生邀请码（t_lp_invites 独立维护；kind=student 按 invite_id 倒序取最新一条）
  const inviteMap = {};
  if (staffIds.length > 0) {
    const { data: invites, error: invErr } = await db.from("lp_invites")
      .select("invite_code, kind, status, owner_staff_id")
      .in("owner_staff_id", staffIds).eq("kind", "student")
      .order("invite_id", { ascending: false }).limit(Math.min(staffIds.length * 5, 2000));
    if (!invErr && Array.isArray(invites)) invites.forEach(inv => {
      const owner = String(inv.owner_staff_id);
      if (!inviteMap[owner]) inviteMap[owner] = inv;
    });
  }
  const openids = [...new Set(list.map(r => r.openid).filter(Boolean))];
  const userMap = {};
  if (openids.length > 0) {
    const { data: users, error } = await db.from("users")
      .select("openid, user_uid, nickname, avatar, avatar_emoji")
      .in("openid", openids).limit(openids.length);
    if (!error && Array.isArray(users)) users.forEach(u => { userMap[u.openid] = u; });
  }
  return list.map(r => {
    const s = staffMap[String(r.staff_id)] || {};
    const u = userMap[r.openid] || {};
    const inv = inviteMap[String(r.staff_id)] || {};
    const nick = u.nickname || "用户";
    const ch = String(nick).charAt(0);
    return {
      ...r,
      staff_username: s.staff_username || "",
      staff_nickname: s.staff_nickname || "",
      staff_role: s.staff_role || "",
      staff_invite_code: inv.invite_code || "",
      staff_invite_code_status: inv.status || "",
      _userId: u.user_uid || "",
      _userNickname: u.nickname || "",
      _userAvatar: u.avatar || "",
      _userAvatarChar: /[a-z]/.test(ch) ? ch.toUpperCase() : ch,
    };
  });
}

// 绑定关系列表（分页 + 搜索 openid/staff + 过滤状态）
router.get("/api/lp_students/list", adminAuth, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword, order = "desc", boundStatus } = req.query;
    const size = Math.min(Number(pageSize) || 20, 100);
    const pageNo = Math.max(1, Number(page) || 1);
    const offset = (pageNo - 1) * size;

    // 关键词：先查员工表取昵称/账号命中的 staff_id，再与 openid / staff_id 匹配合并为单条 or 过滤
    const matchStaffIds = async (kw) => {
      const safeKw = String(kw).replace(/[(),]/g, "").slice(0, 100);
      if (!safeKw) return [];
      try {
        const { data, error } = await db.from("staff")
          .select("staff_id")
          .or(`staff_nickname.like.%${safeKw}%,staff_username.like.%${safeKw}%`)
          .limit(500);
        if (error) return [];
        return (data || []).map(s => s.staff_id);
      } catch (_) { return []; }
    };

    const staffIds = keyword ? await matchStaffIds(keyword) : [];
    const buildBase = (start) => {
      let q = bindingScopeQuery(req, start || db.from("lp_students").select());
      if (keyword) {
        const safeKw = String(keyword).replace(/[(),]/g, "").slice(0, 100);
        const clauses = [`openid.like.%${safeKw}%`, `staff_id.like.%${safeKw}%`];
        if (staffIds.length > 0) clauses.push(`staff_id.in.(${staffIds.join(",")})`);
        q = q.or(clauses.join(","));
      }
      if (boundStatus !== undefined && boundStatus !== null && boundStatus !== "") {
        q = q.eq("bound_status", String(boundStatus).slice(0, 8));
      }
      return q;
    };

    // 分页数据与总数相互独立，并行执行
    const [rangeRes, countRes] = await Promise.all([
      buildBase().order("id", { ascending: order !== "desc" }).range(offset, offset + size - 1),
      buildBase(db.from("lp_students").select("id", { count: "exact" })).limit(1),
    ]);

    let paged = [];
    if (!rangeRes.error) {
      paged = rangeRes.data || [];
    } else {
      const fetchLimit = Math.min(offset + size, 2000);
      const { data: rows, error } = await buildBase()
        .order("id", { ascending: order !== "desc" })
        .limit(fetchLimit);
      if (error) throw error;
      paged = (rows || []).slice(offset, offset + size);
    }

    let total = paged.length;
    if (!countRes.error && typeof countRes.count === "number" && countRes.count >= 0) {
      total = countRes.count;
    } else {
      try {
        const { data: all, error: allErr } = await buildBase(db.from("lp_students").select("id")).limit(10000);
        if (!allErr && Array.isArray(all)) total = all.length;
      } catch (_) {}
    }

    const list = await attachBindingInfo(paged);
    res.json(ok({ list, total, page: pageNo, pageSize: size }));
  } catch (e) {
    console.error("[admin] lp_students list error", e);
    res.json(fail("服务异常", 500));
  }
});

// 绑定关系详情
router.get("/api/lp_students/detail", adminAuth, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("lp_students").select().eq("id", id).limit(1);
    if (error) throw error;
    if (!(rows && rows[0])) return res.json(fail("绑定记录不存在"));
    if (!canManageBinding(req) && String(rows[0].staff_id) !== String((req.staff && req.staff.staff_id) || "")) {
      return res.json(fail("无权查看该绑定", 403));
    }
    const list = await attachBindingInfo([rows[0]]);
    logStaffEvent({ req, staff: req.staff, eventType: "detail", eventName: "查看绑定关系详情", module: "lp_students", apiPath: "/api/lp_students/detail", bizId: id });
    res.json(ok({ record: list[0] || null }));
  } catch (e) {
    console.error("[admin] lp_students detail error", e);
    res.json(fail("服务异常", 500));
  }
});

// 解除绑定：物理删除绑定映射，该小程序用户立即失去访问（下次登录需重新绑定）
router.post("/api/lp_students/unbind", adminAuth, async (req, res) => {
  try {
    if (!canManageBinding(req)) return res.json(fail("无权操作", 403));
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("lp_students").select().eq("id", id).limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("绑定记录不存在"));
    const { error: delErr } = await db.from("lp_students").delete().eq("id", id);
    if (delErr) throw delErr;
    logStaffEvent({ req, staff: req.staff, eventType: "delete", eventName: "解除绑定", module: "lp_students", apiPath: "/api/lp_students/unbind", bizId: id, extra: { staff_id: rec.staff_id, openid: rec.openid } });
    res.json(ok(null, "已解除绑定，该小程序用户需重新绑定邀请码才能访问"));
  } catch (e) {
    console.error("[admin] lp_students unbind error", e);
    res.json(fail("服务异常", 500));
  }
});

// 变更绑定：将某 openid 的绑定转移到另一账号（校验目标账号存在且为可绑定角色）
router.post("/api/lp_students/rebind", adminAuth, async (req, res) => {
  try {
    if (!canManageBinding(req)) return res.json(fail("无权操作", 403));
    const { id, staffId } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    if (!staffId) return res.json(fail("请选择目标学生账号"));
    const targetId = Number(staffId);
    if (!Number.isFinite(targetId)) return res.json(fail("目标学生账号无效"));

    const { data: rows, error } = await db.from("lp_students").select().eq("id", id).limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("绑定记录不存在"));

    const { data: stRows, error: sErr } = await db.from("staff")
      .select("staff_id, staff_role, staff_status").eq("staff_id", targetId).limit(1);
    if (sErr) throw sErr;
    const target = stRows && stRows[0];
    if (!target || !LP_BIND_STAFF_ROLES.includes(target.staff_role) || target.staff_status !== 1) {
      return res.json(fail("目标账号不存在或不可绑定"));
    }
    if (String(rec.staff_id) === String(targetId)) return res.json(fail("目标账号与原绑定一致"));

    await db.from("lp_students").update({
      staff_id: targetId,
      bound_status: 1,
      updated_at: nowSql(),
    }).eq("id", id);
    logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: "变更绑定", module: "lp_students", apiPath: "/api/lp_students/rebind", bizId: id, extra: { from: rec.staff_id, to: targetId, openid: rec.openid } });
    res.json(ok(null, "已变更绑定"));
  } catch (e) {
    console.error("[admin] lp_students rebind error", e);
    res.json(fail("服务异常", 500));
  }
});

// 编辑绑定（仅管理员）：修改 openid ↔ 账号绑定（换绑到其他账号 / 切换绑定状态）
router.post("/api/lp_students/update", adminAuth, async (req, res) => {
  try {
    if (!canManageBinding(req)) return res.json(fail("无权操作", 403));
    const { id, staffId, boundStatus } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("lp_students").select().eq("id", id).limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("绑定记录不存在"));

    const values = { updated_at: nowSql() };
    if (staffId !== undefined && staffId !== null && String(staffId) !== "") {
      const targetId = Number(staffId);
      const { data: stRows, error: sErr } = await db.from("staff")
        .select("staff_id, staff_role, staff_status").eq("staff_id", targetId).limit(1);
      if (sErr) throw sErr;
      const target = stRows && stRows[0];
      if (!target || !LP_BIND_STAFF_ROLES.includes(target.staff_role) || target.staff_status !== 1) {
        return res.json(fail("目标账号不存在或不可绑定"));
      }
      values.staff_id = targetId;
    }
    if (boundStatus !== undefined && boundStatus !== null && boundStatus !== "") {
      values.bound_status = Number(boundStatus) === 0 ? 0 : 1;
    }
    await db.from("lp_students").update(values).eq("id", id);
    logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: "编辑绑定", module: "lp_students", apiPath: "/api/lp_students/update", bizId: id, extra: { openid: rec.openid, from: rec.staff_id, ...values } });
    res.json(ok(null, "已更新绑定"));
  } catch (e) {
    console.error("[admin] lp_students update error", e);
    res.json(fail("服务异常", 500));
  }
});

// 删除绑定（仅管理员）：物理删除绑定映射，该小程序用户立即失去访问（同「解除绑定」）
router.post("/api/lp_students/delete", adminAuth, async (req, res) => {
  try {
    if (!canManageBinding(req)) return res.json(fail("无权操作", 403));
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("lp_students").select().eq("id", id).limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("绑定记录不存在"));
    const { error: delErr } = await db.from("lp_students").delete().eq("id", id);
    if (delErr) throw delErr;
    logStaffEvent({ req, staff: req.staff, eventType: "delete", eventName: "删除绑定", module: "lp_students", apiPath: "/api/lp_students/delete", bizId: id, extra: { staff_id: rec.staff_id, openid: rec.openid } });
    res.json(ok(null, "已删除绑定，该小程序用户需重新绑定邀请码才能访问"));
  } catch (e) {
    console.error("[admin] lp_students delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 课小满孩子档案管理（后台，通用 CRUD） ====================
// 只读：孩子档案/学生码由家长在小程序维护；后台仅查看与审计
router.use("/api/lp_children", adminAuth, crudRouter({
  table: "lp_children", pk: "child_id",
  writable: ["child_name", "gender", "birth_date", "school_name", "grade", "class_no"],
  search: ["child_name", "school_name"],
  filters: ["parent_staff_id", "grade", "class_no"],
  readonly: true,
  enrich: async (rows) => {
    const list = rows || [];
    if (list.length === 0) return list;
    const ids = [...new Set(list.map(r => Number(r.parent_staff_id)).filter(Boolean))];
    const parentMap = {};
    if (ids.length > 0) {
      const { data } = await db.from("staff")
        .select("staff_id, staff_nickname, staff_username").in("staff_id", ids).limit(ids.length);
      (data || []).forEach(s => { parentMap[String(s.staff_id)] = s; });
    }
    return list.map(r => ({ ...r, _parentNickname: (parentMap[String(r.parent_staff_id)] || {}).staff_nickname || "" }));
  },
}));

// ==================== 家长-孩子绑定/解绑（后台最高级别操作） ====================
// 说明：管理员可直接在后台对孩子档案做家长绑定/换绑/解绑，跳过小程序端「家长本人名下 + 邀请码」的
// 业务归属校验（不做权限校验）；但仍做数据逻辑校验（档案/账号存在且合法），并对可能的影响给出风险提示。
// 风险提示采用「先预览、后执行」两段式：force=0/缺省时仅返回 needConfirm + warnings 不落库；
// force=1 时确认执行。前端据此先弹风险确认再调用，确保高风险操作有明确提示。
const LP_PARENT_ROLE = "parent";

/** 按 child_id 读取孩子档案（含逻辑校验：存在且未删除），返回孩子记录或 null */
async function lpChildForAdmin(req, res, childId) {
  const id = Number(childId);
  if (!Number.isInteger(id) || id <= 0) {
    res.json(fail("孩子档案ID无效"));
    return null;
  }
  const { data, error } = await db.from("lp_children").select().eq("child_id", id).limit(1);
  if (error) throw error;
  const child = data && data[0];
  if (!child || Number(child.child_status) !== 1) {
    res.json(fail("孩子档案不存在或已删除"));
    return null;
  }
  return child;
}

/** 读取主家长账号（含逻辑校验：存在、角色=主家长、启用），返回账号记录或 null */
async function lpParentForAdmin(req, res, parentStaffId) {
  const id = Number(parentStaffId);
  if (!Number.isInteger(id) || id <= 0) {
    res.json(fail("主家长账号无效"));
    return null;
  }
  const { data, error } = await db.from("staff")
    .select("staff_id, staff_username, staff_nickname, staff_role, staff_status")
    .eq("staff_id", id).limit(1);
  if (error) throw error;
  const parent = data && data[0];
  if (!parent || parent.staff_role !== LP_PARENT_ROLE || Number(parent.staff_status) !== 1) {
    res.json(fail("目标账号不是有效的主家长账号（需角色为「主家长」且处于启用状态）"));
    return null;
  }
  return parent;
}

/** 检查学生账号的「前后台绑定」现状（用于决定是否需要生成邀请码）：
 *  - hasMiniBinding：已在 t_lp_students 完成 openid ↔ 学生账号绑定（小程序可正常访问）→ 无需邀请码
 *  - availableInvite：已有可用（available）的学生邀请码 → 直接复用，不生成新码
 *  - 两者皆无 → 才需要生成新邀请码（供学生在小程序绑定访问）
 *  注意：家长-孩子绑定（lp_children）与学生前后台绑定（lp_students）是两回事，互不影响。 */
async function studentBindState(studentId) {
  const sid = Number(studentId) || 0;
  const state = { hasMiniBinding: false, availableInvite: null };
  if (!sid) return state;
  try {
    const { data, error } = await db.from("lp_students")
      .select("id").eq("staff_id", sid).eq("bound_status", 1).limit(1);
    if (!error && data && data.length > 0) state.hasMiniBinding = true;
  } catch (_) {}
  try {
    const { data, error } = await db.from("lp_invites")
      .select("invite_id, invite_code, status")
      .eq("kind", "student").eq("owner_staff_id", sid)
      .order("invite_id", { ascending: false }).limit(50);
    if (!error && Array.isArray(data)) {
      state.availableInvite = data.find(r => r.status === "available") || null;
    }
  } catch (_) {}
  return state;
}

/** 后台从零绑定：选择已有主家长账号 + 学生账号，创建孩子档案。
 *  用于「已建好主家长/学生账号、但无法走小程序前端绑定流程」的场景。
 *  家长-孩子绑定只写 lp_children 归属关系；是否生成学生邀请码按学生现状决定：
 *  已绑定小程序或已有可用学生邀请码 → 不再生成（避免产生冗余码）。
 *  严格处理：学生账号已归属其它未删除孩子档案时**直接拒绝**（不提供强制重复创建），
 *  避免产生重复档案导致小程序端孩子重复显示；需调整归属时走「绑定家长/解绑」操作。
 */
router.post("/api/lp_children/bind_create", adminAuth, async (req, res) => {
  try {
    // 安全审计 S5：跨家庭绑定为后台最高级别操作，仅平台管理员可执行
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可执行该操作", 403));
    const b = req.body || {};
    if (!b.parent_staff_id) return res.json(fail("请选择主家长账号"));
    if (!b.student_staff_id) return res.json(fail("请选择学生账号"));

    const parent = await lpParentForAdmin(req, res, b.parent_staff_id);
    if (!parent) return;
    const studentId = Number(b.student_staff_id);
    if (!Number.isInteger(studentId) || studentId <= 0) return res.json(fail("学生账号无效"));

    const { data: sRows, error: sErr } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_role, staff_status")
      .eq("staff_id", studentId).limit(1);
    if (sErr) throw sErr;
    const student = sRows && sRows[0];
    if (!student || student.staff_role !== "student" || Number(student.staff_status) !== 1) {
      return res.json(fail("目标账号不是有效的学生账号（需角色为「学生」且处于启用状态）"));
    }

    // 严格校验：一个学生账号只应归属一个未删除的孩子档案，重复绑定直接拒绝
    const { data: dupRows, error: dupErr } = await db.from("lp_children")
      .select("child_id, child_name, parent_staff_id").eq("student_staff_id", studentId).eq("child_status", 1).limit(5);
    if (dupErr) throw dupErr;
    const dups = dupRows || [];
    if (dups.length > 0) {
      const dupDesc = dups.map(d => {
        const dName = d.child_name || "未命名";
        return `孩子档案#${d.child_id}「${dName}」（${Number(d.parent_staff_id) > 0 ? `主家长 #${d.parent_staff_id}` : "未绑定家长"}）`;
      }).join("、");
      return res.json(fail(`该学生账号已归属 ${dupDesc}。请勿重复创建孩子档案；如需调整归属，请在该档案上使用「绑定家长 / 解绑」操作。`));
    }

    // 学生现状：是否已绑定小程序 / 已有可用学生邀请码（决定是否需要生成新码）
    const { hasMiniBinding, availableInvite } = await studentBindState(studentId);

    const parentName = parent.staff_nickname || parent.staff_username || `#${parent.staff_id}`;
    const studentName = student.staff_nickname || student.staff_username || `#${student.staff_id}`;

    // 创建孩子档案（仅家长-孩子归属绑定，不涉及小程序绑定）
    const childName = String(b.child_name || "").trim().slice(0, 32) || student.staff_nickname || student.staff_username || "未命名孩子";
    const grade = Number(b.grade);
    const classNo = Number(b.class_no);
    const childId = await nextSeq("child_id");
    await db.from("lp_children").insert({
      child_id: childId,
      app_id: String(req.appId || "").slice(0, 32),
      parent_staff_id: parent.staff_id,
      student_staff_id: studentId,
      child_name: childName,
      gender: Number(b.gender) || 0,
      birth_date: String(b.birth_date || "").slice(0, 10) || null,
      school_name: String(b.school_name || "").slice(0, 64),
      grade: Number.isInteger(grade) && grade >= 1 && grade <= 6 ? grade : 0,
      class_no: Number.isInteger(classNo) && classNo >= 1 && classNo <= 35 ? classNo : 0,
      child_status: 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });

    // 学生邀请码：仅当学生既未绑定小程序、又无可用学生邀请码时才生成（已有则不生成冗余码）
    let invite = null;
    if (!hasMiniBinding && !availableInvite) {
      invite = await createInvite({ kind: "student", ownerStaffId: studentId, childId, createdBy: Number(req.staff.staff_id) || 0 });
    } else if (!hasMiniBinding && availableInvite) {
      invite = { invite_id: availableInvite.invite_id, invite_code: availableInvite.invite_code, reused: true };
    }

    logStaffEvent({ req, staff: req.staff, eventType: "create", eventName: "后台新建家长-孩子绑定", module: "lp_children", apiPath: "/api/lp_children/bind_create", bizId: childId, extra: { child_name: childName, parent_staff_id: parent.staff_id, student_staff_id: studentId, invite_code: invite ? invite.invite_code : "", invite_note: hasMiniBinding ? "已有小程序绑定，未生成" : (availableInvite ? "复用已有可用邀请码" : "已生成") } });
    const baseMsg = `已创建孩子档案「${childName}」并绑定主家长「${parentName}」`;
    if (hasMiniBinding) {
      res.json(ok({ child_id: childId, child_name: childName, invite_code: "", student_nickname: studentName, invite_note: "already_bound" }, `${baseMsg}。该学生已完成小程序绑定，无需邀请码`));
    } else if (availableInvite) {
      res.json(ok({ child_id: childId, child_name: childName, invite_code: availableInvite.invite_code, student_nickname: studentName, invite_note: "reused" }, `${baseMsg}。复用已有学生邀请码：${availableInvite.invite_code}`));
    } else {
      res.json(ok({ child_id: childId, child_name: childName, invite_code: invite.invite_code, student_nickname: studentName, invite_note: "generated" }, `${baseMsg}。学生邀请码：${invite.invite_code}`));
    }
  } catch (e) {
    console.error("[admin] lp_children bind_create error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 绑定孩子到主家长（换绑视为变更归属）：两段式，force=1 才实际落库 */
router.post("/api/lp_children/bind", adminAuth, async (req, res) => {
  try {
    // 安全审计 S5：跨家庭换绑为后台最高级别操作，仅平台管理员可执行
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可执行该操作", 403));
    const { child_id, parent_staff_id, force } = req.body || {};
    if (!child_id) return res.json(fail("缺少孩子档案ID"));
    if (!parent_staff_id) return res.json(fail("请选择要绑定的主家长账号"));

    const child = await lpChildForAdmin(req, res, child_id);
    if (!child) return;
    const parent = await lpParentForAdmin(req, res, parent_staff_id);
    if (!parent) return;

    const currentParentId = Number(child.parent_staff_id) || 0;
    // 幂等：已是同一家长直接返回
    if (currentParentId === parent.staff_id) {
      return res.json(ok(null, "该孩子已归属此主家长，无需变更"));
    }

    const parentName = parent.staff_nickname || parent.staff_username || `#${parent.staff_id}`;
    // 仅当孩子当前已有主家长（换绑会使其失去管理权限）才需要弹窗确认；
    // 首次绑定（无主家长）属于干净操作，直接执行
    const needConfirm = currentParentId > 0;
    const warnings = [];
    if (currentParentId > 0) {
      const { data: oldRows } = await db.from("staff")
        .select("staff_username, staff_nickname").eq("staff_id", currentParentId).limit(1);
      const old = oldRows && oldRows[0];
      const oldName = (old && (old.staff_nickname || old.staff_username)) || `#${currentParentId}`;
      warnings.push(
        `该孩子「${child.child_name}」当前归属于主家长「${oldName}」。换绑后家长「${oldName}」将失去该孩子的档案与学习数据管理权限，其名下家属共享的查看权限同步移除。`,
        `新主家长「${parentName}」绑定后，将在小程序「我的」中看到该孩子并可管理其档案、任务与打卡。`
      );
    } else {
      warnings.push(
        `该孩子「${child.child_name}」当前未绑定主家长。绑定后「${parentName}」将在小程序「我的」中看到该孩子并可管理其档案、任务与打卡。`
      );
    }

    if (String(force) !== "1" && String(force) !== "true") {
      return res.json(ok({
        needConfirm,
        warnings,
        child: { child_id: String(child.child_id), child_name: child.child_name },
        parent: { staff_id: String(parent.staff_id), staff_nickname: parent.staff_nickname, staff_username: parent.staff_username },
      }, needConfirm ? "请确认风险后执行" : "校验通过"));
    }

    await db.from("lp_children").update({ parent_staff_id: parent.staff_id, updated_at: nowSql() }).eq("child_id", child.child_id);
    logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: "后台绑定家长-孩子", module: "lp_children", apiPath: "/api/lp_children/bind", bizId: child.child_id, extra: { child_name: child.child_name, from_parent: currentParentId || null, to_parent: parent.staff_id, parent_nickname: parentName } });
    res.json(ok(null, `已绑定，孩子「${child.child_name}」现归属主家长「${parentName}」`));
  } catch (e) {
    console.error("[admin] lp_children bind error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 解绑孩子与当前主家长：仅清空家长归属，孩子档案、学生账号与已绑定小程序访问保留。两段式，force=1 才实际落库 */
router.post("/api/lp_children/unbind", adminAuth, async (req, res) => {
  try {
    // 安全审计 S5：解绑为后台最高级别操作，仅平台管理员可执行
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("仅管理员可执行该操作", 403));
    const { child_id, force } = req.body || {};
    if (!child_id) return res.json(fail("缺少孩子档案ID"));

    const child = await lpChildForAdmin(req, res, child_id);
    if (!child) return;

    const currentParentId = Number(child.parent_staff_id) || 0;
    if (currentParentId === 0) return res.json(fail("该孩子当前未绑定主家长，无需解绑"));

    let parentName = `#${currentParentId}`;
    const { data: pRows } = await db.from("staff")
      .select("staff_username, staff_nickname").eq("staff_id", currentParentId).limit(1);
    const parent = pRows && pRows[0];
    if (parent) parentName = parent.staff_nickname || parent.staff_username;

    // 风险提示：旧家长及其家属失去查看/管理；孩子数据与访问不受影响
    const warnings = [
      `解绑后，主家长「${parentName}」将无法再查看/管理孩子「${child.child_name}」的档案与学习数据，其名下家属共享的查看权限同步移除。`,
      "孩子档案、学生账号及已绑定的小程序访问均保留，可后续重新绑定到其他主家长。",
    ];

    if (String(force) !== "1" && String(force) !== "true") {
      return res.json(ok({
        needConfirm: true,
        warnings,
        child: { child_id: String(child.child_id), child_name: child.child_name },
        parent: { staff_id: String(currentParentId), staff_nickname: parentName },
      }, "请确认风险后执行"));
    }

    await db.from("lp_children").update({ parent_staff_id: 0, updated_at: nowSql() }).eq("child_id", child.child_id);
    logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: "后台解绑家长-孩子", module: "lp_children", apiPath: "/api/lp_children/unbind", bizId: child.child_id, extra: { child_name: child.child_name, from_parent: currentParentId, parent_nickname: parentName } });
    res.json(ok(null, `已解绑，孩子「${child.child_name}」现无主家长归属`));
  } catch (e) {
    console.error("[admin] lp_children unbind error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 课小满家属关系管理（后台，通用 CRUD） ====================
// 只读：家属关系由主家长在小程序共享；后台仅查看与审计
router.use("/api/lp_family_members", adminAuth, crudRouter({
  table: "lp_family_members", pk: "id",
  writable: [],
  search: ["member_openid"],
  filters: ["owner_staff_id", "member_status"],
  readonly: true,
  enrich: async (rows) => {
    const list = rows || [];
    if (list.length === 0) return list;
    const ids = [...new Set(list.flatMap(r => [Number(r.owner_staff_id), Number(r.member_staff_id)]).filter(Boolean))];
    const staffMap = {};
    if (ids.length > 0) {
      const { data } = await db.from("staff")
        .select("staff_id, staff_nickname, staff_username").in("staff_id", ids).limit(ids.length);
      (data || []).forEach(s => { staffMap[String(s.staff_id)] = s; });
    }
    return list.map(r => ({
      ...r,
      _ownerNickname: (staffMap[String(r.owner_staff_id)] || {}).staff_nickname || "",
      _memberNickname: (staffMap[String(r.member_staff_id)] || {}).staff_nickname || "",
    }));
  },
}));

// ==================== 家庭成员关系树（集中视图，后台专用） ====================
// 以「主家长」为根聚合：名下孩子（孩子档案 + 学生账号 + 小程序绑定 + 学生邀请码）与家属。
// 供后台「家庭关系」模块做树形一目了然展示；只读，不承载任何写操作。
router.get("/api/lp_family_tree/list", adminAuth, async (req, res) => {
  try {
    const appId = req.appId || "miniprogram-kxm";

    // 第 1 轮：主家长账号 + 孩子档案（并行；孩子档案按 app 维度，含无主家长归属的孤儿档案）
    const [parentsRes, childrenRes] = await Promise.all([
      db.from("staff")
        .select("staff_id, staff_username, staff_nickname, staff_avatar, staff_role, staff_status")
        .eq("staff_role", "parent").limit(2000),
      db.from("lp_children")
        .select("child_id, parent_staff_id, student_staff_id, child_name, gender, grade, class_no, school_name, birth_date")
        .eq("app_id", appId)
        .eq("child_status", 1)
        .limit(3000),
    ]);
    const parentList = parentsRes.data || [];
    const children = childrenRes.data || [];
    const parentIds = parentList.map(p => p.staff_id);

    // 计算派生 ID 集合
    const studentIds = [...new Set(children.map(c => Number(c.student_staff_id)).filter(v => v > 0))];
    const allStaffIds = [...new Set([...parentIds.map(Number), ...studentIds].filter(v => v > 0))];

    // 第 2 轮：学生/家长账号聚合 + 绑定关系 + 学生邀请码 + 家属关系 并行
    const [staffRes, bindRes, inviteRes, fmRes] = await Promise.all([
      allStaffIds.length > 0
        ? db.from("staff")
            .select("staff_id, staff_username, staff_nickname, staff_avatar, staff_role, staff_status")
            .in("staff_id", allStaffIds).limit(allStaffIds.length)
        : Promise.resolve({ data: [], error: null }),
      allStaffIds.length > 0
        ? db.from("lp_students")
            .select("id, staff_id, openid, app_id, bound_status, bound_at")
            .eq("app_id", appId)
            .in("staff_id", allStaffIds).limit(3000)
        : Promise.resolve({ data: [], error: null }),
      studentIds.length > 0
        ? db.from("lp_invites")
            .select("invite_code, kind, status, owner_staff_id, bound_at")
            .eq("app_id", appId)
            .eq("kind", "student")
            .in("owner_staff_id", studentIds)
            .order("invite_id", { ascending: false }).limit(studentIds.length * 2)
        : Promise.resolve({ data: [], error: null }),
      parentIds.length > 0
        ? db.from("lp_family_members")
            .select("id, owner_staff_id, member_staff_id, member_openid, member_status, bound_at")
            .eq("app_id", appId)
            .eq("member_status", 1)
            .in("owner_staff_id", parentIds).limit(3000)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const staffMap = {};
    (staffRes.data || []).forEach(s => { staffMap[String(s.staff_id)] = s; });
    const bindMap = {};
    (bindRes.data || []).forEach(b => { if (!bindMap[String(b.staff_id)]) bindMap[String(b.staff_id)] = b; });
    const inviteMap = {};
    (inviteRes.data || []).forEach(iv => { if (!inviteMap[String(iv.owner_staff_id)]) inviteMap[String(iv.owner_staff_id)] = iv; });
    const familyMembers = fmRes.data || [];

    // 第 3 轮：用户画像（绑定 openids + 家属 openids）+ 家属账号 并行
    const openids = [...new Set(Object.values(bindMap).map(b => b.openid).filter(Boolean))];
    const memberStaffIds = [...new Set(familyMembers.map(f => Number(f.member_staff_id)).filter(v => v > 0))];
    const memberOpenids = [...new Set(familyMembers.map(f => f.member_openid).filter(Boolean))];
    const [userRes, memberStaffRes, memberUserRes] = await Promise.all([
      openids.length > 0
        ? db.from("users").select("openid, user_uid, nickname, avatar").in("openid", openids).limit(openids.length)
        : Promise.resolve({ data: [], error: null }),
      memberStaffIds.length > 0
        ? db.from("staff")
            .select("staff_id, staff_username, staff_nickname, staff_avatar, staff_role, staff_status")
            .in("staff_id", memberStaffIds).limit(memberStaffIds.length)
        : Promise.resolve({ data: [], error: null }),
      memberOpenids.length > 0
        ? db.from("users").select("openid, user_uid, nickname, avatar").in("openid", memberOpenids).limit(memberOpenids.length)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const userMap = {};
    (userRes.data || []).forEach(u => { userMap[u.openid] = u; });
    const memberStaffMap = {};
    (memberStaffRes.data || []).forEach(s => { memberStaffMap[String(s.staff_id)] = s; });
    const memberUserMap = {};
    (memberUserRes.data || []).forEach(u => { memberUserMap[u.openid] = u; });

    // 8. 组装树：主家长 → 孩子（档案/学生账号/绑定/邀请码）+ 家属
    const bindingOf = (staffId) => {
      const b = bindMap[String(staffId)];
      if (!b) return null;
      const u = userMap[b.openid] || {};
      return {
        id: b.id,
        bound_status: b.bound_status,
        bound_at: b.bound_at,
        openid: b.openid,
        app_id: b.app_id || appId,
        app_name: req.appName || "",
        user_uid: u.user_uid || "",
        user_nickname: u.nickname || "",
        user_avatar: u.avatar || "",
      };
    };
    const families = parentList.map(p => {
      const childrenOfParent = children.filter(c => String(c.parent_staff_id) === String(p.staff_id));
      return {
        parent: {
          staff_id: p.staff_id,
          staff_username: p.staff_username,
          staff_nickname: p.staff_nickname,
          staff_avatar: p.staff_avatar || "",
          staff_status: p.staff_status,
          binding: bindingOf(p.staff_id),
        },
        children: childrenOfParent.map(c => {
          const stId = String(c.student_staff_id);
          const student = staffMap[stId] || null;
          const inv = inviteMap[stId] || null;
          return {
            child_id: c.child_id,
            child_name: c.child_name,
            gender: c.gender,
            grade: c.grade,
            class_no: c.class_no,
            school_name: c.school_name,
            birth_date: c.birth_date,
            student_staff_id: c.student_staff_id,
            student: student ? {
              staff_id: student.staff_id,
              staff_username: student.staff_username,
              staff_nickname: student.staff_nickname,
              staff_avatar: student.staff_avatar || "",
              staff_status: student.staff_status,
            } : null,
            binding: stId && Number(c.student_staff_id) > 0 ? bindingOf(c.student_staff_id) : null,
            invite: inv ? { invite_code: inv.invite_code, status: inv.status, bound_at: inv.bound_at } : null,
          };
        }),
        familyMembers: familyMembers
          .filter(f => String(f.owner_staff_id) === String(p.staff_id))
          .map(f => {
            const m = memberStaffMap[String(f.member_staff_id)] || null;
            const mu = memberUserMap[f.member_openid] || null;
            return {
              id: f.id,
              member_staff_id: f.member_staff_id,
              member_openid: f.member_openid,
              member_status: f.member_status,
              bound_at: f.bound_at,
              member: m ? {
                staff_id: m.staff_id,
                staff_username: m.staff_username,
                staff_nickname: m.staff_nickname,
                staff_avatar: m.staff_avatar || "",
                staff_role: m.staff_role,
                staff_status: m.staff_status,
              } : null,
              user_uid: mu ? mu.user_uid : "",
              user_nickname: mu ? mu.nickname : "",
              user_avatar: mu ? mu.avatar : "",
            };
          }),
      };
    });

    // 孤儿档案：孩子档案有但无主家长归属（parent_staff_id 不匹配任何主家长）
    const parentIdSet = new Set(parentList.map(p => String(p.staff_id)));
    const orphanChildren = children
      .filter(c => !parentIdSet.has(String(c.parent_staff_id)))
      .map(c => {
        const stId = String(c.student_staff_id);
        const student = staffMap[stId] || null;
        const inv = inviteMap[stId] || null;
        return {
          child_id: c.child_id,
          child_name: c.child_name,
          gender: c.gender,
          grade: c.grade,
          class_no: c.class_no,
          school_name: c.school_name,
          birth_date: c.birth_date,
          student_staff_id: c.student_staff_id,
          student: student ? {
            staff_id: student.staff_id,
            staff_username: student.staff_username,
            staff_nickname: student.staff_nickname,
            staff_avatar: student.staff_avatar || "",
            staff_status: student.staff_status,
          } : null,
          binding: stId && Number(c.student_staff_id) > 0 ? bindingOf(c.student_staff_id) : null,
          invite: inv ? { invite_code: inv.invite_code, status: inv.status, bound_at: inv.bound_at } : null,
        };
      });

    // 统计概览（顶部卡片用）
    const summary = {
      parentCount: families.length,
      childCount: families.reduce((n, f) => n + f.children.length, 0) + orphanChildren.length,
      boundParentCount: families.filter(f => f.parent.binding && f.parent.binding.bound_status === 1).length,
      boundChildCount: [...families.flatMap(f => f.children), ...orphanChildren]
        .filter(c => c.binding && c.binding.bound_status === 1).length,
      familyMemberCount: families.reduce((n, f) => n + f.familyMembers.length, 0),
    };

    res.json(ok({ families, orphanChildren, summary }));
  } catch (e) {
    console.error("[admin] lp_family_tree error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 角色管理（含菜单分配） ====================
// 读取角色列表，附加 menuIds（关联菜单）
router.get("/api/roles/list", adminAuth, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;
    const size = Math.min(Number(pageSize) || 20, 100);
    const pageNo = Math.max(1, Number(page) || 1);
    const offset = (pageNo - 1) * size;
    // 优先用 PostgREST range(offset, offset+size-1) 服务端分页（offset/limit，无 2000 行硬上限）；
    // 网关不支持时回退为拉取 offset+size 行后内存切片实现分页
    const buildBase = () => {
      let q = db.from("roles").select();
      if (keyword) q = q.or(`role_name.like.%${String(keyword).replace(/[(),]/g, "").slice(0, 100)}%,role_code.like.%${String(keyword).replace(/[(),]/g, "").slice(0, 100)}%`);
      return q;
    };
    let paged = [];
    const [rangeRes, countRes] = await Promise.all([
      buildBase().order("role_id", { ascending: true }).range(offset, offset + size - 1),
      db.from("roles").select("role_id", { count: "exact" }).limit(1),
    ]);
    if (!rangeRes.error) {
      paged = rangeRes.data || [];
    } else {
      const fetchLimit = Math.min(offset + size, 2000);
      const { data: rows, error } = await buildBase().order("role_id", { ascending: true }).limit(fetchLimit);
      if (error) throw error;
      paged = (rows || []).slice(offset, offset + size);
    }

    // 附加菜单ID
    const roleCodes = paged.map(r => r.role_code);
    const menuMap = {};
    if (roleCodes.length > 0) {
      const { data: rms, error: rmErr } = await db.from("role_menus").select("role_code, menu_id").in("role_code", roleCodes).limit(500);
      if (!rmErr) (rms || []).forEach(rm => {
        if (!menuMap[rm.role_code]) menuMap[rm.role_code] = [];
        menuMap[rm.role_code].push(String(rm.menu_id));
      });
    }
    const list = paged.map(r => ({ ...r, menuIds: menuMap[r.role_code] || [] }));
    let total = paged.length;
    if (!countRes.error && typeof countRes.count === "number" && countRes.count >= 0) total = countRes.count;
    res.json(ok({ list, total, page: pageNo, pageSize: size }));
  } catch (e) {
    console.error("[admin] roles list error", e);
    res.json(fail("服务异常", 500));
  }
});

// 角色详情
router.get("/api/roles/detail", adminAuth, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("roles").select().eq("role_id", id).limit(1);
    if (error) throw error;
    const role = (rows && rows[0]) || null;
    let menuIds = [];
    if (role) {
      const { data: rms, error: rmErr } = await db.from("role_menus").select("menu_id").eq("role_code", role.role_code).limit(500);
      if (!rmErr) menuIds = (rms || []).map(r => String(r.menu_id));
    }
    res.json(ok({ record: role ? { ...role, menuIds } : null }));
  } catch (e) {
    console.error("[admin] roles detail error", e);
    res.json(fail("服务异常", 500));
  }
});

// 角色新增（含菜单分配）
router.post("/api/roles/create", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { role_code, role_name, role_status, menuIds } = req.body || {};
    if (!role_code || !role_name) return res.json(fail("缺少角色编码或名称"));
    const { error } = await db.from("roles").insert({
      role_id: await nextSeq("role_id"),
      role_code: String(role_code).trim(),
      role_name: String(role_name).trim(),
      role_status: role_status != null ? Number(role_status) : 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    if (error) throw error;
    await syncRoleMenus(role_code, menuIds);
    logStaffEvent({ req, staff: req.staff, eventType: "create", eventName: "创建角色", module: "roles", apiPath: "/api/roles/create", bizId: role_code });
    res.json(ok(null, "创建成功"));
  } catch (e) {
    console.error("[admin] roles create error", e);
    res.json(fail("服务异常", 500));
  }
});

// 角色更新（含菜单分配）
router.post("/api/roles/update", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id, role_code, role_name, role_status, menuIds } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("roles").select("role_code").eq("role_id", id).limit(1);
    if (error) throw error;
    const cur = (rows && rows[0]);
    if (!cur) return res.json(fail("角色不存在"));
    if (cur.role_code === "admin" && String(role_code) !== "admin") return res.json(fail("内置管理员角色不可修改编码"));
    const values = { updated_at: nowSql() };
    if (role_code) values.role_code = String(role_code).trim();
    if (role_name) values.role_name = String(role_name).trim();
    if (role_status != null) values.role_status = Number(role_status);
    const { error: upErr } = await db.from("roles").update(values).eq("role_id", id);
    if (upErr) throw upErr;
    await syncRoleMenus(values.role_code || cur.role_code, menuIds);
    logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: "更新角色", module: "roles", apiPath: "/api/roles/update", bizId: id });
    res.json(ok(null, "更新成功"));
  } catch (e) {
    console.error("[admin] roles update error", e);
    res.json(fail("服务异常", 500));
  }
});

// 角色删除（同时清理关联菜单）
router.post("/api/roles/delete", adminAuth, async (req, res) => {
  try {
    if (req.staff.role !== "admin") return res.json(fail("无权操作", 403));
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const { data: rows, error } = await db.from("roles").select("role_code").eq("role_id", id).limit(1);
    if (error) throw error;
    const role = (rows && rows[0]);
    if (!role) return res.json(fail("角色不存在"));
    if (role.role_code === "admin") return res.json(fail("内置管理员角色不可删除"));
    await db.from("role_menus").delete().eq("role_code", role.role_code);
    const { error: delErr } = await db.from("roles").delete().eq("role_id", id);
    if (delErr) throw delErr;
    logStaffEvent({ req, staff: req.staff, eventType: "delete", eventName: "删除角色", module: "roles", apiPath: "/api/roles/delete", bizId: id, extra: { role_code: role.role_code } });
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[admin] roles delete error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 同步角色菜单关联（先删后插） */
async function syncRoleMenus(roleCode, menuIds) {
  if (!roleCode) return;
  const ids = Array.isArray(menuIds) ? [...new Set(menuIds.map(String).filter(Boolean))] : [];
  await db.from("role_menus").delete().eq("role_code", roleCode);
  for (const mid of ids) {
    await db.from("role_menus").insert({ id: await nextSeq("role_menu_id"), role_code: roleCode, menu_id: Number(mid), created_at: nowSql() });
  }
}

// ==================== 菜单管理 ====================
router.use("/api/menus", adminAuth, crudRouter({
  table: "menus", pk: "menu_id",
  writable: ["parent_id", "menu_name", "menu_path", "menu_icon", "sort", "menu_type", "menu_status"],
  search: ["menu_name", "menu_path"],
  filters: ["menu_type", "menu_status"],
  pkGenerator: () => nextSeq("menu_id"),
}));

// ==================== 数据字典 ====================
// 字典类型（如 subject=科目）
router.use("/api/dict_types", adminAuth, crudRouter({
  table: "dict_types", pk: "dict_id",
  writable: ["dict_code", "dict_name", "dict_status"],
  search: ["dict_code", "dict_name"],
  filters: ["dict_status"],
  pkGenerator: () => nextSeq("dict_type_id"),
}));

// 字典项（如 科目：语文/数学/英语...），按 dict_code 过滤；写后让对应字典缓存失效
router.use("/api/dict_items", adminAuth, crudRouter({
  table: "dict_items", pk: "item_id",
  writable: ["dict_code", "item_value", "item_label", "color", "sort", "item_status"],
  search: ["item_label", "item_value"],
  filters: ["dict_code", "item_status"],
  pkGenerator: () => nextSeq("dict_item_id"),
  onAfterCreate: async (req, values) => invalidateDictItems([values.dict_code]),
  onAfterUpdate: async (req, values) => invalidateDictItems([values.dict_code]),
  onAfterDelete: async (req, record) => invalidateDictItems([record.dict_code]),
}));

// ==================== 学习管理：任务管理 ====================
// 读写分离：
// - 读范围：学生/管理员均可查看全部任务（单一学生场景，管理员创建的任务学生可见）
// - 写范围：非管理员只能操作自己创建的任务（created_by 存 staff_id）
function taskScope(req) {
  if (req.staff && req.staff.role === "admin") return null;
  return { field: "created_by", value: (req.staff && req.staff.staff_id) || "" };
}

// ==================== 家庭维度数据可见范围（安全审计 S6） ====================
// 非管理员（家长/家属/学生）只能看到本家庭的数据，杜绝跨家庭读取任务/打卡/合集：
// - parent/family → 名下孩子的 student staff_id + 本人
// - student → 本人
// - admin → null（全部）
async function familyStaffScope(req) {
  const role = (req.staff && req.staff.role) || "";
  const staffId = String((req.staff && req.staff.staff_id) || "");
  if (role === "admin") return null;
  let ids = [];
  try { ids = await familyScope(staffId, role); } catch (_) { ids = []; }
  const set = new Set((ids || []).map(String));
  if (staffId) set.add(staffId);
  set.delete("");
  return set;
}

/** 家庭可见任务 ID 集合（创建人或派发人在家庭范围内）；admin 返回 null（不过滤） */
async function familyTaskIds(req) {
  const scope = await familyStaffScope(req);
  if (!scope) return null;
  const sids = [...scope].map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (sids.length === 0) return [];
  const [created, assigned] = await Promise.all([
    db.from("tasks").select("task_id").in("created_by", sids).limit(5000),
    db.from("task_assignees").select("task_id").in("staff_id", sids).limit(5000),
  ]);
  const set = new Set();
  (created && !created.error && Array.isArray(created.data) ? created.data : []).forEach(r => set.add(Number(r.task_id)));
  (assigned && !assigned.error && Array.isArray(assigned.data) ? assigned.data : []).forEach(r => set.add(Number(r.task_id)));
  return [...set];
}

/** 当前登录员工是否可访问指定任务（admin 全部；其余按家庭可见范围） */
async function canAccessTask(req, taskId) {
  const role = (req.staff && req.staff.role) || "";
  if (role === "admin") return true;
  const ids = await familyTaskIds(req);
  return Array.isArray(ids) && ids.includes(Number(taskId));
}
// ==================== 任务派发（task_assignees） ====================
// 同步任务派发人员：全量替换 task_assignees（幂等，返回最终派发 staff_id 数组）
// 规则：学生创建/编辑的任务派发固定为本人（忽略前端提交，禁止派发给别人）；
//      管理员可按需派发给多名学生角色员工。
// 容错：同步失败仅记录日志并返回 []，不阻断任务本身的增改流程。
async function syncTaskAssignees(req, taskId) {
  const staff = req.staff || {};
  let ids = [];
  if (staff.role === "student") {
    ids = [String(staff.staff_id)];
  } else {
    const raw = req.body && req.body.assignee_ids;
    ids = (Array.isArray(raw) ? raw : []).map(x => String(x)).filter(Boolean);
  }
  let validIds = [];
  try {
    // 仅保留存在的学生角色员工（防御非法 staff_id，去重）
    const uniq = [...new Set(ids)];
    if (uniq.length > 0) {
      const { data: sts, error } = await db.from("staff")
        .select("staff_id").eq("staff_role", "student").in("staff_id", uniq).limit(uniq.length);
      if (!error && Array.isArray(sts)) validIds = sts.map(s => Number(s.staff_id));
    }
    await db.from("task_assignees").delete().eq("task_id", taskId);
    if (validIds.length > 0) {
      await db.from("task_assignees").insert(validIds.map(sid => ({ task_id: taskId, staff_id: sid })));
    }
  } catch (e) {
    console.error("[admin] syncTaskAssignees error", e);
    return [];
  }
  return validIds;
}

// 查询任务当前已派发的 staff_id 数组（供时间轴审计对比变更前后）
async function taskAssigneeIds(taskId) {
  try {
    const { data: rows, error } = await db.from("task_assignees")
      .select("staff_id").eq("task_id", taskId).limit(5000);
    if (error) return [];
    return (rows || []).map(r => Number(r.staff_id));
  } catch (e) {
    return [];
  }
}

// 任务附加派发人员：assignee_ids（数组）+ assignee_names（昵称数组）
async function attachAssignees(rows) {
  const list = rows || [];
  if (list.length === 0) return list;
  const taskIds = [...new Set(list.map(r => r.task_id).filter(v => v !== undefined && v !== null && v !== ""))];
  if (taskIds.length === 0) return list;
  const byTask = {};
  const staffIds = new Set();
  const { data: assigns, error } = await db.from("task_assignees")
    .select("task_id, staff_id").in("task_id", taskIds).limit(5000);
  if (!error && Array.isArray(assigns)) assigns.forEach(a => {
    const k = String(a.task_id);
    (byTask[k] = byTask[k] || []).push(Number(a.staff_id));
    staffIds.add(String(a.staff_id));
  });
  const nameMap = await cachedStaffRows([...staffIds]);
  return list.map(r => {
    const ids = byTask[String(r.task_id)] || [];
    return {
      ...r,
      assignee_ids: ids,
      assignee_names: ids.map(id => nameMap[String(id)] ? (nameMap[String(id)].staff_nickname || nameMap[String(id)].staff_username || String(id)) : String(id)),
    };
  });
}
// 创建人/打卡人按 staff_id 附加完整员工信息（_creatorStaffId/_creatorUsername/_creatorNickname）；
// 同时按归属账号 staff_id 附加昵称（_staffNickname/_staffUsername），供合集/科目「归属账号」列与详情展示
async function attachStaffInfo(rows) {
  const list = rows || [];
  if (list.length === 0) return list;
  const creatorIds = [...new Set(list.map(r => r.created_by).filter(Boolean))];
  const ownerIds = [...new Set(list.map(r => r.staff_id).filter(v => v !== undefined && v !== null && String(v) !== "" && Number(v) !== 0))];
  const ids = [...new Set([...creatorIds, ...ownerIds].map(String).filter(Boolean))];
  if (ids.length === 0) return list;
  const staffMap = await cachedStaffRows(ids);
  return list.map(r => {
    const c = staffMap[String(r.created_by)] || {};
    const o = staffMap[String(r.staff_id)] || {};
    return {
      ...r,
      _creatorStaffId: r.created_by,
      _creatorUsername: c.staff_username || "",
      _creatorNickname: c.staff_nickname || "",
      _staffUsername: o.staff_username || "",
      _staffNickname: o.staff_nickname || "",
    };
  });
}

// 审计日志按 staff_id 附加员工昵称（_staffNickname/_staffUsername）
async function attachStaffName(rows) {
  const ids = [...new Set((rows || []).map(r => r.staff_id).filter(v => v))];
  if (ids.length === 0) return rows || [];
  const staffMap = await cachedStaffRows(ids);
  return (rows || []).map(r => {
    const s = staffMap[String(r.staff_id)] || {};
    return {
      ...r,
      _staffNickname: s.staff_nickname || "",
      _staffUsername: s.staff_username || r.staff_username || "",
    };
  });
}

// 任务附加所属合集名称（collection_name）
async function attachCollectionName(rows) {
  const ids = [...new Set((rows || []).map(r => r.collection_id).filter(v => v !== undefined && v !== null && v !== 0))];
  if (ids.length === 0) return rows || [];
  const colMap = await cachedCollectionNames(ids);
  return (rows || []).map(r => ({
    ...r,
    collection_name: (colMap[String(r.collection_id)] || {}).name || "",
  }));
}

// 合集动态统计任务数量（task_count 读取时实时统计，避免增删改任务后计数失真）
async function attachCollectionCount(rows) {
  const ids = [...new Set((rows || []).map(r => r.collection_id).filter(v => v !== undefined && v !== null && v !== 0))];
  const list = rows || [];
  if (ids.length === 0) return list;
  const { data: tasks, error } = await db.from("tasks")
    .select("collection_id").in("collection_id", ids).limit(5000);
  const countMap = {};
  if (!error && Array.isArray(tasks)) tasks.forEach(t => {
    const k = String(t.collection_id);
    countMap[k] = (countMap[k] || 0) + 1;
  });
  return list.map(r => ({ ...r, task_count: countMap[String(r.collection_id)] || 0 }));
}

// ==================== 任务时间轴：任务/打卡全生命周期事件 ====================
// 供后台「任务管理 / 打卡管理」操作列时间轴抽屉展示与审计追溯（表 task_timeline）
const taskTitleOf = (r) => String((r && r.title) || "").trim().slice(0, 30);
const taskStaffId = (req) => (req.staff && req.staff.staff_id) || "";

/** 图片字段解析：兼容 JSON 数组字符串（["a.jpg"]）/ 逗号分隔 / 数组，返回相对路径数组（用于级联删除与统计） */
function parseImgList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const s = String(value || "").trim();
  if (!s || s === "[]") return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch (_) { /* 非 JSON，按逗号分隔处理 */ }
  }
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

/**
 * 同步任务图片（保存任务时调用）：
 * 1) 回写业务 ID：上传时拿不到任务 ID，保存时把提交的图片路径统一关联到 task_id（file_uploads.biz_id）
 * 2) 完全复制：新建（复制创建）时，若提交图片已被其他任务绑定（复制场景），物理复制新文件归本任务，
 *    避免原任务删除后副本图片失效（admin 复制任务走通用 create，同构处理）
 * 3) 清理脏数据：对比编辑前后图片，对已移除的图片执行 COS 物理删除并清理 file_uploads 登记记录
 * 仅当本次提交携带 images 字段时执行；失败仅打日志，不影响任务保存结果
 */
async function syncTaskImages(req, id, values, oldRecord) {
  if (values.images === undefined || values.images === null) return;
  try {
    let newPaths = parseImgList(values.images);
    // 1) 回写业务 ID（后台上传 openid 为空）
    if (newPaths.length > 0) {
      // 创建场景：复制/复用他任务图片时物理复制新文件（完全复制，存到新任务当前日期目录）
      if (!oldRecord) {
        const owned = await dupSharedImages({ openid: "", staffId: (req.staff && req.staff.staff_id) || "", paths: newPaths, targetBizId: id, biz: "tasks", date: formatDate(new Date()) });
        if (owned.join("|") !== newPaths.join("|")) {
          newPaths = owned;
          await db.from("tasks").update({ images: JSON.stringify(owned), updated_at: nowSql() }).eq("task_id", id);
        }
      }
      await bindBizId({ openid: "", paths: newPaths, bizId: id });
    }
    // 2) 编辑场景：diff 出已移除的图片并清理（与任务级联删除同构：物理删 COS + 删登记记录）
    if (oldRecord) {
      const oldPaths = parseImgList(oldRecord.images);
      const removed = oldPaths.filter(p => !newPaths.includes(p));
      if (removed.length === 0) return;
      const { deleted } = await removeFiles(removed);
      if (deleted.length > 0) {
        try { await db.from("file_uploads").delete().in("file_path", deleted); } catch (_) {}
      }
    }
  } catch (e) {
    console.error("[admin] syncTaskImages error", e);
  }
}

/**
 * 删除任务前的统计：返回该任务的打卡数量与图片数量（任务附件 + 全部打卡图片）
 * 供前端删除确认弹窗展示级联删除提醒
 */
router.get("/api/tasks/deleteStats", adminAuth, async (req, res) => {
  try {
    const { taskId } = req.query;
    if (!taskId) return res.json(fail("缺少任务 ID"));
    const tid = Number(taskId);
    const [ckCountRes, voiceRes, ckRes, tkRes] = await Promise.all([
      db.from("task_checkins").select("checkin_id", { count: "exact" }).eq("task_id", tid).limit(1),
      db.from("task_checkins").select("checkin_id", { count: "exact" }).eq("task_id", tid).neq("voice_url", "").limit(1),
      db.from("task_checkins").select("checkin_images").eq("task_id", tid).limit(10000),
      db.from("tasks").select("images").eq("task_id", tid).limit(1),
    ]);
    if (ckRes.error) throw ckRes.error;
    if (tkRes.error) throw tkRes.error;
    const checkinList = ckRes.data || [];
    let checkinImageCount = 0;
    checkinList.forEach(c => {
      checkinImageCount += parseImgList(c.checkin_images).length;
    });
    const checkinCount = (ckCountRes && !ckCountRes.error && typeof ckCountRes.count === "number") ? ckCountRes.count : checkinList.length;
    const checkinVoiceCount = (voiceRes && !voiceRes.error && typeof voiceRes.count === "number") ? voiceRes.count : 0;
    const taskImageCount = parseImgList((tkRes.data && tkRes.data[0] && tkRes.data[0].images) || "").length;
    res.json(ok({
      checkin_count: checkinCount,
      checkin_image_count: checkinImageCount,
      checkin_voice_count: checkinVoiceCount,
      task_image_count: taskImageCount,
      image_count: checkinImageCount + taskImageCount,
    }));
  } catch (e) {
    console.error("[admin] tasks deleteStats error", e);
    res.json(fail("服务异常", 500));
  }
});

function logTaskCreate(req, values, id, assigneeIds) {
  logTaskEvent({
    taskId: id, bizType: "task", eventType: "create", eventName: "创建任务",
    summary: `创建任务「${taskTitleOf(values)}」`,
    payload: {
      title: values.title, subject: values.subject, task_status: values.task_status,
      start_date: values.start_date, deadline: values.deadline, collection_id: values.collection_id,
      assignee_ids: assigneeIds || [],
    },
    staffId: taskStaffId(req),
  });
}

function logTaskUpdate(req, values, id, oldRecord, assigneeIds, oldAssigneeIds) {
  const toDone = oldRecord.task_status !== "done" && values.task_status === "done";
  // 记录本次实际变更字段（含旧值/新值）
  const changed = {};
  Object.keys(values).forEach(k => {
    if (String(oldRecord[k] ?? "") !== String(values[k] ?? "")) {
      changed[k] = { from: oldRecord[k], to: values[k] };
    }
  });
  if (assigneeIds || oldAssigneeIds) {
    changed.assignee_ids = { from: oldAssigneeIds || [], to: assigneeIds || [] };
  }
  logTaskEvent({
    taskId: id, bizType: "task",
    eventType: toDone ? "done" : "update",
    eventName: toDone ? "完成任务" : "更新任务",
    summary: toDone ? `完成任务「${taskTitleOf(oldRecord)}」` : `更新任务「${taskTitleOf(oldRecord)}」`,
    payload: { changed, task_status: values.task_status },
    staffId: taskStaffId(req),
  });
}

function logTaskDelete(req, record, id) {
  logTaskEvent({
    taskId: id, bizType: "task", eventType: "delete", eventName: "删除任务",
    summary: `删除任务「${taskTitleOf(record)}」`,
    payload: { title: record.title, task_status: record.task_status, checkin_count: record.checkin_count },
    staffId: taskStaffId(req),
  });
}

// 任务时间轴查询：按任务或打卡过滤（任务时间轴 = 任务事件 + 该任务全部打卡事件）
router.get("/api/tasks/timeline", adminAuth, async (req, res) => {
  try {
    const { taskId, checkinId } = req.query;
    if (!taskId && !checkinId) return res.json(fail("缺少查询条件"));
    let q = db.from("task_timeline").select("event_id, task_id, checkin_id, biz_type, event_type, event_name, summary, payload, created_by, created_at");
    if (taskId) q = q.eq("task_id", Number(taskId));
    if (checkinId) q = q.eq("checkin_id", Number(checkinId));
    const { data: rows, error } = await q
      .order("created_at", { ascending: true })
      .order("event_id", { ascending: true })
      .limit(500);
    if (error) throw error;
    const list = await attachStaffInfo(rows || []);
    res.json(ok({ list, total: (rows || []).length }));
  } catch (e) {
    console.error("[admin] tasks timeline error", e);
    res.json(fail("服务异常", 500));
  }
});

router.use("/api/tasks", adminAuth, crudRouter({
  table: "tasks", pk: "task_id",
  writable: ["title", "subject", "description", "images", "task_status", "checkin_type", "score", "start_date", "deadline", "tags", "collection_id", "task_link"],
  search: ["title", "subject"],
  filters: ["task_status", "subject", "collection_id", "source", "risk_status"],
  // 按用户过滤（staff_id，非表字段故不走白名单 filters）：创建人 = 该员工 或 任务派发给该员工
  // 注意：RDB 查询链是 thenable，async 函数不能直接 return 构建器（会被吞掉提前执行），须返回 { q } 包装
  // 安全审计 S6：非管理员（家长/家属/学生）先按家庭可见范围收敛（杜绝跨家庭读取），管理员再叠加 staff_id 钻取
  extraFilter: async (req, q) => {
    let q2 = q;
    // 1) 家庭维度收敛
    const famIds = await familyTaskIds(req);
    if (Array.isArray(famIds)) {
      if (famIds.length === 0) return { q: q2.eq("task_id", -1) };
      q2 = q2.in("task_id", famIds);
    }
    // 2) 指定学生钻取（管理员查看某学生）
    const sid = String(req.query.staff_id || "").trim();
    if (sid) {
      const [created, assigned] = await Promise.all([
        db.from("tasks").select("task_id").eq("created_by", sid).order("task_id", { ascending: false }).limit(1000),
        db.from("task_assignees").select("task_id").eq("staff_id", sid).order("task_id", { ascending: false }).limit(1000),
      ]);
      const ids = new Set();
      (created && !created.error && Array.isArray(created.data) ? created.data : [])
        .forEach(r => ids.add(Number(r.task_id)));
      (assigned && !assigned.error && Array.isArray(assigned.data) ? assigned.data : [])
        .forEach(r => ids.add(Number(r.task_id)));
      if (ids.size === 0) return { q: q2.eq("task_id", -1) };
      q2 = q2.in("task_id", [...ids]);
    }
    return { q: q2 };
  },
  scopeFn: taskScope,
  readScopeFn: () => null,
  defaults: (req) => ({ created_by: (req.staff && req.staff.staff_id) || "", progress: 1, source: "web" }),
  enrich: async (rows) => {
    const list = rows || [];
    if (list.length === 0) return list;
    const [staffed, assigned, collected] = await Promise.all([
      attachStaffInfo(list),
      attachAssignees(list),
      attachCollectionName(list),
    ]);
    return list.map((r, i) => ({ ...r, ...(staffed[i] || {}), ...(assigned[i] || {}), ...(collected[i] || {}) }));
  },
  pkGenerator: () => nextSeq("task_id"),
  // 打卡方式白名单校验：非法值回退图文
  onBeforeCreate: async (req, values) => {
    const c = String(values.checkin_type || "image").trim();
    values.checkin_type = normalizeCheckinType(c);
    return null;
  },
  onAfterCreate: async (req, values, id) => {
    const assigneeIds = await syncTaskAssignees(req, id);
    await syncTaskImages(req, id, values, null);
    logTaskCreate(req, values, id, assigneeIds);
    // 系统通知：新任务派发 → 通知被派发学生（后台布置，assignerName=后台操作人昵称）
    notifyTaskAssigned({
      appId: req.appId || "miniprogram-kxm",
      taskId: id,
      taskTitle: (values && values.title) || "",
      assigneeIds,
      assignerStaffId: Number((req.staff && req.staff.staff_id) || 0),
    }).catch(() => {});
  },
  onAfterUpdate: async (req, values, id, oldRecord) => {
    const oldAssigneeIds = await taskAssigneeIds(id);
    const assigneeIds = await syncTaskAssignees(req, id);
    await syncTaskImages(req, id, values, oldRecord);
    logTaskUpdate(req, values, id, oldRecord, assigneeIds, oldAssigneeIds);
    // 积分账本：任务完成 +30 / 回退 -30（幂等：按 old→new 状态变迁判定）
    if (oldRecord && values.task_status !== undefined && oldRecord.task_status !== values.task_status) {
      const actor = Number((req.staff && req.staff.staff_id) || 0);
      applyTaskStatusPoints(oldRecord, oldRecord.task_status, values.task_status, actor).catch(() => {});
      // 系统通知：任务完成 → 通知任务归属学生的家长/家属（操作人自己除外）
      if (values.task_status === "done" && oldRecord.task_status !== "done") {
        notifyTaskDone({ appId: req.appId || "miniprogram-kxm", task: oldRecord, actorStaffId: actor }).catch(() => {});
      }
    }
  },
  // 兜底风控：已完成任务仅可查看，学生禁止修改（管理员不受限）
  onBeforeUpdate: async (req, oldRecord, values) => {
    if (req.staff && req.staff.role === "student" && oldRecord.task_status === "done") {
      return "任务已完成，仅可查看，禁止修改";
    }
    if (values.checkin_type !== undefined) {
      const c = String(values.checkin_type || "image").trim();
      values.checkin_type = normalizeCheckinType(c);
    }
    // 状态流转同步进度：已完成=100；进行中(已有打卡)=50；回到待完成=1
    if (values.task_status !== undefined) {
      if (values.task_status === "done") values.progress = 100;
      else if (values.task_status === "doing") values.progress = (oldRecord.checkin_count || 0) > 0 ? 50 : 1;
      else if (values.task_status === "todo") values.progress = 1;
    }
    return null;
  },
  onBeforeDelete: async (req, record) => {
    if (req.staff && req.staff.role === "student" && record.task_status === "done") {
      return "任务已完成，仅可查看，禁止删除";
    }
    return null;
  },
  onAfterDelete: async (req, record, id) => {
    // 积分账本：删除任务回扣（已完成 -30、已通过打卡每人 -10），须在派发人关联删除前调用
    const actor = Number((req.staff && req.staff.staff_id) || 0);
    deductTaskDeleted(record, actor).catch(() => {});
    // 级联删除：删除该任务关联的全部打卡，并物理清理任务附件图片与打卡图片（腾讯云存储 + file_uploads 登记记录）
    try {
      const { data: checkins, error } = await db.from("task_checkins")
        .select("checkin_id, checkin_images, voice_url, video_url, video_cover").eq("task_id", id).limit(10000);
      if (error) throw error;
      const checkinList = checkins || [];

      // 1) 收集该任务全部媒体相对路径（任务附件图片 + 打卡图片 + 打卡语音 + 打卡视频 + 视频封面）
      const paths = [...parseImgList(record.images)];
      checkinList.forEach(c => {
        paths.push(...parseImgList(c.checkin_images));
        if (c.voice_url) paths.push(c.voice_url);
        if (c.video_url) paths.push(c.video_url);
        if (c.video_cover) paths.push(c.video_cover);
      });

      // 2) 物理删除腾讯云存储对象（成功失败分别统计，失败的文件登记记录保留便于重试）
      const { deleted } = await removeFiles(paths);

      // 3) 物理删除成功的文件同步清理 file_uploads 登记记录
      if (deleted.length > 0) {
        try { await db.from("file_uploads").delete().in("file_path", deleted); } catch (_) {}
      }

      // 4) 删除该任务全部打卡记录
      if (checkinList.length > 0) {
        const { error: delErr } = await db.from("task_checkins").delete().eq("task_id", id);
        if (delErr) throw delErr;
      }

      // 5) 删除任务派发人员关联
      try { await db.from("task_assignees").delete().eq("task_id", id); } catch (_) {}
    } catch (e) {
      console.error("[admin] task cascade delete error", e);
    }
    logTaskDelete(req, record, id);
  },
}));

// ==================== 学习管理：合集管理 ====================
// 合集是独立功能（非数据字典）：按 staff_id 归属（主家长/个人），家庭内共享查看；
// 非管理员只能增删改自己归属的合集；admin 全部。
// 删除合集：先解除该合集下任务的归属（collection_id 置 0），避免孤儿引用，再删除合集
router.post("/api/task_collections/delete", adminAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const staffId = (req.staff && req.staff.staff_id) || "";
    const isAdmin = req.staff && req.staff.role === "admin";
    let q = db.from("task_collections").select().eq("collection_id", id);
    if (!isAdmin) q = q.eq("staff_id", staffId);
    const { data: rows, error } = await q.limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("合集不存在或无权删除", 403));
    await db.from("tasks")
      .update({ collection_id: 0, updated_at: nowSql() })
      .eq("collection_id", id);
    const { error: delErr } = await db.from("task_collections").delete().eq("collection_id", id);
    if (delErr) throw delErr;
    logStaffEvent({ req, staff: req.staff, eventType: "delete", eventName: "删除合集", module: "task_collections", apiPath: "/api/task_collections/delete", bizId: id });
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[admin] task_collections delete error", e);
    res.json(fail("服务异常", 500));
  }
});
router.use("/api/task_collections", adminAuth, crudRouter({
  table: "task_collections", pk: "collection_id",
  writable: ["name", "description", "cover_images", "collection_status"],
  search: ["name", "description"],
  filters: ["collection_status"],
  scopeFn: taskScope,
  readScopeFn: () => null,
  defaults: (req) => ({
    created_by: (req.staff && req.staff.staff_id) || "",
    staff_id: (req.staff && req.staff.staff_id) || "",
  }),
  // 安全审计 S6：非管理员按家庭可见员工收敛合集（按归属 staff_id）
  extraFilter: async (req, q) => {
    const fam = await familyStaffScope(req);
    if (!fam) return { q };
    const sids = [...fam].map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (sids.length === 0) return { q: q.eq("staff_id", -1) };
    return { q: q.in("staff_id", sids) };
  },
  enrich: async (rows) => attachCollectionCount(await attachStaffInfo(rows)),
  pkGenerator: () => nextSeq("collection_id"),
  onAfterCreate: async (req, values, id) => invalidateCollectionRows([id]),
  onAfterUpdate: async (req, values, id) => invalidateCollectionRows([id]),
  onAfterDelete: async (req, record, id) => invalidateCollectionRows([id]),
}));

// ==================== 学习管理：科目管理 ====================
// 科目独立成表（t_lp_subjects），按 staff_id 归属（主家长/个人）；家庭内共享查看。
// 非管理员只能增删改自己归属的科目；admin 全部。
router.use("/api/subjects", adminAuth, crudRouter({
  table: "subjects", pk: "subject_id",
  writable: ["name", "color", "sort", "subject_status"],
  search: ["name"],
  filters: ["subject_status"],
  scopeFn: (req) => {
    if (req.staff && req.staff.role === "admin") return null;
    return { field: "staff_id", value: (req.staff && req.staff.staff_id) || "" };
  },
  readScopeFn: () => null,
  defaults: (req) => ({ staff_id: (req.staff && req.staff.staff_id) || "" }),
  extraFilter: async (req, q) => {
    const fam = await familyStaffScope(req);
    if (!fam) return { q };
    const sids = [...fam].map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (sids.length === 0) return { q: q.eq("staff_id", -1) };
    return { q: q.in("staff_id", sids) };
  },
  // 归属账号带昵称展示（与合集管理一致：_staffNickname）
  enrich: attachStaffInfo,
  pkGenerator: () => nextSeq("subject_id"),
}));

// 序列管理（任务ID/打卡ID等主键发放配置，仅管理员使用）
router.use("/api/seqs", adminAuth, crudRouter({
  table: "seqs", pk: "seq_key",
  writable: ["seq_key", "seq_name", "current_value", "init_value", "step", "batch"],
  search: ["seq_key", "seq_name"],
}));

// ==================== 小程序配置（t_apps，密钥存表，后台可维护） ====================
// app_secret / jwt_secret 列表与详情均不返回（exclude）；仅在编辑表单中可填写（writable）
// subscribe_tmpl_ids / reminder_window / reminder_days / reminder_overdue_days：订阅消息模板与打卡提醒时机配置
router.use("/api/apps", adminAuth, crudRouter({
  table: "apps", pk: "app_id",
  writable: ["app_name", "wechat_appid", "app_secret", "jwt_secret", "jwt_expires", "service_url", "app_desc", "app_status", "subscribe_tmpl_ids", "reminder_window", "reminder_days", "reminder_overdue_days", "content_security"],
  search: ["app_id", "app_name"],
  // 密钥明文存表：列表/详情不返回；编辑留空则保持原值（blankKeep，不做哈希）
  exclude: ["app_secret", "jwt_secret"],
  blankKeep: ["app_secret", "jwt_secret"],
  filters: ["app_status"],
  onAfterUpdate: async (req, values, id) => invalidateAppConfig(id),
}));

// 系统参数（常量维护：单条 key 或 JSON 集中文案；后台修改后最多 60s 生效）
router.use("/api/system_params", adminAuth, crudRouter({
  table: "system_params", pk: "param_id",
  writable: ["app_id", "param_key", "param_value", "param_type", "param_desc", "param_status"],
  search: ["param_key", "param_desc"],
  filters: ["app_id", "param_type", "param_status"],
  pkGenerator: () => nextSeq("param_id"),
  appField: "app_id",
  onAfterUpdate: async (req, values, id, oldRecord) => invalidateParams((oldRecord && oldRecord.app_id) || req.appId, oldRecord && oldRecord.param_key),
  onAfterDelete: async (req, record) => invalidateParams((record && record.app_id) || req.appId, record && record.param_key),
}));

// ==================== 用户注销管理（t_lp_account_cancellations） ====================
// 家长/个人在小程序发起注销（立即 / 7天冷静期），后台集中查看与管理。
// 只读列表/详情（含账号昵称/角色）+ 管理员可手动撤销待生效申请。
async function attachCancelStaffInfo(rows) {
  const list = rows || [];
  if (list.length === 0) return list;
  const staffIds = [...new Set(list.map(r => r.staff_id).filter(v => v !== undefined && v !== null && v !== ""))];
  const staffMap = {};
  if (staffIds.length > 0) {
    const { data: staffs, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_role")
      .in("staff_id", staffIds).limit(staffIds.length);
    if (!error && Array.isArray(staffs)) staffs.forEach(s => { staffMap[String(s.staff_id)] = s; });
  }
  const openids = [...new Set(list.map(r => r.openid).filter(Boolean))];
  const userMap = {};
  if (openids.length > 0) {
    const { data: users, error } = await db.from("users")
      .select("openid, nickname, avatar")
      .in("openid", openids).limit(openids.length);
    if (!error && Array.isArray(users)) users.forEach(u => { userMap[u.openid] = u; });
  }
  return list.map(r => {
    const s = staffMap[String(r.staff_id)] || {};
    const u = userMap[r.openid] || {};
    return {
      ...r,
      staff_username: s.staff_username || "",
      staff_nickname: s.staff_nickname || "",
      staff_role: s.staff_role || "",
      _userNickname: u.nickname || "",
    };
  });
}

// 只读 + 撤销待生效申请（管理员）
router.use("/api/account_cancellations", adminAuth, crudRouter({
  table: "account_cancellations", pk: "cancel_id",
  search: ["openid"],
  filters: ["status", "mode"],
  appField: "app_id",
  readonly: true,
  enrich: attachCancelStaffInfo,
}));

// ==================== 物理清除审计（t_lp_staff_purges，只读回看每次清除清单） ====================
// 物理清除账号时由 purgeLib.executePurge 写入；本模块仅用于回看删除审计项（目标/范围/逐表计数/媒体/操作人）。
router.use("/api/staff_purges", adminAuth, crudRouter({
  table: "staff_purges", pk: "purge_id",
  search: ["target_username", "target_nickname", "operator_username"],
  filters: ["status", "target_role"],
  appField: "app_id",
  readonly: true,
}));

// 管理员手动撤销待生效的注销申请（等价于小程序端撤销；调用方需已登录后台）
router.post("/api/account_cancellations/revoke", adminAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 cancel_id"));
    const { data: rows, error } = await db.from("account_cancellations")
      .select().eq("cancel_id", Number(id)).limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("注销申请不存在"));
    if (rec.status !== "pending") return res.json(fail("仅待生效的注销申请可撤销"));
    await db.from("account_cancellations")
      .update({ status: "cancelled", cancelled_at: nowSql(), updated_at: nowSql() })
      .eq("cancel_id", Number(id)).eq("status", "pending");
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "撤销注销申请", module: "account_cancellations", apiPath: "/api/account_cancellations/revoke", bizId: id, extra: { staff_id: rec.staff_id, openid: rec.openid } });
    res.json(ok(null, "已撤销该注销申请"));
  } catch (e) {
    console.error("[admin] account_cancellations revoke error", e);
    res.json(fail("服务异常", 500));
  }
});

// 任务打卡：为任务新增一条打卡记录
router.post("/api/tasks/checkin", adminAuth, async (req, res) => {
  try {
    const { taskId, date, note, images, voiceUrl, voiceDuration, videoUrl, videoDuration } = req.body || {};
    if (!taskId) return res.json(fail("缺少任务 ID"));
    const staffId = (req.staff && req.staff.staff_id) || "";

    const { data: rows, error } = await db.from("tasks")
      .select("task_id, title, task_status, checkin_count, checkin_type")
      .eq("task_id", taskId)
      .limit(1);
    if (error) throw error;
    const task = rows && rows[0];
    if (!task) return res.json(fail("任务不存在"));
    // 安全审计 S7：非管理员只能对本家庭可见任务打卡（创建人=本人 或 派发给本人/名下孩子）
    if (!(await canAccessTask(req, taskId))) {
      return res.json(fail("无权操作该任务", 403));
    }
    // 兜底风控：已完成任务仅可查看，学生禁止打卡（管理员不受限）
    if (req.staff && req.staff.role === "student" && task.task_status === "done") {
      return res.json(fail("任务已完成，不能打卡"));
    }
    // 学生可对任意可见任务打卡（单一学生场景，管理员创建的任务也允许学生打卡）

    // 打卡方式强约束：以任务发布的 checkin_type 为准
    const checkinType = normalizeCheckinType(task.checkin_type);
    const vUrl = String(voiceUrl || "").trim().slice(0, 500);
    const vDur = Math.floor(Number(voiceDuration) || 0);
    const vUrl2 = String(videoUrl || "").trim().slice(0, 500);
    const vDur2 = Math.floor(Number(videoDuration) || 0);

    let imgList = [];
    if (checkinType === "voice") {
      // 语音打卡：必须携带已上传的语音文件，禁止图片
      if (!vUrl || !vUrl.startsWith("kxm/voice/")) return res.json(fail("请先录制语音再打卡"));
      if (vDur < 1 || vDur > 60) return res.json(fail("语音时长不合法"));
      if (Array.isArray(images) && images.length > 0) return res.json(fail("语音打卡不支持图片"));
      // 完整性校验：语音文件必须已登记上传（active）且真实存在于云存储
      const { data: vRows } = await db.from("file_uploads").select("file_id").eq("file_path", vUrl).eq("file_status", "active").limit(1);
      const vRec = vRows && vRows[0];
      if (!vRec) return res.json(fail("请先录制语音再打卡"));
      if ((await storageFileExists(vUrl)) === false) return res.json(fail("语音文件不存在，请重新录制"));
    } else if (checkinType === "video") {
      // 视频打卡：必须携带已上传的视频文件（限 1GB），禁止图片
      if (!vUrl2 || !vUrl2.startsWith("kxm/videos/")) return res.json(fail("请先上传视频再打卡"));
      if (vDur2 < 1 || vDur2 > 3600) return res.json(fail("视频时长不合法"));
      if (Array.isArray(images) && images.length > 0) return res.json(fail("视频打卡不支持图片"));
      // 完整性校验：视频必须已登记上传（active）且真实存在于云存储
      const { data: vRows } = await db.from("file_uploads").select("file_id").eq("file_path", vUrl2).eq("file_status", "active").limit(1);
      const vRec = vRows && vRows[0];
      if (!vRec) return res.json(fail("请先上传视频再打卡"));
      if ((await storageFileExists(vUrl2)) === false) return res.json(fail("视频文件不存在，请重新上传"));
    } else {
      imgList = (images || []).slice(0, 9);
      // 图文打卡强约束：必须输入文字 + 至少一张图片（与任务发布的打卡方式一致）
      const noteText = String(note || "").trim();
      if (!noteText) return res.json(fail("图文打卡需输入打卡文字"));
      if (imgList.length < 1) return res.json(fail("图文打卡需至少上传一张图片"));
      // 完整性校验：每张图片必须已登记上传（active）
      const { data: imgRows } = await db.from("file_uploads").select("file_path").eq("file_status", "active").in("file_path", imgList).limit(imgList.length);
      const registered = new Set((imgRows || []).map(r => r.file_path));
      const missing = imgList.filter(p => !registered.has(p));
      if (missing.length > 0) return res.json(fail("图片未上传成功，请重新上传"));
    }

    const checkinDate = date || formatDate(new Date());
    const checkinId = await nextSeq("task_checkin_id");
    // 视频大小复核（登记记录里取；无记录时以路径前缀兜底）
    let videoSize = 0;
    if (checkinType === "video") {
      const { data: vRows } = await db.from("file_uploads").select("file_size").eq("file_path", vUrl2).limit(1);
      const vRec = vRows && vRows[0];
      if (vRec && Number(vRec.file_size) > VIDEO_MAX_SIZE) return res.json(fail("视频不能超过 1GB"));
      videoSize = Number((vRec && vRec.file_size) || 0);
    }
    const { error: insErr } = await db.from("task_checkins").insert({
      checkin_id: checkinId,
      task_id: taskId,
      checkin_date: checkinDate,
      checkin_note: note || "",
      // 图片存 JSON 数组字符串（如 ["a.jpg"]，无图为 []）
      checkin_images: JSON.stringify(imgList),
      checkin_type: checkinType,
      source: "web",
      voice_url: checkinType === "voice" ? vUrl : "",
      voice_duration: checkinType === "voice" ? vDur : 0,
      video_url: checkinType === "video" ? vUrl2 : "",
      video_duration: checkinType === "video" ? vDur2 : 0,
      video_size: checkinType === "video" ? videoSize : 0,
      created_by: staffId,
      created_at: nowSql(),
    });
    if (insErr) throw insErr;

    // 视频打卡：后端后台压缩视频节省云存储空间（异步，压缩/抽帧完成后回写 video_url/video_size/video_cover）
    if (checkinType === "video" && vUrl2) {
      setTimeout(async () => {
        try {
          const r = await compressVideo({ path: vUrl2, duration: vDur2 });
          const upd = { video_size: Number((r && r.size) || 0) };
          if (r && r.path && r.path !== vUrl2) upd.video_url = r.path;
          if (r && r.cover) upd.video_cover = r.cover;
          if (Object.keys(upd).length > 0) {
            await db.from("task_checkins").update(upd).eq("checkin_id", checkinId);
          }
        } catch (e) {
          console.error("[admin] 视频后台压缩失败", vUrl2, e);
        }
      }, 0);
    }

    // 更新任务打卡次数与状态（加锁串行化读改写，防并发丢计数）
    await withLock(`task:count:${taskId}`, async () => {
      const { data: curRows } = await db.from("tasks")
        .select("checkin_count, task_status").eq("task_id", taskId).limit(1);
      const cur = (curRows && curRows[0]) || task;
      const taskValues = {
        checkin_count: (Number(cur.checkin_count) || 0) + 1,
        progress: 50,
        updated_at: nowSql(),
      };
      if (cur.task_status === "todo") taskValues.task_status = "doing";
      await db.from("tasks").update(taskValues).eq("task_id", taskId);
    });

    // 任务时间轴：记录打卡事件（含任务标题快照，任务删除后仍可追溯）
    logTaskEvent({
      taskId, checkinId, bizType: "task_checkin", eventType: "checkin", eventName: "任务打卡",
      summary: `对任务「${taskTitleOf(task)}」打卡（第 ${(task.checkin_count || 0) + 1} 次）`,
      payload: { task_title: task.title, checkin_date: checkinDate, note: note || "", images: imgList, checkin_type: checkinType, voice_url: vUrl, voice_duration: vDur, video_url: vUrl2, video_duration: vDur2 },
      staffId,
    });

    logStaffEvent({ req, staff: req.staff, eventType: "create", eventName: "任务打卡", module: "task_checkins", apiPath: "/api/tasks/checkin", bizId: taskId, extra: { date: checkinDate } });
    res.json(ok(null, "打卡成功"));
  } catch (e) {
    console.error("[admin] tasks checkin error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 学习管理：任务打卡管理 ====================
// 新增打卡走任务管理「打卡」接口（本模块禁止新增）；本模块支持修改/删除。
// 任务状态为已完成（done）时，禁止修改或删除该任务的打卡。
// 以下自定义路由均须先于通用 CRUD 挂载，保证 create/update/delete 走自定义逻辑。
const TASK_CHECKIN_WRITABLE = ["checkin_date", "checkin_note", "checkin_images", "checkin_type", "voice_url", "voice_duration", "video_url", "video_duration", "video_size"];

// 任务已完成则返回 true（打卡禁止修改/删除）
async function isTaskDone(taskId) {
  try {
    const { data: rows } = await db.from("tasks")
      .select("task_status").eq("task_id", taskId).limit(1);
    return !!(rows && rows[0] && rows[0].task_status === "done");
  } catch (_) {
    return false;
  }
}

router.post("/api/task_checkins/create", adminAuth, async (req, res) => {
  res.json(fail("新增打卡请在「任务管理」界面操作"));
});

router.post("/api/task_checkins/update", adminAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const staffId = (req.staff && req.staff.staff_id) || "";
    const isAdmin = req.staff && req.staff.role === "admin";
    let q = db.from("task_checkins").select().eq("checkin_id", Number(id));
    if (!isAdmin) q = q.eq("created_by", staffId);
    const { data: rows, error } = await q.limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("打卡记录不存在"));
    // 兜底风控：已完成任务仅可查看，学生禁止修改打卡（管理员不受限）
    if (!isAdmin && await isTaskDone(rec.task_id)) {
      return res.json(fail("任务已完成，仅可查看，禁止修改打卡"));
    }
    const values = {};
    TASK_CHECKIN_WRITABLE.forEach(k => {
      if (req.body[k] !== undefined && req.body[k] !== null) values[k] = req.body[k];
    });
    if (Object.keys(values).length === 0) return res.json(fail("无有效字段"));
    if (values.checkin_type !== undefined) values.checkin_type = normalizeCheckinType(values.checkin_type);
    if (values.voice_duration !== undefined) values.voice_duration = Math.min(60, Math.max(0, Math.floor(Number(values.voice_duration) || 0)));
    if (values.voice_url !== undefined) values.voice_url = String(values.voice_url || "").trim().slice(0, 500);
    if (values.video_url !== undefined) values.video_url = String(values.video_url || "").trim().slice(0, 500);
    if (values.video_duration !== undefined) values.video_duration = Math.max(0, Math.floor(Number(values.video_duration) || 0));
    if (values.video_size !== undefined) values.video_size = Math.max(0, Math.floor(Number(values.video_size) || 0));
    // 图片写入前统一为 JSON 数组字符串（前端已序列化则原样保留，避免双重编码）
    if (req.body.checkin_images !== undefined && req.body.checkin_images !== null) {
      values.checkin_images = Array.isArray(req.body.checkin_images)
        ? JSON.stringify(req.body.checkin_images.slice(0, 9))
        : req.body.checkin_images;
    }
    await db.from("task_checkins").update(values).eq("checkin_id", Number(id));

    // 任务时间轴：记录修改打卡事件（含旧/新关键值）
    const changed = {};
    TASK_CHECKIN_WRITABLE.forEach(k => {
      if (values[k] !== undefined && String(rec[k] ?? "") !== String(values[k] ?? "")) {
        changed[k] = { from: rec[k], to: values[k] };
      }
    });
    logTaskEvent({
      taskId: rec.task_id, checkinId: rec.checkin_id, bizType: "task_checkin", eventType: "checkin_update", eventName: "修改打卡",
      summary: `修改打卡记录（${rec.checkin_date || ""}）`,
      payload: { checkin_id: rec.checkin_id, checkin_date: values.checkin_date || rec.checkin_date, changed },
      staffId,
    });

    logStaffEvent({ req, staff: req.staff, eventType: "update", eventName: "更新任务打卡", module: "task_checkins", apiPath: "/api/task_checkins/update", bizId: id });
    res.json(ok(null, "更新成功"));
  } catch (e) {
    console.error("[admin] task_checkins update error", e);
    res.json(fail("服务异常", 500));
  }
});

// 删除打卡：任务已完成禁止删除；否则级联扣减任务打卡次数
router.post("/api/task_checkins/delete", adminAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json(fail("缺少 ID"));
    const staffId = (req.staff && req.staff.staff_id) || "";
    const isAdmin = req.staff && req.staff.role === "admin";
    let q = db.from("task_checkins").select().eq("checkin_id", Number(id));
    if (!isAdmin) q = q.eq("created_by", staffId);
    const { data: rows, error } = await q.limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("打卡记录不存在"));
    // 兜底风控：已完成任务仅可查看，学生禁止删除打卡（管理员不受限）
    if (!isAdmin && await isTaskDone(rec.task_id)) {
      return res.json(fail("任务已完成，仅可查看，禁止删除打卡"));
    }
    const { error: delErr } = await db.from("task_checkins").delete().eq("checkin_id", Number(id));
    if (delErr) throw delErr;
    // 积分账本：删除已通过打卡 -10（未通过本就无分，直接忽略）
    deductCheckinDeleted(rec, Number(staffId) || 0).catch(() => {});
    // 级联清理媒体文件（语音/视频/封面：物理删 COS + 登记记录）
    const mediaPaths = [];
    if (rec.voice_url) mediaPaths.push(rec.voice_url);
    if (rec.video_url) mediaPaths.push(rec.video_url);
    if (rec.video_cover) mediaPaths.push(rec.video_cover);
    if (mediaPaths.length > 0) {
      try {
        const { deleted } = await removeFiles(mediaPaths);
        if (deleted.length > 0) {
          await db.from("file_uploads").delete().in("file_path", deleted);
        }
      } catch (_) {}
    }
    // 扣减任务打卡次数（不小于0，加锁串行化防并发竞态）
    await withLock(`task:count:${rec.task_id}`, async () => {
      const { data: tRows, error: tErr } = await db.from("tasks")
        .select("checkin_count").eq("task_id", rec.task_id).limit(1);
      if (!tErr && tRows && tRows[0]) {
        const cnt = Math.max(0, (tRows[0].checkin_count || 0) - 1);
        await db.from("tasks").update({ checkin_count: cnt, updated_at: nowSql() }).eq("task_id", rec.task_id);
      }
    });

    // 任务时间轴：记录删除打卡事件（快照，便于审计追溯）
    let imgCount = 0;
    try { imgCount = (JSON.parse(rec.checkin_images || "[]") || []).length; } catch (_) {}
    logTaskEvent({
      taskId: rec.task_id, checkinId: rec.checkin_id, bizType: "task_checkin", eventType: "checkin_delete", eventName: "删除打卡",
      summary: `删除打卡记录（${rec.checkin_date || ""}）`,
      payload: { checkin_id: rec.checkin_id, checkin_date: rec.checkin_date, note: rec.checkin_note, images_count: imgCount },
      staffId,
    });

    logStaffEvent({ req, staff: req.staff, eventType: "delete", eventName: "删除任务打卡", module: "task_checkins", apiPath: "/api/task_checkins/delete", bizId: id });
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[admin] task_checkins delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// 任务打卡管理（新增走任务「打卡」，修改/删除走上面自定义逻辑；列表附带任务信息）
router.use("/api/task_checkins", adminAuth, crudRouter({
  table: "task_checkins", pk: "checkin_id",
  writable: [],
  search: ["checkin_note"],
  filters: ["checkin_date", "source", "risk_status"],
  scopeFn: taskScope,
  readScopeFn: () => null,
  readonly: true,
  // 安全审计 S6：非管理员按家庭可见任务收敛打卡（杜绝跨家庭读取打卡内容/媒体）
  extraFilter: async (req, q) => {
    const famIds = await familyTaskIds(req);
    if (!Array.isArray(famIds)) return { q };
    if (famIds.length === 0) return { q: q.eq("checkin_id", -1) };
    return { q: q.in("task_id", famIds) };
  },
  enrich: async (rows) => {
    const ids = [...new Set((rows || []).map(r => r.task_id).filter(Boolean))];
    if (ids.length === 0) return rows || [];
    const { data: tasks, error } = await db.from("tasks")
      .select("task_id, title, task_status, progress").in("task_id", ids).limit(ids.length);
    const taskMap = {};
    if (!error && Array.isArray(tasks)) tasks.forEach(t => { taskMap[t.task_id] = t; });
    const rowsWithTask = (rows || []).map(r => {
      const t = taskMap[r.task_id] || {};
      return {
        ...r,
        task_title: t.title || "",
        task_status: t.task_status || "",
        task_progress: Number(t.progress) >= 0 ? Number(t.progress) : (t.task_status === "done" ? 100 : t.task_status === "doing" ? 50 : 1),
      };
    });
    return attachStaffInfo(rowsWithTask);
  },
}));

// ==================== 学习管理：待办任务（学生卡片视图数据源） ====================
// 学生：展示「派发给我 / 我创建」且未完成（todo/doing）的任务；
// 管理员：展示全部未完成任务（便于总览推进进度）。
// 权限：todo_tasks 菜单已对学生/管理员授权；列表仅返回任务基础字段 + 卡片展示所需关联信息。
/** 学生可见任务 ID 集合：派发给我 + 我创建（与小程序端 myTaskIds 逻辑一致） */
async function todoTaskIds(staffId) {
  const set = new Set();
  const [assignR, ownR] = await Promise.all([
    db.from("task_assignees").select("task_id").eq("staff_id", staffId).limit(5000),
    db.from("tasks").select("task_id").eq("created_by", staffId).limit(5000),
  ]);
  (assignR.data || []).forEach(a => set.add(String(a.task_id)));
  (ownR.data || []).forEach(t => set.add(String(t.task_id)));
  return [...set].map(x => Number(x));
}

router.get("/api/todo_tasks/list", adminAuth, async (req, res) => {
  try {
    const staffId = (req.staff && req.staff.staff_id) || "";
    const isAdmin = req.staff && req.staff.role === "admin";

    let all = [];
    if (isAdmin) {
      const { data: rows, error } = await db.from("tasks")
        .select().in("task_status", ["todo", "doing"]).order("updated_at", { ascending: false }).limit(200);
      if (error) throw error;
      all = rows || [];
    } else {
      const ids = await todoTaskIds(staffId);
      if (ids.length === 0) return res.json(ok({ list: [], count: 0 }));
      const { data: rows, error } = await db.from("tasks")
        .select().in("task_id", ids).order("updated_at", { ascending: false }).limit(200);
      if (error) throw error;
      // 待办 = 未完成的任务（待完成 todo / 进行中 doing），已完成的不展示
      all = (rows || []).filter(t => t.task_status === "todo" || t.task_status === "doing");
    }

    // 附加合集名称 / 创建人 / 派发学生（与任务管理卡片页一致）
    if (all.length > 0) {
      const [withCol, withStaff, withAsg] = await Promise.all([
        attachCollectionName(all),
        attachStaffInfo(all),
        attachAssignees(all),
      ]);
      all = all.map((t, i) => ({ ...t, ...(withCol[i] || {}), ...(withStaff[i] || {}), ...(withAsg[i] || {}) }));
    }

    res.json(ok({
      count: all.length,
      list: all.map(t => ({
        task_id: t.task_id,
        title: t.title,
        subject: t.subject,
        tags: parseImgList(t.tags),
        description: t.description,
        task_link: t.task_link,
        images: parseImgList(t.images),
        task_status: t.task_status,
        progress: Number(t.progress) >= 0 ? Number(t.progress) : (t.task_status === "done" ? 100 : t.task_status === "doing" ? 50 : 1),
        checkin_type: normalizeCheckinType(t.checkin_type),
        source: normalizeTaskSource(t.source),
        risk_status: t.risk_status || "pending",
        score: t.score,
        deadline: t.deadline,
        start_date: t.start_date,
        collection_id: t.collection_id,
        collection_name: t.collection_name || "",
        checkin_count: t.checkin_count || 0,
        created_by: t.created_by,
        _creatorNickname: t._creatorNickname || "",
        _creatorUsername: t._creatorUsername || "",
        assignee_names: t.assignee_names || [],
        created_at: t.created_at,
        updated_at: t.updated_at,
      })),
    }));
  } catch (e) {
    console.error("[admin] todo_tasks list error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 学习管理：打卡审核（管理员审核学生打卡） ====================
// 待办任务里学生提交打卡后进入待审核（pending）；管理员在此通过/驳回，流程与小程序端一致：
// 通过 = 任务完成 + 10 分 + 关闭同任务其余待审核打卡；驳回 = 填评分与原因，任务回退继续处理。
// 权限：仅管理员（student 未授权 checkin_reviews 菜单，接口层再兜底校验）。

/** 待审核打卡附加学生与任务信息 */
async function attachReviewInfo(rows) {
  const list = rows || [];
  if (list.length === 0) return list;
  const taskIds = [...new Set(list.map(c => Number(c.task_id)).filter(Boolean))];
  const staffIds = [...new Set(list.map(c => Number(c.created_by)).filter(Boolean))];
  const [tasksR, staffMap] = await Promise.all([
    taskIds.length > 0
      ? db.from("tasks").select("task_id, title, subject, task_status, progress").in("task_id", taskIds).limit(taskIds.length)
      : Promise.resolve({ data: [], error: null }),
    cachedStaffRows(staffIds),
  ]);
  const taskMap = {};
  (tasksR.data || []).forEach(t => { taskMap[Number(t.task_id)] = t; });
  return list
    .filter(c => taskMap[Number(c.task_id)]) // 任务已删除的打卡不展示
    .map(c => {
      const s = staffMap[String(c.created_by)] || {};
      const t = taskMap[Number(c.task_id)] || {};
      return {
        checkin_id: c.checkin_id,
        task_id: c.task_id,
        task_title: t.title || "(任务已删除)",
        task_subject: t.subject || "",
        task_status: t.task_status || "",
        task_progress: Number(t.progress) >= 0 ? Number(t.progress) : (t.task_status === "done" ? 100 : t.task_status === "doing" ? 50 : 1),
        student: {
          staff_id: String(c.created_by),
          nickname: s.staff_nickname || s.staff_username || "学生",
          username: s.staff_username || "",
        },
        checkin_date: c.checkin_date,
        checkin_note: c.checkin_note,
        risk_status: c.risk_status || "pending",
        images: parseImgList(c.checkin_images),
        checkin_type: normalizeCheckinType(c.checkin_type),
        source: normalizeTaskSource(c.source, "miniprogram"),
        voice_url: c.voice_url || "",
        voice_duration: Number(c.voice_duration) || 0,
        video_url: c.video_url || "",
        video_duration: Number(c.video_duration) || 0,
        video_size: Number(c.video_size) || 0,
        video_cover: c.video_cover || "",
        created_at: c.created_at,
      };
    });
}

// 待审核打卡列表（默认最近 200 条，按提交时间倒序）
router.get("/api/checkin_reviews/list", adminAuth, async (req, res) => {
  try {
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("无权操作", 403));
    const { data: rows, error } = await db.from("task_checkins")
      .select("checkin_id, task_id, created_by, checkin_date, checkin_note, checkin_images, checkin_type, source, voice_url, voice_duration, video_url, video_duration, video_size, video_cover, risk_status, created_at")
      .eq("review_status", "pending").order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    // 内容安全拦截的记录不进待审核队列（无法审核通过）
    const list = await attachReviewInfo((rows || []).filter(c => c.risk_status !== "reject"));
    res.json(ok({ count: list.length, list }));
  } catch (e) {
    console.error("[admin] checkin_reviews list error", e);
    res.json(fail("服务异常", 500));
  }
});

// 审核打卡（通过/驳回），完成后给打卡提交学生发送订阅消息「审核结果通知」
async function notifyAdminReview(req, checkin, task, result, note) {
  try {
    // 多身份（共用微信）：该学生所有有效绑定 openid（家长手机 + 孩子手机）都通知
    const { data: stuRows } = await db.from("lp_students")
      .select("openid").eq("staff_id", checkin.created_by).eq("app_id", req.appId || "miniprogram-kxm")
      .eq("bound_status", 1).limit(50);
    const openids = [...new Set((stuRows || []).map(r => r.openid).filter(Boolean))];
    for (const openid of openids) {
      await sendReviewNotification({
        appId: req.appId || "miniprogram-kxm",
        openid,
        staffId: checkin.created_by,
        checkinId: checkin.checkin_id,
        taskId: checkin.task_id,
        taskTitle: (task && task.title) || "",
        result,
        note,
      });
    }
  } catch (e) {
    console.error("[admin] notify review error", e);
  }
}

router.post("/api/checkin_reviews/review", adminAuth, async (req, res) => {
  try {
    if ((req.staff && req.staff.role) !== "admin") return res.json(fail("无权操作", 403));
    const staffId = Number((req.staff && req.staff.staff_id) || "");
    const { checkinId, action, score, note } = req.body || {};
    const cid = Number(checkinId);
    if (!cid) return res.json(fail("缺少打卡 ID"));
    const act = String(action || "");
    if (!["approve", "reject"].includes(act)) return res.json(fail("无效的审核操作"));

    const { data: rows, error } = await db.from("task_checkins").select().eq("checkin_id", cid).limit(1);
    if (error) throw error;
    const checkin = rows && rows[0];
    if (!checkin) return res.json(fail("打卡记录不存在"));
    if (checkin.review_status === "approved") return res.json(fail("该打卡已审核通过"));
    if (checkin.review_status === "rejected") return res.json(fail("该打卡已审核驳回"));
    // 内容安全拦截：违规内容禁止审核通过（可驳回）
    if (act === "approve" && checkin.risk_status === "reject") {
      return res.json(fail("该打卡内容未通过安全检测，禁止审核通过"));
    }

    const { data: tRows } = await db.from("tasks")
      .select("task_id, title, task_status").eq("task_id", checkin.task_id).limit(1);
    const task = tRows && tRows[0];

    if (act === "approve") {
      // 审核通过 = 该学生打卡通过 +10 分；任务是否完成由「全部参与人是否都已通过」判定（按孩子独立完成）
      await db.from("task_checkins").update({
        review_status: "approved",
        review_score: 10,
        review_note: "",
        reviewer: staffId,
        reviewed_at: nowSql(),
      }).eq("checkin_id", cid);
      // 同任务同学生的其余待审核打卡自动关闭（该学生任务已完成，重复提交不再处理）；
      // 其他孩子的打卡保留待审，各自独立审核，不再一并关闭
      const { data: pendRows } = await db.from("task_checkins")
        .select("checkin_id").eq("task_id", checkin.task_id).eq("created_by", checkin.created_by).eq("review_status", "pending").limit(200);
      const pendIds = (pendRows || []).map(p => p.checkin_id).filter(id => Number(id) !== Number(cid));
      if (pendIds.length > 0) {
        await db.from("task_checkins").update({
          review_status: "rejected",
          review_note: "该学生本任务已审核通过，本条重复打卡不再处理",
          reviewer: staffId,
          reviewed_at: nowSql(),
        }).in("checkin_id", pendIds);
      }
      // 任务完成态：全部参与人（派发孩子/创建人）都已通过 → 任务完成；否则保持进行中
      const allDone = await taskAllRecipientsDone(checkin.task_id);
      const oldStatus = task ? task.task_status : "";
      let finalStatus = oldStatus;
      if (allDone) {
        if (oldStatus !== "done") {
          await db.from("tasks").update({ task_status: "done", progress: 100, score: 10, updated_at: nowSql() })
            .eq("task_id", checkin.task_id);
          finalStatus = "done";
        }
        // 积分账本：打卡审核通过 +10；任务全部完成 +30（幂等：按状态变迁判定）
        awardCheckinApproved(checkin, staffId).catch(() => {});
        if (task) applyTaskStatusPoints(task, oldStatus, "done", staffId).catch(() => {});
      } else {
        if (oldStatus === "todo") {
          await db.from("tasks").update({ task_status: "doing", progress: 50, updated_at: nowSql() })
            .eq("task_id", checkin.task_id);
          finalStatus = "doing";
        }
        // 打卡审核通过 +10（任务未完成，暂不加任务完成分）
        awardCheckinApproved(checkin, staffId).catch(() => {});
      }
      logTaskEvent({
        taskId: checkin.task_id, checkinId: cid, bizType: "task_checkin", eventType: "review_approve",
        eventName: "审核通过",
        summary: allDone
          ? `后台管理员审核通过打卡，任务「${task ? task.title : ""}」全部完成并得 10 分`
          : `后台管理员审核通过打卡「${task ? task.title : ""}」+10 分，等待其他孩子完成`,
        payload: { checkin_id: cid, task_status: finalStatus, score: 10, closed_pending: pendIds.length },
        staffId,
      });
      logStaffEvent({ req, staff: req.staff, eventType: "review", eventName: `审核通过打卡（+10分${allDone ? "，任务完成" : "，任务未完成"}）`, module: "checkin_reviews", apiPath: "/api/checkin_reviews/review", bizId: cid, extra: { task_id: checkin.task_id, task_status: finalStatus } });
      notifyAdminReview(req, checkin, task, "approve", "").catch(() => {});
      // 系统通知：审核通过 → 提交学生 + 家长/家属（审核人自己除外，站内信与订阅消息隔离）
      notifyReviewResult({
        appId: req.appId || "miniprogram-kxm",
        studentStaffId: checkin.created_by,
        taskTitle: (task && task.title) || "",
        score: 10,
        note: "",
        result: "approve",
        checkinId: checkin.checkin_id,
        actorStaffId: staffId,
      }).catch(() => {});
      res.json(ok(null, allDone ? "已通过，任务完成 +10 分" : "已通过 +10 分"));
    } else {
      let s = Number(score);
      if (!Number.isFinite(s)) s = 0;
      s = Math.max(0, Math.min(10, Math.floor(s)));
      await db.from("task_checkins").update({
        review_status: "rejected",
        review_score: s,
        review_note: String(note || "").slice(0, 500),
        reviewer: staffId,
        reviewed_at: nowSql(),
      }).eq("checkin_id", cid);
      // 兜底：若任务显示已完成但实际仍有未完成孩子（旧数据/异常态），驳回后回退为进行中
      if (task && task.task_status === "done") {
        const stillDone = await taskAllRecipientsDone(checkin.task_id);
        if (!stillDone) {
          await db.from("tasks").update({ task_status: "doing", progress: 50, updated_at: nowSql() })
            .eq("task_id", task.task_id);
          // 积分账本：已完成任务回退 -30（收款人与加分方一致）
          applyTaskStatusPoints(task, "done", "doing", staffId).catch(() => {});
        }
      }
      logTaskEvent({
        taskId: checkin.task_id, checkinId: cid, bizType: "task_checkin", eventType: "review_reject",
        eventName: "审核驳回",
        summary: `后台管理员驳回打卡「${task ? task.title : ""}」`,
        payload: { checkin_id: cid, score: s, note: String(note || "") },
        staffId,
      });
      logStaffEvent({ req, staff: req.staff, eventType: "review", eventName: `审核驳回打卡`, module: "checkin_reviews", apiPath: "/api/checkin_reviews/review", bizId: cid, extra: { task_id: checkin.task_id, score: s } });
      notifyAdminReview(req, checkin, task, "reject", note).catch(() => {});
      // 系统通知：审核驳回 → 提交学生 + 家长/家属（审核人自己除外，站内信与订阅消息隔离）
      notifyReviewResult({
        appId: req.appId || "miniprogram-kxm",
        studentStaffId: checkin.created_by,
        taskTitle: (task && task.title) || "",
        score: s,
        note: String(note || ""),
        result: "reject",
        checkinId: checkin.checkin_id,
        actorStaffId: staffId,
      }).catch(() => {});
      res.json(ok(null, "已驳回"));
    }
  } catch (e) {
    console.error("[admin] checkin_reviews review error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 订阅消息管理：订阅授权记录 / 消息发送记录（只读 + 后台赠送） ====================
// 数据来源：小程序端用户主动订阅（t_lp_subscribe_grants）、业务事件自动发送（t_lp_subscribe_sends）
// 权限：仅管理员可查看与后台赠送；按 app 维度隔离（app_id 列）
// 后台赠送：给指定学生增加订阅次数（tmpl_id 为空=通用次数，后续任意模板通知均可消耗）
router.post("/api/subscribe_grants/grant", adminAuth, async (req, res) => {
  try {
    if (!req.staff || req.staff.role !== "admin") return res.json(fail("仅管理员可赠送订阅次数", 403));
    const { staffId, tmplId, count, remark } = req.body || {};
    const sid = Number(staffId);
    if (!sid) return res.json(fail("缺少学生账号 ID"));
    const cnt = Number(count);
    if (!Number.isFinite(cnt) || cnt < 1 || cnt > 100) return res.json(fail("赠送次数需在 1-100 之间"));
    const { data: sRows, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_role").eq("staff_id", sid).limit(1);
    if (error) throw error;
    const stu = sRows && sRows[0];
    if (!stu || stu.staff_role !== "student") return res.json(fail("学生账号不存在"));
    const gid = await nextSeq("subscribe_grant_id");
    await db.from("subscribe_grants").insert({
      grant_id: gid,
      staff_id: sid,
      openid: "",
      app_id: req.appId || "miniprogram-kxm",
      tmpl_id: String(tmplId || "").slice(0, 64),
      grant_count: cnt,
      used_count: 0,
      grant_status: "active",
      source: "backoffice",
      remark: String(remark || "后台赠送").slice(0, 255),
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    logStaffEvent({ req, staff: req.staff, eventType: "create", eventName: "后台赠送订阅次数", module: "subscribe_grants", apiPath: "/api/subscribe_grants/grant", bizId: gid, extra: { staff_id: sid, tmpl_id: tmplId, count: cnt } });
    res.json(ok({ grant_id: gid }, `已赠送 ${cnt} 次`));
  } catch (e) {
    console.error("[admin] subscribe_grants grant error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 订阅记录附加接收人昵称（staff_id → 昵称） */
const attachRecipient = async (rows) => {
  const ids = [...new Set((rows || []).map(r => r.staff_id).filter(Boolean))];
  if (ids.length === 0) return rows || [];
  const { data: staff, error } = await db.from("staff")
    .select("staff_id, staff_username, staff_nickname").in("staff_id", ids).limit(ids.length);
  const map = {};
  if (!error && Array.isArray(staff)) staff.forEach(s => { map[String(s.staff_id)] = s; });
  return (rows || []).map(r => {
    const s = map[String(r.staff_id)] || {};
    return { ...r, _recipientNickname: s.staff_nickname || s.staff_username || "" };
  });
};

router.use("/api/subscribe_grants", adminAuth, crudRouter({
  table: "subscribe_grants", pk: "grant_id",
  writable: [],
  search: ["openid"],
  readonly: true,
  appField: "app_id",
  filters: ["grant_status", "source", "tmpl_id"],
  orderField: "created_at",
  enrich: attachRecipient,
}));

router.use("/api/subscribe_sends", adminAuth, crudRouter({
  table: "subscribe_sends", pk: "send_id",
  writable: [],
  search: ["openid"],
  readonly: true,
  appField: "app_id",
  filters: ["send_status", "event_type", "tmpl_id"],
  orderField: "created_at",
  enrich: attachRecipient,
}));

// ==================== 系统通知：通知模板（后台「消息通知 → 通知模板」） ====================
// 站内信模板（与订阅消息模板完全隔离）：类型(code) × 目标角色(target_role) 各自维护标题/正文模板，
// 支持占位符 {xxx}（{taskTitle}/{childName}/{studentName}/{score}/{note}/{checkinDate}/{assignerName}/{bizName}）。
// 仅管理员可新增/编辑/删除（家长/家属/学生即使被授予菜单也只读）。
const NOTIFY_ROLE_WHITELIST = ["student", "parent", "family"];
function normalizeNotifyTemplateValues(values, oldRecord) {
  const v = { ...values };
  if (v.code !== undefined) v.code = String(v.code).trim().slice(0, 64);
  if (v.name !== undefined) v.name = String(v.name).trim().slice(0, 64);
  if (v.target_role !== undefined) v.target_role = String(v.target_role).trim().toLowerCase();
  if (v.title_tmpl !== undefined) v.title_tmpl = String(v.title_tmpl).slice(0, 128);
  if (v.content_tmpl !== undefined) v.content_tmpl = String(v.content_tmpl).slice(0, 500);
  if (v.enabled !== undefined) v.enabled = Number(v.enabled) === 1 ? 1 : 0;
  if (v.sort !== undefined) v.sort = Math.floor(Number(v.sort) || 0);
  return v;
}
router.use("/api/notify_templates", adminAuth, crudRouter({
  table: "notify_templates", pk: "template_id",
  writable: ["code", "name", "target_role", "title_tmpl", "content_tmpl", "enabled", "sort"],
  search: ["name", "code"],
  filters: ["code", "target_role", "enabled"],
  appField: "app_id",
  pkGenerator: () => nextSeq("template_id"),
  defaults: (req) => ({ app_id: req.appId || "miniprogram-kxm", enabled: 1, sort: 0 }),
  onBeforeCreate: async (req, values) => {
    if ((req.staff && req.staff.role) !== "admin") return "仅管理员可维护通知模板";
    Object.assign(values, normalizeNotifyTemplateValues(values, null));
    if (!values.code || !values.name || !values.target_role) return "请填写完整的类型、名称与目标角色";
    if (!NOTIFY_ROLE_WHITELIST.includes(values.target_role)) return "目标角色无效（student 学生 / parent 主家长 / family 家属）";
    return null;
  },
  onBeforeUpdate: async (req, oldRecord, values) => {
    if ((req.staff && req.staff.role) !== "admin") return "仅管理员可维护通知模板";
    Object.assign(values, normalizeNotifyTemplateValues(values, oldRecord));
    const role = values.target_role !== undefined ? values.target_role : (oldRecord && oldRecord.target_role);
    if (role && !NOTIFY_ROLE_WHITELIST.includes(role)) return "目标角色无效（student 学生 / parent 主家长 / family 家属）";
    return null;
  },
  onBeforeDelete: async (req, record) => {
    if ((req.staff && req.staff.role) !== "admin") return "仅管理员可维护通知模板";
    return null;
  },
}));

// ==================== 系统通知：发送记录（后台「消息通知 → 系统通知」，只读审计） ====================
// 站内信发送记录：谁、何时、收到什么通知、是否已读。按 app 维度隔离。
router.use("/api/notifications", adminAuth, crudRouter({
  table: "notifications", pk: "notify_id",
  writable: [],
  search: ["title", "content"],
  filters: ["type", "role", "is_read"],
  readonly: true,
  appField: "app_id",
  orderField: "created_at",
  enrich: attachRecipient,
}));

// ==================== 后台上传（学习模块等使用，base64；支持图片与语音 biz=voice） ====================
router.post("/api/upload", adminAuth, async (req, res) => {
  try {
    const { biz, file } = req.body || {};
    if (!biz) return res.json(fail("缺少业务类型 biz"));
    if (!file) return res.json(fail("缺少文件数据"));
    // 视频体积大，走小程序 wx.cloud.uploadFile 直传，不接 base64
    if (String(biz) === "videos") return res.json(fail("视频请通过小程序直传上传"));
    let b64 = String(file);
    let contentType = "image/jpeg";
    const mimeMatch = b64.match(/^data:([^;]+);base64,(.*)$/s);
    if (mimeMatch) {
      contentType = mimeMatch[1] || contentType;
      b64 = mimeMatch[2];
    }
    const isVoice = String(biz) === "voice";
    if (isVoice) {
      if (!/^audio\//i.test(contentType)) contentType = "audio/mpeg";
    } else if (/image\/png/i.test(contentType)) contentType = "image/png";
    else if (/image\/webp/i.test(contentType)) contentType = "image/webp";
    else contentType = "image/jpeg";

    const buffer = Buffer.from(b64, "base64");
    const fileObj = await uploadImage({ biz, buffer, contentType, compress: !isVoice });
    // 后台上传归属当前登录员工（staff_id，如 9001）
    await logUpload({ openid: "", biz, file: fileObj, staffId: String((req.staff && req.staff.staff_id) || "") });
    logStaffEvent({ req, staff: req.staff, eventType: "custom", eventName: "上传文件", module: "upload", apiPath: "/api/upload", extra: { biz } });
    res.json(ok({ path: fileObj.path, url: fileObj.url }, "上传成功"));
  } catch (e) {
    console.error("[admin] upload error", e);
    res.json(fail(e.message || "上传失败", 500));
  }
});

// ==================== 监控类仪表盘（需登录，完整丰富） ====================
router.get("/dashboard/monitor", adminAuth, async (req, res) => {
  try {
    // 最近监控数据（service_monitor 最近 100 条）+ 接口链路统计（api_trace 最近 500 条）并行取回
    const [mRes, tRes] = await Promise.all([
      db.from("service_monitor").select().order("created_at", { ascending: false }).limit(100),
      db.from("api_trace").select("server_cost_ms, trace_status, created_at, api_path").order("created_at", { ascending: false }).limit(500),
    ]);
    if (mRes.error) throw mRes.error;
    if (tRes.error) throw tRes.error;
    const monitors = mRes.data || [];
    const traces = tRes.data || [];
    const traceList = traces;
    const totalReq = traceList.length;
    const errCount = traceList.filter(t => t.trace_status !== "complete" || t.server_cost_ms > 1000).length;
    const avgCost = totalReq > 0
      ? Math.round(traceList.reduce((s, t) => s + (t.server_cost_ms || 0), 0) / totalReq)
      : 0;
    const slowCount = traceList.filter(t => t.server_cost_ms > 350).length;

    // 响应时间趋势：按分钟聚合平均耗时 + 请求量（倒序 → 正序）
    const minuteMap = {};
    traceList.forEach(t => {
      const key = String(t.created_at || "").slice(0, 16);
      if (!key) return;
      minuteMap[key] = minuteMap[key] || { count: 0, total: 0 };
      minuteMap[key].count++;
      minuteMap[key].total += (t.server_cost_ms || 0);
    });
    const respTrend = Object.keys(minuteMap)
      .sort()
      .map(key => ({
        time: key,
        avgMs: Math.round(minuteMap[key].total / minuteMap[key].count),
        count: minuteMap[key].count,
      }));

    // 最近 100 条监控趋势点（倒序 → 正序），全量指标
    const monitorTrend = (monitors || []).slice().reverse().map(m => ({
      time: m.created_at,
      cpu: m.cpu_percent,
      rss: m.rss_mb,
      heap: m.heap_used_mb,
      heapTotal: m.heap_total_mb,
      external: m.external_mb,
      handles: m.active_handles,
      reqs: m.active_reqs,
      uptime: m.uptime_min,
      memTotal: m.mem_total_mb,
      cpuCores: m.cpu_cores,
    }));

    // 最新一次采集作为实例概览
    const latest = (monitors && monitors[0]) || null;
    const instanceInfo = latest ? {
      instance_id: latest.instance_id,
      env_id: latest.env_id,
      instance_spec: latest.instance_spec,
      cpu_cores: latest.cpu_cores,
      mem_total_mb: latest.mem_total_mb,
      internal_ip: latest.internal_ip,
      zone_id: latest.zone_id,
      cluster_id: latest.cluster_id,
      node_version: latest.node_version,
      uptime_min: latest.uptime_min,
      collected_at: latest.created_at,
    } : null;

    res.json(ok({
      trace: { totalReq, errCount, avgCost, slowCount },
      respTrend,
      monitorTrend,
      instanceInfo,
    }));
  } catch (e) {
    console.error("[admin] monitor dashboard error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 学习仪表盘（学生向：游戏化等级/徽章/连击 + 任务/打卡统计） ====================
// 说明：
// - 面向学生角色，突出游戏化等级体验（经验值/等级/连续打卡/成就徽章），激励学生坚持打卡；
// - 统计口径：已删除任务的打卡（孤儿打卡）一律剔除，不进入任何统计与列表，保证「已删除任务/打卡不统计到仪表盘」。
// 等级配置：经验值 = 积分账本余额（打卡审核通过 +10、完成任务 +30；删除已通过打卡 -10、任务回退 -30、删除任务回扣，见 learningLib 积分账本）
const LEARNING_LEVELS = [
  { level: 1, xp: 0, title: "学习新手" },
  { level: 2, xp: 100, title: "初学乍练" },
  { level: 3, xp: 250, title: "渐入佳境" },
  { level: 4, xp: 450, title: "小有所成" },
  { level: 5, xp: 700, title: "学有所得" },
  { level: 6, xp: 1000, title: "游刃有余" },
  { level: 7, xp: 1400, title: "融会贯通" },
  { level: 8, xp: 1900, title: "博学多才" },
  { level: 9, xp: 2500, title: "学富五车" },
  { level: 10, xp: 3200, title: "一代学霸" },
];

/** 由累计 XP 推导等级与升级进度（满级封顶） */
function levelFromXp(xp) {
  let current = LEARNING_LEVELS[0];
  let next = null;
  for (let i = LEARNING_LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEARNING_LEVELS[i].xp) {
      current = LEARNING_LEVELS[i];
      next = LEARNING_LEVELS[i + 1] || null;
      break;
    }
  }
  const span = next ? next.xp - current.xp : 0;
  const progress = next ? Math.min(100, Math.floor(((xp - current.xp) / span) * 100)) : 100;
  return {
    level: current.level,
    title: current.title,
    xp,
    xpInLevel: xp - current.xp,
    xpToNext: next ? next.xp - xp : 0,
    progress,
    maxLevel: !next,
  };
}

/** 以某天为终点向前计算连续打卡天数（含终点当天） */
function streakEndingAt(dateSet, endDate) {
  let streak = 0;
  const cursor = new Date(endDate);
  while (dateSet.has(formatDate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** 历史最长连续打卡天数 */
function maxStreakOf(dateSet) {
  const dates = [...dateSet].sort();
  let max = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    const t = new Date(`${d}T00:00:00`).getTime();
    if (prev !== null && t - prev === 86400000) run += 1;
    else run = 1;
    if (run > max) max = run;
    prev = t;
  }
  return max;
}

/**
 * 学习仪表盘：打卡/进度提醒文案生成（后端独立生成，基于数据分析做分级与针对性文案）
 * 优先级：逾期任务(0) > 今日未打卡+进度严重偏低(1) > 今日未打卡(2) > 进度严重偏低(1)/进度偏低(3) > 临期任务(4) > 全部正常(9)
 * severity：danger=红系 / warning=橙系 / info=蓝系 / success=绿系
 */
function buildLearningReminders({
  todayCheckedIn, todayCheckins, currentStreak,
  completionRate, doneCount, totalTasks, remainingCount, activeCount,
  overdueCount, dueSoonCount, nextBadge,
}) {
  const reminders = [];
  const hasTasks = totalTasks > 0;
  const severeCompletion = hasTasks && completionRate < 30;
  const lowCompletion = hasTasks && completionRate < 50;

  // —— 逾期任务（最高优先级 · 危险） ——
  if (overdueCount > 0) {
    reminders.push({
      type: "banner",
      severity: "danger",
      priority: 0,
      icon: "overdue",
      title: `有 ${overdueCount} 个任务已逾期`,
      desc: overdueCount === 1
        ? "有 1 个任务已错过截止日期，建议今天优先补齐，避免进度堆积。"
        : `有 ${overdueCount} 个任务已错过截止日期，建议先集中处理逾期任务，再推进新进度。`,
    });
  }

  // —— 今日未打卡（1 行 3 列 · 3 组提示文案） ——
  if (!todayCheckedIn) {
    const sev = severeCompletion ? "danger" : "warning";
    reminders.push({
      type: "checkin",
      severity: sev,
      priority: severeCompletion ? 1 : 2,
      title: "今日还没打卡",
      desc: nextBadge ? `打卡可累积经验值，距离「${nextBadge.name}」成就更近一步` : "打卡累积经验值，坚持就是胜利",
      cards: [
        {
          key: "checkin",
          title: "今日打卡",
          desc: todayCheckins === 0
            ? "今日还没打卡，完成任务后记得打卡，+10 经验"
            : `今日已打卡 ${todayCheckins} 次，再打卡还能继续累积经验`,
        },
        {
          key: "streak",
          title: "保持连击",
          desc: currentStreak > 0
            ? `已连续打卡 ${currentStreak} 天，今天打卡即可保持连击不断`
            : "从今天开始建立连击，打卡即可开启连击之旅",
        },
        {
          key: "task",
          title: "待办任务",
          desc: remainingCount === 0
            ? "今日任务已全部完成，打个卡收个尾吧"
            : `还有 ${remainingCount} 个任务待完成${activeCount > 0 ? `，其中 ${activeCount} 个进行中` : ""}${overdueCount > 0 ? `，另有 ${overdueCount} 个已逾期` : ""}`,
        },
      ],
    });
  }

  // —— 任务完成进度偏低 ——
  if (lowCompletion) {
    const sev = severeCompletion ? "danger" : "warning";
    reminders.push({
      type: "banner",
      severity: sev,
      priority: severeCompletion ? (todayCheckedIn ? 1 : 3) : 3,
      icon: "percent",
      title: severeCompletion ? "任务完成进度严重偏低" : "任务完成进度偏低",
      desc: `已完成 ${doneCount}/${totalTasks} 个任务，完成率 ${completionRate}%。${activeCount > 0 ? `还有 ${activeCount} 个任务正在推进，` : ""}继续加油！`,
    });
  }

  // —— 临期任务（未来 3 天内到期且待完成，无逾期时提示） ——
  if (dueSoonCount > 0 && !(overdueCount > 0)) {
    reminders.push({
      type: "banner",
      severity: "info",
      priority: 4,
      icon: "deadline",
      title: `${dueSoonCount} 个任务即将到期`,
      desc: "未来 3 天内有任务将到截止日期，建议提前安排时间完成，避免逾期。",
    });
  }

  // —— 无任何异常：完成态（绿色） ——
  if (reminders.length === 0) {
    reminders.push({
      type: "allgood",
      severity: "success",
      priority: 9,
      icon: "success",
      title: "今日状态完美，太棒了！",
      desc: nextBadge
        ? `今日已打卡，连击保持中，距离解锁「${nextBadge.name}」越来越近啦！`
        : "今日已打卡，任务完成率亮眼，继续保持！",
    });
  }

  reminders.sort((a, b) => a.priority - b.priority);
  return reminders;
}

// ==================== 学习仪表盘（Web 后台） ====================
// 视角解析：管理员默认第一个学生、可切换到任意单个学生；
//          家长/家属默认第一个孩子、仅能切换名下孩子；学生固定本人。
// 返回：{ staff, role, students(可切换列表), target(目标学生记录|null=全部), scope(家长孩子staff_id数组) }
async function resolveLearningView(req) {
  const staff = req.staff || {};
  const role = staff.role || "";
  const staffId = String(staff.staff_id || "");
  const qsid = String((req.query && req.query.studentId) || "").trim();

  let students = [];
  let scope = null; // null = admin 全部
  const pick = (rows) => (rows || []).filter(Boolean)
    .map(s => ({ staff_id: String(s.staff_id), nickname: s.staff_nickname || s.staff_username || "学生", username: s.staff_username || "" }));

  if (role === "admin") {
    // 管理员默认第一个学生视角（按 staff_id 升序），可切换到任意单个学生（学生账号为 role=student 的员工）
    const { data, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_status")
      .eq("staff_role", "student")
      .eq("staff_status", 1)
      .order("staff_id", { ascending: true })
      .limit(5000);
    if (!error) students = pick(data);
  } else if (role === "parent" || role === "family") {
    let famIds = [];
    try { famIds = await familyScope(staffId, role); } catch (_) {}
    scope = famIds.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (scope.length > 0) {
      const { data, error } = await db.from("staff")
        .select("staff_id, staff_username, staff_nickname, staff_status")
        .in("staff_id", scope).limit(scope.length);
      if (!error) students = pick(data);
    }
  } else {
    // 学生本人
    const { data, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_status")
      .eq("staff_id", Number(staffId)).limit(1);
    if (!error) students = pick(data);
    scope = [Number(staffId)];
  }

  // 目标学生：优先 query.studentId（须在可切换范围内）；未指定/非法则回退默认第一个学生
  let target = null;
  if (qsid && (role === "admin" || (scope && scope.includes(Number(qsid))))) {
    target = students.find(s => s.staff_id === qsid) || null;
  }
  if (!target) {
    target = students[0] || null; // 管理员/家长/家属默认第一个学生；学生本人固定本人
  }
  return { staff, role, students, scope, target };
}

/** 单个学生可见任务 ID：派发给我 + 我创建（与 todoTaskIds / 小程序 myTaskIds 一致） */
async function viewStudentTaskIds(staffId) {
  const set = new Set();
  const [assignR, ownR] = await Promise.all([
    db.from("task_assignees").select("task_id").eq("staff_id", staffId).limit(5000),
    db.from("tasks").select("task_id").eq("created_by", staffId).limit(5000),
  ]);
  (assignR.data || []).forEach(a => set.add(String(a.task_id)));
  (ownR.data || []).forEach(t => set.add(String(t.task_id)));
  return [...set].map(x => Number(x));
}

router.get("/dashboard/learning", adminAuth, async (req, res) => {
  try {
    const view = await resolveLearningView(req);
    const { staff, role, students, target } = view;
    const isAdmin = role === "admin";

    // 任务范围（安全审计 S6）：管理员默认第一个学生；选中单个学生时仅统计该学生任务；
    // 家长/家属默认第一个孩子（可切换名下孩子），学生固定本人
    let visibleTaskIds = null;
    if (target) {
      visibleTaskIds = await viewStudentTaskIds(target.staff_id);
    } else if (!isAdmin) {
      visibleTaskIds = [];
    }
    const scoped = (q) => {
      if (visibleTaskIds === null) return q;
      return visibleTaskIds.length ? q.in("task_id", visibleTaskIds) : null;
    };
    const taskQuery = async (q) => {
      if (!q) return { data: [], error: null };
      return await q;
    };

    const checkinQ = () => db.from("task_checkins").select();
    const recentTasksQ = scoped(db.from("tasks").select());
    // 打卡查询同样按任务范围过滤（学生只取自己任务下的打卡，避免 2000 行截断导致统计漏数）
    const scopedCheckinQ = () => {
      const q = checkinQ();
      return visibleTaskIds === null ? q : (visibleTaskIds.length ? q.in("task_id", visibleTaskIds) : null);
    };

    const [tasksR, checkinsR, recentTasksR] = await Promise.all([
      taskQuery(scoped(db.from("tasks").select("task_id, task_status, subject, checkin_count, title, collection_id, deadline"))?.limit(2000)),
      taskQuery(scopedCheckinQ()?.select("checkin_id, task_id, checkin_date, checkin_note, checkin_images, checkin_type, source, created_by, created_at").order("created_at", { ascending: false }).limit(2000)),
      taskQuery(recentTasksQ ? recentTasksQ.order("updated_at", { ascending: false }).limit(8) : null),
    ]);
    if (tasksR.error) throw tasksR.error;
    if (checkinsR.error) throw checkinsR.error;
    if (recentTasksR.error) throw recentTasksR.error;

    const tasks = tasksR.data || [];
    const allCheckins = checkinsR.data || [];
    // 最近打卡复用 checkins 查询结果（已按 created_at 倒序），避免同一 scope 二次查询
    const recentCheckins = allCheckins.slice(0, 200);
    const recentTasks = recentTasksR.data || [];

    // 仅统计「任务仍存在」的打卡，已删除任务的打卡（孤儿打卡）不进入任何统计
    const liveTaskIds = new Set(tasks.map(t => String(t.task_id)));
    const checkins = allCheckins.filter(c => liveTaskIds.has(String(c.task_id)));

    // 基础统计
    const totalTasks = tasks.length;
    const todoCount = tasks.filter(t => t.task_status === "todo").length;
    const doingCount = tasks.filter(t => t.task_status === "doing").length;
    const doneCount = tasks.filter(t => t.task_status === "done").length;
    const totalCheckins = checkins.length;
    const today = formatDate(new Date());
    const todayCheckins = checkins.filter(c => String(c.checkin_date || "").slice(0, 10) === today).length;
    const todayCheckedIn = todayCheckins > 0;
    const completionRate = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;
    const avgCheckin = totalTasks > 0 ? Math.round(totalCheckins / totalTasks) : 0;

    // 游戏化：经验值来自积分账本（审核通过+10/完成任务+30，删除与回退自动扣分，杜绝只增不减）；
    // 选中单个学生=该学生余额；管理员全部=所有学生余额之和
    let xp = 0;
    let pointLogs = [];
    if (target) {
      const [xpVal, logs] = await Promise.all([
        staffPoints(target.staff_id),
        recentPointLogs(target.staff_id, 10),
      ]);
      xp = xpVal;
      pointLogs = logs;
    } else {
      const allIds = students.map(s => Number(s.staff_id)).filter(Boolean);
      const pmap = await staffPointsMap(allIds);
      xp = Object.values(pmap).reduce((s, v) => s + (Number(v) || 0), 0);
    }
    const level = levelFromXp(xp);
    const checkinDates = new Set(checkins.map(c => String(c.checkin_date || "").slice(0, 10)).filter(Boolean));
    // 当前连击：以今天为终点；今天未打卡时以昨天为终点，避免当天连击数归零
    const todayStreak = streakEndingAt(checkinDates, new Date());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStreak = streakEndingAt(checkinDates, yesterday);
    const currentStreak = Math.max(todayStreak, yesterdayStreak);
    const maxStreak = maxStreakOf(checkinDates);

    // 附加游戏化指标：活跃天数 / 单日最高打卡 / 使用合集数 / 早晚时段打卡
    const distinctActiveDays = checkinDates.size;
    const dailyCountMap = {};
    checkins.forEach(c => {
      const day = String(c.checkin_date || "").slice(0, 10);
      if (day) dailyCountMap[day] = (dailyCountMap[day] || 0) + 1;
    });
    const maxDailyCheckins = Math.max(0, ...Object.values(dailyCountMap));
    const collectionCount = new Set(tasks.map(t => t.collection_id).filter(v => v && Number(v) !== 0)).size;
    const hourOf = (c) => {
      const s = String(c.created_at || "");
      const h = s.slice(11, 13);
      return h ? Number(h) : null;
    };
    const hasEarlyBird = checkins.some(c => { const h = hourOf(c); return h !== null && h >= 6 && h <= 9; });
    const hasNightOwl = checkins.some(c => { const h = hourOf(c); return h !== null && h >= 21; });

    // 近 7 天打卡趋势（仅有效打卡）
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const day = formatDate(d);
      days.push({
        date: day.slice(5),
        value: checkins.filter(c => String(c.checkin_date || "").slice(0, 10) === day).length,
      });
    }

    // 科目分布（仅有效任务）
    const subjectMap = {};
    tasks.forEach(t => {
      const s = String(t.subject || "").trim() || "未分类";
      subjectMap[s] = (subjectMap[s] || 0) + 1;
    });
    const subjectDist = Object.entries(subjectMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    // 任务状态分布
    const statusDist = [
      { name: "待完成", value: todoCount, color: "#f5222d" },
      { name: "进行中", value: doingCount, color: "#1677ff" },
      { name: "已完成", value: doneCount, color: "#52c41a" },
    ].filter(x => x.value > 0);

    // 任务打卡排行（按打卡次数，仅有效任务）
    const taskRank = [...tasks]
      .map(t => ({ title: t.title, value: t.checkin_count || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    // 科目字典总数（「全能学霸」徽章用；查询失败/为空时以当前科目数为准，保证徽章可解锁）
    const subjectItems = await cachedDictItems("subject");
    const subjectTotal = (subjectItems && subjectItems.length) || Math.max(subjectDist.length, 1);

    // 成就徽章（基于有效数据计算；未解锁的给出达成进度）
    const badges = [
      // —— 累计打卡系列 ——
      { key: "first_checkin", name: "初来乍到", desc: "完成首次打卡", icon: "🎯", unlocked: totalCheckins >= 1, progress: Math.min(1, totalCheckins) },
      { key: "checkin_10", name: "打卡十杰", desc: "累计打卡 10 次", icon: "⭐", unlocked: totalCheckins >= 10, progress: Math.min(1, totalCheckins / 10) },
      { key: "checkin_50", name: "打卡达人", desc: "累计打卡 50 次", icon: "💯", unlocked: totalCheckins >= 50, progress: Math.min(1, totalCheckins / 50) },
      { key: "checkin_100", name: "打卡之王", desc: "累计打卡 100 次", icon: "👑", unlocked: totalCheckins >= 100, progress: Math.min(1, totalCheckins / 100) },
      { key: "checkin_200", name: "打卡神话", desc: "累计打卡 200 次", icon: "💎", unlocked: totalCheckins >= 200, progress: Math.min(1, totalCheckins / 200) },
      { key: "checkin_300", name: "打卡传奇", desc: "累计打卡 300 次", icon: "🗿", unlocked: totalCheckins >= 300, progress: Math.min(1, totalCheckins / 300) },

      // —— 连续打卡系列 ——
      { key: "streak_3", name: "持之以恒", desc: "连续打卡 3 天", icon: "🔥", unlocked: maxStreak >= 3, progress: Math.min(1, maxStreak / 3) },
      { key: "streak_7", name: "一周热力", desc: "连续打卡 7 天", icon: "💪", unlocked: maxStreak >= 7, progress: Math.min(1, maxStreak / 7) },
      { key: "streak_14", name: "双周坚持", desc: "连续打卡 14 天", icon: "🏆", unlocked: maxStreak >= 14, progress: Math.min(1, maxStreak / 14) },
      { key: "streak_30", name: "月度传奇", desc: "连续打卡 30 天", icon: "🏅", unlocked: maxStreak >= 30, progress: Math.min(1, maxStreak / 30) },
      { key: "streak_60", name: "两月坚持", desc: "连续打卡 60 天", icon: "🥇", unlocked: maxStreak >= 60, progress: Math.min(1, maxStreak / 60) },
      { key: "streak_100", name: "百日传奇", desc: "连续打卡 100 天", icon: "👑", unlocked: maxStreak >= 100, progress: Math.min(1, maxStreak / 100) },

      // —— 任务系列 ——
      { key: "task_done_1", name: "旗开得胜", desc: "完成第 1 个任务", icon: "✅", unlocked: doneCount >= 1, progress: Math.min(1, doneCount) },
      { key: "task_done_5", name: "任务能手", desc: "完成 5 个任务", icon: "🚀", unlocked: doneCount >= 5, progress: Math.min(1, doneCount / 5) },
      { key: "task_done_10", name: "任务大师", desc: "完成 10 个任务", icon: "🎓", unlocked: doneCount >= 10, progress: Math.min(1, doneCount / 10) },
      { key: "task_done_20", name: "任务宗师", desc: "完成 20 个任务", icon: "🏅", unlocked: doneCount >= 20, progress: Math.min(1, doneCount / 20) },
      { key: "task_create_5", name: "筑梦起航", desc: "创建 5 个任务", icon: "🏗️", unlocked: totalTasks >= 5, progress: Math.min(1, totalTasks / 5) },
      { key: "task_create_10", name: "规划大师", desc: "创建 10 个任务", icon: "📋", unlocked: totalTasks >= 10, progress: Math.min(1, totalTasks / 10) },
      { key: "all_task_done", name: "全任务达成", desc: "所有任务全部完成", icon: "🏁", unlocked: totalTasks > 0 && doneCount >= totalTasks, progress: totalTasks > 0 ? Math.min(1, doneCount / totalTasks) : 0 },

      // —— 等级系列 ——
      { key: "level_3", name: "初露锋芒", desc: "达到 Lv.3", icon: "🌱", unlocked: level.level >= 3, progress: Math.min(1, level.level / 3) },
      { key: "level_5", name: "小有名气", desc: "达到 Lv.5", icon: "🌟", unlocked: level.level >= 5, progress: Math.min(1, level.level / 5) },
      { key: "level_8", name: "声名鹊起", desc: "达到 Lv.8", icon: "🚀", unlocked: level.level >= 8, progress: Math.min(1, level.level / 8) },
      { key: "level_10", name: "巅峰学霸", desc: "达成满级 Lv.10", icon: "🏆", unlocked: level.level >= 10, progress: Math.min(1, level.level / 10) },

      // —— 科目系列 ——
      { key: "subject_3", name: "博学多闻", desc: "涉猎 3 个科目", icon: "📚", unlocked: subjectDist.length >= 3, progress: Math.min(1, subjectDist.length / 3) },
      { key: "subject_5", name: "学贯中西", desc: "涉猎 5 个科目", icon: "🌏", unlocked: subjectDist.length >= 5, progress: Math.min(1, subjectDist.length / 5) },
      { key: "subject_all", name: "全能学霸", desc: "覆盖全部科目", icon: "🎖️", unlocked: subjectDist.length >= subjectTotal, progress: Math.min(1, subjectDist.length / subjectTotal) },

      // —— 活跃系列 ——
      { key: "active_30", name: "学习满月", desc: "累计活跃打卡 30 天", icon: "📅", unlocked: distinctActiveDays >= 30, progress: Math.min(1, distinctActiveDays / 30) },
      { key: "active_100", name: "百日耕耘", desc: "累计活跃打卡 100 天", icon: "🌾", unlocked: distinctActiveDays >= 100, progress: Math.min(1, distinctActiveDays / 100) },
      { key: "day_multi_3", name: "一鸣惊人", desc: "单日打卡 3 次以上", icon: "🎇", unlocked: maxDailyCheckins >= 3, progress: Math.min(1, maxDailyCheckins / 3) },
      { key: "day_multi_5", name: "超强输出", desc: "单日打卡 5 次以上", icon: "💥", unlocked: maxDailyCheckins >= 5, progress: Math.min(1, maxDailyCheckins / 5) },
      { key: "perfect_week", name: "全勤之星", desc: "近 7 天每天打卡", icon: "🌟", unlocked: days.length > 0 && days.every(d => d.value > 0), progress: days.length ? days.filter(d => d.value > 0).length / days.length : 0 },

      // —— 特色系列 ——
      { key: "collection_3", name: "合集达人", desc: "使用 3 个任务合集", icon: "🗂️", unlocked: collectionCount >= 3, progress: Math.min(1, collectionCount / 3) },
      { key: "early_bird", name: "晨间精灵", desc: "清晨 6-9 点完成打卡", icon: "🐦", unlocked: hasEarlyBird, progress: hasEarlyBird ? 1 : 0 },
      { key: "night_owl", name: "深夜学霸", desc: "夜间 21 点后完成打卡", icon: "🦉", unlocked: hasNightOwl, progress: hasNightOwl ? 1 : 0 },
    ];

    // 最近打卡：仅展示有效任务下的打卡，并补充任务标题
    const taskTitleMap = {};
    tasks.forEach(t => { taskTitleMap[t.task_id] = t.title; });
    const hasImages = (v) => {
      if (!v) return false;
      const s = String(v).trim();
      if (s.startsWith("[")) {
        try { return (JSON.parse(s) || []).length > 0; } catch (_) { return false; }
      }
      return s.split(",").some(x => String(x).trim());
    };
    const recentCheckinList = (await attachStaffInfo(recentCheckins
      .filter(c => liveTaskIds.has(String(c.task_id)))
      .slice(0, 8)
      .map(c => ({
        checkin_id: String(c.checkin_id),
        task_id: c.task_id,
        task_title: taskTitleMap[c.task_id] || "(任务已删除)",
        checkin_date: c.checkin_date,
        note: c.checkin_note,
        has_images: hasImages(c.checkin_images),
        checkin_type: normalizeCheckinType(c.checkin_type),
        source: normalizeTaskSource(c.source, "miniprogram"),
        created_by: c.created_by,
        created_at: c.created_at,
      })))).map(c => ({
        ...c,
        _creatorUsername: c._creatorUsername || "",
        _creatorNickname: c._creatorNickname || "",
      }));

    const recentTaskList = recentTasks.map(t => ({
      task_id: t.task_id,
      title: t.title,
      subject: t.subject,
      task_status: t.task_status,
      checkin_type: normalizeCheckinType(t.checkin_type),
      source: normalizeTaskSource(t.source),
      checkin_count: t.checkin_count || 0,
      deadline: t.deadline,
    }));

    // 逾期 / 临期任务统计（仅待完成任务，按 deadline 与今天比较）
    const todayMs = new Date(`${today}T00:00:00`).getTime();
    const soonMs = todayMs + 3 * 86400000;
    let overdueCount = 0;
    let dueSoonCount = 0;
    tasks.forEach(t => {
      if (t.task_status === "done") return;
      const dl = String(t.deadline || "").slice(0, 10);
      if (!dl) return;
      const dlMs = new Date(`${dl}T00:00:00`).getTime();
      if (!Number.isFinite(dlMs)) return;
      if (dlMs < todayMs) overdueCount += 1;
      else if (dlMs <= soonMs) dueSoonCount += 1;
    });

    // 成就徽章解锁落库：选中单个学生时记录新解锁徽章及解锁时间；汇总视图不记录（徽章为聚合口径）
    let badgesWithTime = badges;
    if (target) {
      const badgeUnlockMap = await syncBadgeUnlocks(
        Number(target.staff_id),
        badges.filter(b => b.unlocked).map(b => b.key)
      );
      badgesWithTime = badges.map(b => (b.unlocked ? { ...b, unlocked_at: badgeUnlockMap[b.key] || "" } : b));
    }

    // 打卡/进度提醒文案（后端独立生成）
    const reminders = buildLearningReminders({
      todayCheckedIn, todayCheckins, currentStreak,
      completionRate, doneCount, totalTasks,
      remainingCount: totalTasks - doneCount,
      activeCount: doingCount,
      overdueCount, dueSoonCount,
      nextBadge: badgesWithTime.find(b => !b.unlocked) || null,
    });

    res.json(ok({
      student: target
        ? { staff_id: target.staff_id, nickname: target.nickname, username: target.username }
        : { nickname: "全部学生", username: isAdmin ? "平台学生汇总" : "本家庭学生汇总" },
      viewStudentId: target ? target.staff_id : "",
      students,
      points: xp,
      pointLogs,
      stats: {
        totalTasks, todoCount, doingCount, doneCount,
        totalCheckins, todayCheckins, todayCheckedIn,
        completionRate, avgCheckin,
        activeCount: doingCount,
        remainingCount: totalTasks - doneCount,
      },
      level,
      streak: { current: currentStreak, max: maxStreak, todayCheckedIn },
      badges: badgesWithTime,
      days,
      subjectDist,
      statusDist,
      taskRank,
      reminders,
      recentCheckinList,
      recentTaskList,
    }));
  } catch (e) {
    console.error("[admin] learning dashboard error", e);
    res.json(fail("服务异常", 500));
  }
});

module.exports = { router, adminAuth };
