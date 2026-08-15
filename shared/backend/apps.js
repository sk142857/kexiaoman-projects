/**
 * 多小程序应用注册表
 *
 * 所有小程序共享同一云环境 + 同一套云托管后端，通过 app_id 区分。
 * - app_id 即 app_code（如 miniprogram-kxm），作为业务表 app 维度字段值
 * - 数据库 apps 表为权威注册表；BUILTIN_APPS 为内置兜底（表未初始化/查询失败时也能工作）
 * - 云托管自动注入请求头 X-WX-APPID（调用方小程序 AppID）、X-WX-OPENID（用户 openid，
 *   共享环境下可能带 "{AppID}_" 前缀，见 appAuth.js 的前缀剥离）
 */
const { db } = require("./db");
const { nowSql } = require("./utils");
const { cached, invalidate, invalidatePrefix } = require("./cache");

/** 内置注册表兜底（与 sql/init_data.sql 种子数据保持一致） */
const BUILTIN_APPS = {
  "miniprogram-kxm": { app_id: "miniprogram-kxm", app_name: "课小满", wechat_appid: "wxa8035a4cd63554fe", app_status: 1 },
};

/** 按微信 AppID 在内置注册表中查找应用 */
function builtinAppByAppid(appid) {
  if (!appid) return null;
  for (const a of Object.values(BUILTIN_APPS)) {
    if (a.wechat_appid === appid) return { ...a };
  }
  return null;
}

/** 从请求头解析当前小程序（仅读 X-WX-APPID → 内置注册表，纯同步） */
function resolveAppFromHeaders(req) {
  const appid = req.headers["x-wx-appid"] || req.headers["X-WX-APPID"] || "";
  return builtinAppByAppid(appid);
}

/** 从请求头解析当前小程序（优先数据库注册表，失败回退内置） */
async function resolveApp(req) {
  const builtin = resolveAppFromHeaders(req);
  if (!builtin) return null;
  try {
    const { data, error } = await db.from("apps").select().eq("app_id", builtin.app_id).limit(1);
    if (!error && data && data[0]) return data[0];
  } catch (_) { /* 忽略，回退内置 */ }
  return builtin;
}

/** 幂等写入 apps 表（首次调用某小程序时注册，失败仅告警不阻断） */
async function ensureAppInDb(app) {
  if (!app || !app.app_id) return;
  try {
    const { data, error } = await db.from("apps").select("app_id").eq("app_id", app.app_id).limit(1);
    if (error) return;
    if (data && data.length > 0) return;
    await db.from("apps").insert({
      app_id: app.app_id,
      app_name: app.app_name || app.app_id,
      wechat_appid: app.wechat_appid || "",
      app_status: app.app_status != null ? Number(app.app_status) : 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    invalidatePrefix("apps:");
  } catch (e) {
    console.warn("[apps] ensureAppInDb error:", e.message);
  }
}

/** 全部启用中的小程序列表（后台小程序切换器数据源；缓存 60s，写时失效） */
async function listAllApps() {
  return cached("apps:all", async () => {
    const builtin = Object.values(BUILTIN_APPS).map(a => ({ app_id: a.app_id, app_name: a.app_name }));
    try {
      const { data, error } = await db.from("apps").select("app_id, app_name, app_status")
        .eq("app_status", 1).order("app_id", { ascending: true }).limit(100);
      if (error) return builtin;
      const rows = (data || []).filter(Boolean);
      return rows.length > 0 ? rows.map(a => ({ app_id: a.app_id, app_name: a.app_name })) : builtin;
    } catch (_) {
      return builtin;
    }
  }, 60 * 1000);
}

/** 后台员工可管理的小程序（admin 角色=全部；其余按 staff_apps 授权，缓存 30s） */
async function listStaffApps(staffId, role) {
  if (role === "admin") return listAllApps();
  return cached(`staffapps:${staffId}`, async () => {
    try {
      const { data, error } = await db.from("staff_apps").select("app_id").eq("staff_id", staffId).limit(100);
      if (error) throw error;
      const allowed = new Set((data || []).map(r => r.app_id).filter(Boolean));
      const all = await listAllApps();
      const granted = all.filter(a => allowed.has(a.app_id));
      return granted.length > 0 ? granted : all;
    } catch (e) {
      console.warn("[apps] listStaffApps error:", e.message);
      return listAllApps();
    }
  }, 30 * 1000);
}

/** 校验员工是否有权管理指定小程序（admin 角色=全部） */
async function isStaffAllowedApp(staffId, role, appId) {
  if (role === "admin" || !appId) return true;
  try {
    const { data, error } = await db.from("staff_apps")
      .select("id").eq("staff_id", staffId).eq("app_id", appId).limit(1);
    if (error) return false;
    return !!(data && data[0]);
  } catch (_) {
    return false;
  }
}

/** 读取小程序运行配置（含 app_secret/jwt_secret，调用方负责脱敏），失败返回 null；缓存 60s */
async function getAppConfig(appId) {
  return cached(`appcfg:${appId}`, async () => {
    try {
      const { data, error } = await db.from("apps").select().eq("app_id", appId).limit(1);
      return (!error && data && data[0]) || null;
    } catch (_) {
      return null;
    }
  }, 60 * 1000);
}

/** 小程序配置更新后调用：让该应用配置缓存失效 */
function invalidateAppConfig(appId) {
  if (appId) invalidate(`appcfg:${appId}`);
}

module.exports = { BUILTIN_APPS, resolveApp, resolveAppFromHeaders, ensureAppInDb, listAllApps, listStaffApps, isStaffAllowedApp, getAppConfig, invalidateAppConfig };
