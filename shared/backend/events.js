/**
 * 用户操作事件日志（user_events 表）
 * - 服务端核心操作事件：登录、增删改查（create/update/delete）等
 * - 前端埋点（page_view/menu_click/button_click）走 /api/analytics/collectEvent
 * - 本模块为服务端权威事件（服务端写库，不依赖前端埋点），fire-and-forget 写库，失败静默
 */
const { db } = require("./db");
const { genId, nowSql } = require("./utils");

/**
 * 写一条用户事件
 * @param {object} p
 * @param {string} [p.appId] 小程序标识（app_id，如 miniprogram-kxm）
 * @param {string} p.openid 用户 openid
 * @param {string} p.eventType login/create/update/delete/end/reset 等
 * @param {string} p.eventName 事件名称（如 登录 / 创建打卡）
 * @param {string} [p.pagePath] 页面路径
 * @param {string} [p.bizId] 业务 ID
 * @param {object} [p.extra] 附加信息（JSON 序列化）
 */
async function logEvent({ appId, openid, eventType, eventName, pagePath = "", bizId = "", extra = null }) {
  try {
    if (!eventType || !eventName) return;
    await db.from("user_events").insert({
      event_id: genId(),
      openid: openid || "",
      app_id: appId || "miniprogram-kxm",
      event_type: String(eventType).slice(0, 24),
      event_name: String(eventName).slice(0, 64),
      page_path: String(pagePath || "").slice(0, 128),
      biz_id: String(bizId || "").slice(0, 64),
      extra: extra ? JSON.stringify(extra) : null,
      client_at: nowSql(),
    });
  } catch (e) {
    console.error("[events] 事件入库失败:", e.message);
  }
}

/**
 * 写一条会话画像（user_sessions 表），fire-and-forget，失败静默
 * @param {object} p
 * @param {string} [p.appId] 小程序标识
 * @param {string} p.openid 用户 openid
 * @param {object} [p.session] 会话画像字段
 */
async function logSession({ appId, openid, session = {} }) {
  try {
    await db.from("user_sessions").insert({
      session_id: session.session_id || genId(),
      openid: openid || "",
      app_id: appId || "miniprogram-kxm",
      brand: session.brand || "",
      model: session.model || "",
      platform: session.platform || "",
      os_version: session.system || "",
      cpu_type: session.cpu_type || "",
      wechat_version: session.wechat_version || "",
      sdk_version: session.sdk_version || "",
      renderer: session.renderer || "",
      network_type: session.network_type || "",
      env_version: session.env_version || "",
      app_version: session.app_version || "",
      launch_scene: session.launch_scene || 0,
      model_level: session.model_level || "",
      referrer_info: session.referrer_info || "",
      auth_notification: session.auth_notification ? 1 : 0,
      auth_album: session.auth_album ? 1 : 0,
      auth_camera: session.auth_camera ? 1 : 0,
      auth_location: session.auth_location ? 1 : 0,
      auth_mic: session.auth_mic ? 1 : 0,
      dark_mode: session.dark_mode ? 1 : 0,
      screen_w: session.screen_w || 0,
      screen_h: session.screen_h || 0,
      battery_level: session.battery_level != null ? Number(session.battery_level) : -1,
      is_charging: session.is_charging ? 1 : 0,
      payload: JSON.stringify(session),
    });
  } catch (e) {
    console.error("[events] 会话入库失败:", e.message);
  }
}

module.exports = { logEvent, logSession };
