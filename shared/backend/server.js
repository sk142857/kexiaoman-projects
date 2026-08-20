/**
 * 共享云托管服务入口（多小程序共用）
 *
 * 小程序端通过 wx.cloud.callContainer 直调本服务，
 * 请求头 X-WX-OPENID / X-WX-APPID 由微信云托管网关自动注入。
 */
const express = require("express");

const userRouter = require("./routes/user");
const systemRouter = require("./routes/system");
const analyticsRouter = require("./routes/analytics");
const storageRouter = require("./routes/storage");
const { router: lpAuthRouter, lpAuth, verifyLpToken } = require("./routes/lpAuth");
const lpRouter = require("./routes/lp");
const familyRouter = require("./routes/family");
const { router: adminRouter } = require("./routes/admin");
const { startMonitor } = require("./monitor");
const { startReminder } = require("./reminder");
const { traceMiddleware } = require("./trace");
const { resolveApp, ensureAppInDb } = require("./apps");
const { normalizeOpenid } = require("./appAuth");

const app = express();

// ==================== 全局兜底：未捕获异常/拒绝只记日志，不让单点错误拖垮整个服务 ====================
process.on("unhandledRejection", (reason) => {
  console.error("[global] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[global] uncaughtException", err && err.stack ? err.stack : err);
});

// ==================== 后台管理静态资源（React 构建产物）+ SPA fallback ====================
const path = require("path");
const adminStatic = express.static(path.join(__dirname, "public", "admin"));
app.use("/admin", (req, res, next) => {
  // 浏览器导航（Accept: text/html）走 SPA；axios 数据请求（Accept: json/*）走业务路由，
  // 避免 dashboard 等 GET API 被 SPA fallback 遮蔽，同时保留前端路由刷新
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  const isApi = req.path.startsWith("/api/")
    || (req.path.startsWith("/dashboard/") && !wantsHtml)
    || req.path === "/me"
    || req.path === "/menus"
    || req.path === "/menus/all"
    || req.path === "/myApps"
    || (req.method === "POST" && req.path.startsWith("/login"));
  if (isApi) return next();
  adminStatic(req, res, (err) => {
    if (err) return next(err);
    // 静态未命中 → 返回 SPA index.html（支持前端路由刷新）
    if (req.method === "GET" && !res.headersSent) {
      return res.sendFile(path.join(__dirname, "public", "admin", "index.html"));
    }
    next();
  });
});

// 宽松 JSON 解析：GET 跳过，避免 callContainer 的 GET+json 触发 400；解析错误返回明确信息
// limit 30mb：图片走 base64 JSON 上传（前端选原图 → 后端压缩），单图上限 20MB，
// base64 膨胀约 1/3，兜底放宽到 30mb 以覆盖 20MB 原图
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  express.json({ strict: false, limit: '30mb' })(req, res, (err) => {
    if (err) {
      console.error('[json] body 解析失败', err.message);
      return res.status(200).json({ code: 400, msg: '请求体解析失败：' + err.message, data: null });
    }
    next();
  });
});

const PORT = process.env.PORT || 80;

// ==================== 健康检查（探活不需要 openid，放在鉴权前） ====================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "kxm-service", time: new Date().toISOString() });
});

app.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

// ==================== 后台管理路由（独立 JWT 鉴权，不走 openid） ====================
app.use("/admin", adminRouter);

// ==================== 身份确认 + 小程序应用解析中间件 ====================
// 微信云托管在 callContainer 请求注入 X-WX-OPENID / X-WX-APPID，但服务同时公开托管后台 SPA，
// 直接访问者可以伪造该头冒充任意用户（见安全审计 S1）。因此共享 /api/* 路由**不再信任身份头**，
// 统一以 X-LP-Token（LP 会话 JWT，服务端签发）验签后取 openid；无有效会话一律 401。
// 多小程序共享环境：按 X-WX-APPID 解析 app_id（仅用于展示/落库，不承载身份）；
// 共享环境下 X-WX-OPENID 可能带 "{AppID}_" 前缀，统一剥离为规范 openid（兼容历史数据）。
// 仅对业务 /api/* 生效，避免 /favicon.ico 等非接口请求被 401 拦截
app.use(async (req, res, next) => {
  // /api/lp/* 为课小满接口（走 LP JWT，见 lpAuth），身份取自 JWT，不在此处理
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/lp/")) return next();
  const lpHeader = req.headers["x-lp-token"] || "";
  const auth = req.headers.authorization || "";
  const token = lpHeader || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const session = await verifyLpToken(token);
  if (!session || !session.openid) {
    return res.status(401).json({ code: 401, msg: "未授权：会话无效或已过期", data: null });
  }
  let app = null;
  try {
    app = await resolveApp(req);
  } catch (_) { /* 忽略，走默认 */ }
  if (app) {
    try { await ensureAppInDb(app); } catch (_) { /* 忽略 */ }
  }
  const wechatAppid = (app && app.wechat_appid) || "";
  const openid = normalizeOpenid(session.openid, wechatAppid);
  req.openid = openid;
  req.app = app || { app_id: session.appId || "miniprogram-kxm", app_name: "课小满", wechat_appid: "" };
  req.appId = req.app.app_id;
  next();
});

// ==================== 接口链路追踪（在鉴权后） ====================
app.use(traceMiddleware);

// ==================== 课小满路由（环境内直调，LP JWT，不依赖 openid 头） ====================
// 登录/绑定为公开接口；其余业务接口统一过 lpAuth（每次请求实时复核邀请码状态，作废即锁）
app.use("/api/lp", lpAuthRouter);
app.use("/api/lp", lpAuth, lpRouter);
app.use("/api/lp", lpAuth, familyRouter);

// ==================== 业务路由 ====================
app.use("/api/user", userRouter);
app.use("/api/system", systemRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/storage", storageRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ code: 404, msg: "接口不存在", data: null });
});

app.listen(PORT, () => {
  console.log(`[cloudrun] kxm-service listening on port ${PORT}`);
  // 每 10 分钟采集一次服务监控（内存/CPU/句柄），写入 service_monitor 表
  startMonitor();
  // 打卡提醒定时任务（每天提醒窗口内扫描发送，进程内定时器）
  startReminder();
});
