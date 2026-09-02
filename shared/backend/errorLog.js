/**
 * 系统错误日志模块（system_error_logs 表）
 * 类似 Java 的 logger.error：把未捕获异常 / 业务异常统一入库，后台「系统监控 → 错误日志」可查。
 *
 * 三种接入方式（可叠加）：
 *  - 业务代码显式调用：`logError({ module: "lp", message, stack, req })`（推荐，便于定位模块）
 *  - 全局兜底：server.js 启动时 `patchConsoleError()` 拦截所有 console.error，
 *    自动解析 [模块] 前缀与 Error 对象后入库（覆盖全部既有 catch 分支，无需逐个改）
 *  - Express 错误中间件：未捕获的同步异常自动转发（见 server.js）
 *
 * fire-and-forget 写库，写库失败只打控制台日志，不影响业务主流程；
 * 相同错误（模块 + 消息前 120 字符）60s 窗口内去重，避免日志风暴撑爆表。
 */
const { db } = require("./db");
const { genId, nowSql } = require("./utils");

// 捕获原生 console.error（打补丁后引用原函数，避免日志入库失败时递归）
const origError = console.error;

// 进程内去重：key = module:message(前120字符)，60s 窗口内同错只记一次
const DEDUP = new Map();
const DEDUP_WINDOW = 60 * 1000;

/**
 * 写一条错误日志（fire-and-forget）
 * @param {object} p
 * @param {object} [p.req] Express req（取 appId/openid/api_path）
 * @param {string} [p.level] 级别 error/warn/info（默认 error）
 * @param {string} [p.module] 来源模块（如 lp、admin/users、global）
 * @param {string|number} [p.code] 错误码（默认 500）
 * @param {string} [p.message] 错误信息摘要（截断 500）
 * @param {string} [p.stack] 错误堆栈（截断 4000）
 * @param {object|string} [p.detail] 附加详情（JSON 序列化，截断 4000）
 */
async function logError(p = {}) {
  try {
    const req = p.req || {};
    const message = String(p.message || "").slice(0, 500);
    const key = `${String(p.module || "")}:${message.slice(0, 120)}`;
    const now = Date.now();
    const hit = DEDUP.get(key);
    if (hit && now - hit < DEDUP_WINDOW) return;
    DEDUP.set(key, now);
    if (DEDUP.size > 5000) DEDUP.clear();

    await db.from("system_error_logs").insert({
      log_id: genId(),
      app_id: String(req.appId || "").slice(0, 32),
      openid: String(req.openid || "").slice(0, 64),
      level: String(p.level || "error").slice(0, 16),
      module: String(p.module || "").slice(0, 64),
      api_path: String((req && (req.originalUrl || req.url)) || "").slice(0, 200),
      error_code: Number(p.code) || 500,
      message,
      stack: String(p.stack || "").slice(0, 4000),
      detail: p.detail ? JSON.stringify(p.detail).slice(0, 4000) : null,
      created_at: nowSql(),
    });
  } catch (e) {
    origError("[errorLog] 错误日志入库失败:", e && e.message ? e.message : e);
  }
}

/**
 * 拦截 console.error，自动提取 [模块] 前缀与 Error 对象后入库。
 * 该补丁覆盖仓库内全部「console.error("[模块] ... error", e)」既有写法，
 * 无需逐个 catch 分支改造即可实现错误入库（日志去重见 logError）。
 */
function patchConsoleError() {
  const wrapped = function (...args) {
    // 原样输出到控制台（云托管日志）
    origError.apply(console, args);
    try {
      // 解析 [模块] 前缀；无前缀时整条作正文（保证全局日志也能入库）
      let moduleTag = "";
      let firstText = "";
      const first = args[0];
      if (typeof first === "string") {
        const m = first.match(/^\[([^\]]+)\](.*)$/);
        if (m) {
          moduleTag = m[1].slice(0, 64);
          firstText = m[2].trim();
        } else {
          firstText = first.trim();
        }
      }
      // 提取错误对象（最后一个 Error/含 stack 的对象，保证拿到完整堆栈）；
      // 兜底：参数里形如堆栈的字符串（Error: xxx ... \n at ...）也入库
      let err = null;
      let stackFromStr = "";
      for (let i = args.length - 1; i >= 0; i--) {
        const a = args[i];
        if (typeof a === "string") {
          if (!stackFromStr && (a.includes("\n    at ") || /^\s*Error(?::|$)/.test(a))) stackFromStr = a;
          continue;
        }
        if (!err && a instanceof Error) { err = a; continue; }
        if (!err && a && typeof a === "object" && (a.stack || a.message)) { err = a; continue; }
      }
      const stack = (err && err.stack) || stackFromStr || "";
      const message = (err && err.message) || firstText || (stackFromStr ? stackFromStr.slice(0, 500) : "");
      if (message || err) {
        logError({
          module: moduleTag || "global",
          message,
          stack,
          detail: err ? { tag: moduleTag, text: firstText || undefined } : null,
        }).catch(() => {});
      }
    } catch (_) { /* 打补丁内的解析异常忽略，不影响主流程 */ }
  };
  console.error = wrapped;
  return origError;
}

module.exports = { logError, patchConsoleError };
