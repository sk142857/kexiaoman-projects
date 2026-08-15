/**
 * 接口调用链路追踪
 * - 请求进入时记录 server_start
 * - 响应结束时插入 api_trace（status=server_only）
 * - 前端异步上报 client_cost 后由 /api/analytics/reportTrace 补全
 *
 * 注意：api_trace 为即时插入（非批量）。
 * 原因：前端在请求回调后立即上报 reportTrace 做 UPDATE，
 * 若走 5 分钟批量队列，UPDATE 时记录尚未入库 → 匹配 0 行 → 永远 server_only。
 * 100 人规模下 api_trace 量小，即时插入压力可忽略。
 */
const { db } = require("./db");
const { nowSql } = require("./utils");
const jwt = require("jsonwebtoken");

// openid → user_id(user_uid) 内存缓存，减少每次请求都查库
const uidCache = new Map();
const UID_CACHE_MAX = 5000;
async function getUserIdByOpenid(openid) {
  if (!openid) return "";
  if (uidCache.has(openid)) return uidCache.get(openid);
  try {
    const { data, error } = await db.from("users")
      .select("user_uid")
      .eq("openid", openid)
      .limit(1);
    const uid = (!error && data && data[0] && data[0].user_uid) ? String(data[0].user_uid) : "";
    if (uidCache.size >= UID_CACHE_MAX) uidCache.clear();
    uidCache.set(openid, uid);
    return uid;
  } catch (_) {
    return "";
  }
}

/** 敏感字段脱敏，避免记录 token/密码等 */
const SENSITIVE_KEYS = ["token", "password", "secret", "openid", "session_id"];
function sanitize(value, depth = 0) {
  if (depth > 4) return "[deep]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 500) return value.slice(0, 500) + "...[truncated]";
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(v => sanitize(v, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).slice(0, 30)) {
      if (SENSITIVE_KEYS.includes(k.toLowerCase())) {
        out[k] = "[hidden]";
      } else {
        out[k] = sanitize(value[k], depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** 请求参数脱敏后序列化（GET 用 query，POST 用 body） */
function getParams(req) {
  const src = req.method === "GET" ? req.query : req.body;
  if (!src || typeof src !== "object" || Object.keys(src).length === 0) return null;
  try {
    return JSON.stringify(sanitize(src));
  } catch (_) {
    return null;
  }
}

/** 客户端指纹：从 User-Agent 提取 微信版本/平台/系统/设备（截断 128 字符） */
function getClientFingerprint(req) {
  const ua = req.headers["user-agent"] || "";
  // 例：MicroMessenger/8.0.60.2520(0x28003834) iOS/19.2 iPhone17,3 ...
  const mm = ua.match(/MicroMessenger\/([^\s(]+)/i);
  const platform = /iPhone/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : /Macintosh/i.test(ua) ? "macOS" : /Windows/i.test(ua) ? "Windows" : "other";
  const sys = ua.match(/(?:iPhone OS|iOS)\s*([\d_.]+)/i) || ua.match(/Android\s+([\d.]+)/i);
  const device = ua.match(/(iPhone\s+[\w,]+|iPad\s+[\w,]+|Android\s+[\w ]+)/i);
  const parts = [
    mm ? `wx:${mm[1]}` : "",
    `platform:${platform}`,
    sys ? `os:${sys[1].replace(/_/g, ".")}` : "",
    device ? `device:${device[1]}` : "",
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 128);
}

/** 从请求解析 openid：优先规范化后的 req.openid；LP 接口从 LP JWT 解码兜底；再退到网关注入的 X-WX-OPENID */
function resolveOpenid(req) {
  if (req.openid) return req.openid;
  const token = req.headers["x-lp-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded && decoded.openid) return decoded.openid;
    } catch (_) { /* 解码失败走下一级 */ }
  }
  return req.headers["x-wx-openid"] || "";
}

/**
 * 请求链路中间件：
 * 在 openid 鉴权后挂载，跳过健康检查路径。
 * 响应结束后写库（异步，失败不影响响应）。
 */
function traceMiddleware(req, res, next) {
  const requestId = req.headers["x-request-id"];
  // 健康检查与上报接口自身不参与追踪（避免递归/无效记录）
  if (!requestId || req.path === "/" || req.path === "/healthz" || req.path.includes("/reportTrace")) {
    return next();
  }
  const openid = resolveOpenid(req);
  if (!openid) {
    return next();
  }

  const start = Date.now();
  const startSql = nowSql();
  // 包装 res.json，捕获业务 code（{ code, msg, data }）
  const _json = res.json.bind(res);
  res.json = (body) => {
    res.locals._code = body && typeof body.code === "number" ? body.code : res.statusCode;
    return _json(body);
  };

  res.on("finish", () => {
    const cost = Date.now() - start;
    const code = res.locals._code !== undefined ? res.locals._code : res.statusCode;
    getUserIdByOpenid(openid).then(userId => {
      const metric = {
        request_id: requestId,
        openid,
        user_id: userId,
        api_path: req.originalUrl || req.url || "",
        api_method: req.method || "",
        req_params: getParams(req),
        start_time: startSql,
        end_time: nowSql(),
        server_cost_ms: cost,
        server_code: code,
        http_status: res.statusCode,
        client_fingerprint: getClientFingerprint(req),
        trace_status: "server_only",
        created_at: nowSql(),
      };
      // 异步写库（fire-and-forget，不阻塞响应；即时插入保证 reportTrace 能 UPDATE 到）
      writeTraceAsync(metric);
    });
    console.log(`[trace] ${req.method} ${req.originalUrl} requestId=${requestId} cost=${cost}ms code=${code}`);
  });
  next();
}

/** 异步写入 api_trace（失败仅记日志，不影响主流程） */
async function writeTraceAsync(metric) {
  try {
    const { error } = await db.from("api_trace").insert(metric);
    if (error) throw error;
  } catch (e) {
    console.error("[trace] 入库失败 requestId=" + metric.request_id, e.message || e);
  }
}

/** 前端上报：用 request_id 补全 client_cost */
async function reportTrace(requestId, clientCostMs) {
  if (!requestId || clientCostMs == null) return;
  await db.from("api_trace")
    .update({
      client_cost_ms: Number(clientCostMs),
      client_at: nowSql(),
      trace_status: "complete",
    })
    .eq("request_id", requestId);
}

module.exports = { traceMiddleware, reportTrace, sanitize };
