/**
 * 数据采集路由（@cloudbase/js-sdk RDB MySQL）
 * 将会话画像常用字段拆分为独立列，同时保留原始 payload
 */
const express = require("express");
const { ok, fail } = require("../response");
const { reportTrace } = require("../trace");
const { logEvent, logSession } = require("../events");

const router = express.Router();

// ==================== 采集会话画像 ====================
router.post("/collectSession", (req, res) => {
  logSession({ appId: req.appId, openid: req.openid, session: req.body.session || {} });
  res.json(ok(null, "已上报"));
});

// ==================== 接口链路：前端上报补全耗时 ====================
router.post("/reportTrace", (req, res) => {
  const { requestId, clientCostMs } = req.body;
  if (!requestId || clientCostMs == null) return res.json(fail("缺少参数"));
  reportTrace(requestId, clientCostMs);
  res.json(ok(null, "已记录"));
});

// ==================== 用户操作事件埋点（点击菜单/页面等） ====================
router.post("/collectEvent", (req, res) => {
  const { eventType, eventName, pagePath, bizId, extra } = req.body || {};
  if (!eventType || !eventName) return res.json(fail("缺少事件参数"));
  logEvent({
    appId: req.appId,
    openid: req.openid,
    eventType,
    eventName,
    pagePath,
    bizId,
    extra,
  });
  res.json(ok(null, "已记录"));
});

module.exports = router;
