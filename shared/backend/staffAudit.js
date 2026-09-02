/**
 * 后台 staff 操作审计日志（staff_events 表）
 * - 记录后台员工操作事件：登录/登出/点击菜单/增删改查等
 * - 记录操作人、客户端 IP、浏览器指纹（UA 解析）、请求参数（脱敏）等审计信息
 * - fire-and-forget 写库，失败静默，不影响业务主流程
 */
const { db } = require("./db");
const { genId, nowSql } = require("./utils");
const { sanitize } = require("./trace");

/** 业务表 → 中文名（审计事件命名用） */
const TABLE_CN = {
  users: "用户",
  service_monitor: "服务监控",
  api_trace: "接口链路",
  user_sessions: "会话画像",
  file_uploads: "图片上传",
  user_events: "用户事件",
  staff: "管理员",
  roles: "角色",
  menus: "菜单",
  dict_types: "字典类型",
  dict_items: "字典项",
  seqs: "序列",
  tasks: "任务",
  task_collections: "合集",
  task_checkins: "任务打卡",
  lp_students: "绑定关系",
  lp_invites: "邀请码",
  staff_events: "审计日志",
  system_params: "系统参数",
  system_error_logs: "错误日志",
};
const tableCn = (table) => TABLE_CN[table] || table;

/** 客户端 IP：x-forwarded-for 取第一个（云托管透传真实 IP），否则取 socket 地址 */
function getClientIp(req) {
  const fwd = req && req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim().slice(0, 64);
  return String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || "unknown").slice(0, 64);
}

/** 客户端浏览器指纹：从 User-Agent 提取 浏览器/平台/系统/设备（截断 128 字符） */
function getBrowserFingerprint(req) {
  const ua = (req && req.headers && req.headers["user-agent"]) || "";
  const browser = ua.match(/(Chrome|Firefox|Edg\/|Edge|Safari)[\/\s][\d.]+/i);
  const bname = browser ? (browser[1].replace(/edg$/i, "Edge")) : "";
  const platform = /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : /Macintosh/i.test(ua) ? "macOS" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "other";
  const sys = ua.match(/Windows NT ([\d.]+)/i) || ua.match(/Mac OS X ([\d_.]+)/i) || ua.match(/Android ([\d.]+)/i) || ua.match(/(?:iPhone OS|iOS) ([\d_.]+)/i);
  const device = ua.match(/iPhone[\s,]*([A-Za-z0-9,]+)?/i) || ua.match(/iPad[\s,]*([A-Za-z0-9,]+)?/i) || ua.match(/Macintosh/i);
  const parts = [
    bname ? `browser:${bname}` : "",
    `platform:${platform}`,
    sys ? `os:${sys[1].replace(/_/g, ".")}` : "",
    device ? `device:${device[0].split(" ")[0]}` : "",
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 128);
}

/** 请求参数脱敏后序列化（GET 用 query，POST 用 body），脱敏复用 trace.sanitize */
function getParams(req) {
  if (!req) return null;
  const src = req.method === "GET" ? req.query : req.body;
  if (!src || typeof src !== "object" || Object.keys(src).length === 0) return null;
  try {
    return JSON.stringify(sanitize(src));
  } catch (_) {
    return null;
  }
}

/**
 * 写一条 staff 审计日志
 * @param {object} p
 * @param {object} [p.req] Express req（取 IP/UA/指纹/请求参数）
 * @param {object} [p.staff] 操作人 { staff_id, username }（登录失败等场景可只传 username）
 * @param {string} p.eventType login/login_fail/logout/menu_click/create/update/delete/detail/review/custom
 * @param {string} p.eventName 事件名称（如 登录成功 / 创建用户）
 * @param {string} [p.module] 业务模块（users/tasks/staff 或 auth/menu）
 * @param {string} [p.apiPath] 接口路径（缺省取 req.originalUrl）
 * @param {string} [p.bizId] 业务 ID
 * @param {object} [p.extra] 附加信息（JSON 序列化；与 p.trace 二选一）
 * @param {Array} [p.trace] 完整操作过程 trace 数组（每步对象 key 一致：subject/start_time/end_time/reason/status/duration/params）
 */
async function logStaffEvent(p) {
  try {
    if (!p || !p.eventType || !p.eventName) return;
    const req = p.req || {};
    const staff = p.staff || {};
    const extra = p.trace !== undefined ? p.trace : p.extra;
    await db.from("staff_events").insert({
      event_id: genId(),
      staff_id: Number(staff.staff_id) || 0,
      app_id: String(p.appId || (req.appId) || "").slice(0, 32),
      staff_username: String(staff.username || staff.staff_username || "").slice(0, 64),
      event_type: String(p.eventType).slice(0, 24),
      event_name: String(p.eventName).slice(0, 64),
      module: String(p.module || "").slice(0, 64),
      api_path: String(p.apiPath || req.originalUrl || req.url || "").slice(0, 200),
      biz_id: String(p.bizId || "").slice(0, 64),
      client_ip: getClientIp(req),
      client_fingerprint: getBrowserFingerprint(req),
      user_agent: String(req.headers && req.headers["user-agent"] || "").slice(0, 255),
      extra: extra ? JSON.stringify(extra) : null,
      created_at: nowSql(),
    });
  } catch (e) {
    console.error("[staffAudit] 审计日志入库失败:", e);
  }
}

// ==================== 操作过程 trace 构建器 ====================
// 提供完整的操作 JSON 数组（类似 chatgpt 返回的 trace 数组），方便审计跟踪。
// 每个 step 对象 key 一致：subject / start_time / end_time / reason / status / duration / params。
// 数组顺序即步骤顺序（step1、step2、step3…），末尾追加一条 total 汇总（subject=整体，duration=总耗时）。

/** 新建一个 trace 上下文 */
function newTrace(subject, params = {}) {
  return {
    subject: String(subject || ""),
    params: sanitize(params || {}),
    startTime: nowSql(),
    startedMs: Date.now(),
    steps: [],
  };
}

/**
 * 记录一个步骤（计时执行 fn）
 * @returns {Promise<{result, err}>} fn 的返回值与错误（错误已被捕获，不会抛出）
 */
async function runStep(trace, subject, fn, { params = {}, reason = "" } = {}) {
  const start = nowSql();
  const t0 = Date.now();
  let status = "success";
  let reasonText = String(reason || "");
  let result;
  let err = null;
  try {
    result = await fn();
  } catch (e) {
    status = "failed";
    err = e;
    reasonText = String((e && e.message) || e || "失败").slice(0, 255) || reasonText;
  }
  const end = nowSql();
  trace.steps.push({
    subject: String(subject || ""),
    start_time: start,
    end_time: end,
    reason: reasonText,
    status,
    duration: Date.now() - t0,
    params: sanitize(params || {}),
  });
  return { result, err };
}

/**
 * 收尾 trace：返回完整步骤数组（含末尾 total 汇总步）。
 * @param {object} trace newTrace 产物
 * @param {string} [status] 整体状态（缺省按步骤推断：任一步 failed 则 failed）
 * @param {string} [reason] 整体说明
 */
function finishTrace(trace, status, reason = "") {
  const steps = (trace.steps || []).map(s => ({ ...s }));
  const hasFailed = steps.some(s => s.status === "failed");
  steps.push({
    subject: String(trace.subject || ""),
    start_time: trace.startTime,
    end_time: nowSql(),
    reason: String(reason || (hasFailed ? "存在失败步骤" : "")),
    status: String(status || (hasFailed ? "failed" : "success")),
    duration: Date.now() - trace.startedMs,
    params: trace.params || {},
  });
  return steps;
}

module.exports = { logStaffEvent, getClientIp, getBrowserFingerprint, tableCn, newTrace, runStep, finishTrace };
