/**
 * 系统参数模块（t_system_params）
 * - 后台「系统参数」维护各种常量/文案；前端绑定文案、注销说明等可用 JSON 集中维护，
 *   避免改页面源码。
 * - 读接口缓存 60s，后台修改后最多 60s 生效；param_type=json 的返回解析后的对象。
 * - 小程序端经 /api/lp/params 批量读取（需会话，见 lp.js）。
 */
const { db } = require("./db");
const { cached, cache } = require("./cache");

const PARAM_TTL = 60 * 1000;
const APP_ID = "miniprogram-kxm";

/** 读取单条参数原始文本（未启用/不存在返回 null） */
async function getParamRaw(appId, key) {
  const app = appId || APP_ID;
  const k = String(key || "").slice(0, 64);
  if (!k) return null;
  return cached(`sysparam:${app}:${k}`, async () => {
    try {
      const { data, error } = await db.from("system_params")
        .select("param_value, param_status")
        .eq("app_id", app).eq("param_key", k).limit(1);
      if (error) return null;
      const rec = data && data[0];
      if (!rec || Number(rec.param_status) !== 1) return null;
      return rec.param_value == null ? "" : String(rec.param_value);
    } catch (_) {
      return null;
    }
  }, PARAM_TTL);
}

/** 按 param_type 解析参数值：json → 对象；number → 数字；bool/boolean → 布尔；其余 → 原字符串 */
function parseParamValue(raw, type) {
  const t = String(type || "string").toLowerCase();
  if (t === "json") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (t === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (t === "bool" || t === "boolean") {
    const s = String(raw).trim().toLowerCase();
    if (["true", "1", "yes", "on", "y"].includes(s)) return true;
    if (["false", "0", "no", "off", "n"].includes(s)) return false;
    return raw;
  }
  return raw;
}

/** 读取单条参数（按 param_type 解析：json → 对象、number → 数字、bool → 布尔，否则字符串）；返回 null 表示不存在/停用 */
async function getParam(appId, key, type = "string") {
  const raw = await getParamRaw(appId, key);
  if (raw === null) return null;
  return parseParamValue(raw, type);
}

/** 读取单条 JSON 参数（已解析对象；非法 JSON 返回 null） */
async function getParamJson(appId, key) {
  return getParam(appId, key, "json");
}

/** 批量读取参数：按各自 param_type 解析，返回 { key: value }（不存在/停用不返回该键） */
async function getParamsMap(appId, keys) {
  const app = appId || APP_ID;
  const list = [...new Set((keys || []).map(String).filter(Boolean))];
  const out = {};
  if (list.length === 0) return out;
  await Promise.all(list.map(async (k) => {
    try {
      const rec = await cached(`sysparam:${app}:${k}`, async () => {
        const { data, error } = await db.from("system_params")
          .select("param_value, param_type, param_status")
          .eq("app_id", app).eq("param_key", k).limit(1);
        if (error) return null;
        return (data && data[0]) || null;
      }, PARAM_TTL);
      if (!rec || Number(rec.param_status) !== 1) return;
      const raw = rec.param_value == null ? "" : String(rec.param_value);
      out[k] = parseParamValue(raw, rec.param_type || "string");
    } catch (_) { /* 忽略单条失败 */ }
  }));
  return out;
}

/** 参数变更后调用：失效该 app 全部参数缓存（写时失效）。key 指定时仅失效该键；缺省按已知 key 失效 */
function invalidateParams(appId, key) {
  const app = appId || APP_ID;
  try {
    if (key) {
      cache.delete(`sysparam:${app}:${key}`);
      return;
    }
    // 无前缀枚举能力，仅失效常用 key（identity_bind_copy / account_cancel_copy），
    // 其余 key 由 60s TTL 兜底。后台编辑后建议一并失效全量——这里按需失效已知 key。
    cache.delete(`sysparam:${app}:identity_bind_copy`);
    cache.delete(`sysparam:${app}:account_cancel_copy`);
  } catch (_) { /* 忽略 */ }
}

module.exports = { getParamRaw, getParam, getParamJson, getParamsMap, invalidateParams, APP_ID };
