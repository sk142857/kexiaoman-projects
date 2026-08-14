/**
 * 数据采集路由（@cloudbase/js-sdk RDB MySQL）
 * 将会话画像常用字段拆分为独立列，同时保留原始 payload
 */
const express = require("express");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { reportTrace } = require("../trace");
const { genId, nowSql } = require("../utils");

const router = express.Router();

// 会话 ID 兜底（前端缺失时生成，保证主键非空）
function genSessionId() {
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

// ==================== 采集会话画像 ====================
router.post("/collectSession", async (req, res) => {
  try {
    const s = req.body.session || {};
    await db.from("user_sessions").insert({
      session_id: s.session_id || genSessionId(),
      openid: req.openid,
      app_id: req.appId || "learning-planet",
      brand: s.brand || "",
      model: s.model || "",
      platform: s.platform || "",
      os_version: s.system || "",
      cpu_type: s.cpu_type || "",
      wechat_version: s.wechat_version || "",
      sdk_version: s.sdk_version || "",
      renderer: s.renderer || "",
      network_type: s.network_type || "",
      env_version: s.env_version || "",
      app_version: s.app_version || "",
      launch_scene: s.launch_scene || 0,
      model_level: s.model_level || "",
      referrer_info: s.referrer_info || "",
      auth_notification: s.auth_notification ? 1 : 0,
      auth_album: s.auth_album ? 1 : 0,
      auth_camera: s.auth_camera ? 1 : 0,
      auth_location: s.auth_location ? 1 : 0,
      auth_mic: s.auth_mic ? 1 : 0,
      dark_mode: s.dark_mode ? 1 : 0,
      screen_w: s.screen_w || 0,
      screen_h: s.screen_h || 0,
      battery_level: s.battery_level != null ? s.battery_level : -1,
      is_charging: s.is_charging ? 1 : 0,
      payload: JSON.stringify(s),
    });
    res.json(ok(null, "已上报"));
  } catch (e) {
    console.error("[analytics] collectSession error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 接口链路：前端上报补全耗时 ====================
router.post("/reportTrace", async (req, res) => {
  try {
    const { requestId, clientCostMs } = req.body;
    if (!requestId || clientCostMs == null) return res.json(fail("缺少参数"));
    await reportTrace(requestId, clientCostMs);
    res.json(ok(null, "已记录"));
  } catch (e) {
    console.error("[analytics] reportTrace error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 用户操作事件埋点（点击菜单/页面等） ====================
router.post("/collectEvent", async (req, res) => {
  try {
    const { eventType, eventName, pagePath, bizId, extra } = req.body || {};
    if (!eventType || !eventName) return res.json(fail("缺少事件参数"));
    await db.from("user_events").insert({
      event_id: genId(),
      openid: req.openid,
      app_id: req.appId || "learning-planet",
      event_type: String(eventType).slice(0, 24),
      event_name: String(eventName).slice(0, 64),
      page_path: String(pagePath || "").slice(0, 128),
      biz_id: String(bizId || "").slice(0, 64),
      extra: extra ? JSON.stringify(extra) : null,
      client_at: nowSql(),
    });
    res.json(ok(null, "已记录"));
  } catch (e) {
    console.error("[analytics] collectEvent error", e);
    res.json(fail("服务异常", 500));
  }
});

module.exports = router;
