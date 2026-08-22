/**
 * 订阅消息（第二阶段：模板 + 业务事件自动发送）
 *
 * 数据流（完整闭环）：
 *   业务事件 → 消息模板 → 用户订阅状态/次数 → 微信发送 → 消耗订阅次数 → 发送结果记录
 *
 * 第一阶段能力：用户主动订阅 + 次数记录（t_lp_subscribe_grants）
 * 第二阶段能力：审核结果通知等业务事件，按模板自动发送（t_lp_subscribe_sends）
 *
 * 模板配置：业务事件 → 模板ID 注册在 TEMPLATES（代码权威）；
 *          用户可订阅模板列表取自 t_apps.subscribe_tmpl_ids（后台「小程序配置」维护），
 *          为空时回退 TEMPLATES 注册表。
 * 凭证：access_token 走 t_apps.app_secret 获取，内存缓存（7200s 内提前 5 分钟过期）。
 */
const { db } = require("./db");
const { nowSql, withLock } = require("./utils");
const { getAppConfig } = require("./apps");
const { nextSeq } = require("./seq");

// ==================== 模板注册表（业务事件 → 模板ID） ====================
const TEMPLATES = {
  // 审核结果通知：审核类型(thing1) / 审核结果(phrase2) / 通知时间(time4) / 备注(thing3)
  review_result: "91HSfOQSSVKHPwT2oNM4NdGuKe9Gw1uY0VkLf_nyJ9I",
  // 打卡提醒：用户昵称(thing5) / 计划名称(thing1) / 完成进度(thing2) / 备注(thing3) / 截止时间(time8)
  checkin_remind: "aIReeE_R92te__wWL7EKRknaZ0pXhSJ2Kcct_rNWzVg",
};

/** 模板关键字类型约束（thing 类字段有长度与字符限制，超出/非法会 47003） */
const REVIEW_FIELDS = {
  thing1: { max: 20, def: "任务打卡审核" },
  phrase2: { max: 20, def: "审核通过" },
  time4: { max: 32, def: "" },
  thing3: { max: 20, def: "" },
};

// ==================== access_token（按 app 内存缓存） ====================
const tokenCaches = {};

async function getAccessToken(appId) {
  const key = appId || "miniprogram-kxm";
  const cfg = await getAppConfig(key);
  const appid = (cfg && cfg.wechat_appid) || "";
  const secret = (cfg && cfg.app_secret) || "";
  if (!appid || !secret) throw new Error("未配置小程序 AppSecret，无法发送订阅消息");
  const cache = tokenCaches[key] || { token: "", expiresAt: 0 };
  if (cache.token && Date.now() < cache.expiresAt) return cache.token;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data || !data.access_token) {
    throw new Error(`access_token 获取失败: ${data ? `${data.errcode} ${data.errmsg || ""}` : "空响应"}`);
  }
  const expiresMs = (Number(data.expires_in) || 7200) * 1000;
  tokenCaches[key] = { token: data.access_token, expiresAt: Date.now() + expiresMs - 300000 };
  return tokenCaches[key].token;
}

/** 调用微信订阅消息发送接口（POST /cgi-bin/message/subscribe/send） */
async function sendSubscribeMessage({ appId, openid, tmplId, page = "", data }) {
  const token = await getAccessToken(appId);
  const resp = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: openid,
        template_id: tmplId,
        page: String(page || "").slice(0, 255),
        data,
      }),
    }
  );
  return await resp.json();
}

// ==================== 订阅次数 ====================
/** 用户指定模板的可用次数（含第一阶段空模板授权，兼容历史数据） */
async function availableCount(staffId, tmplId) {
  try {
    const sid = Number(staffId) || 0;
    let q = db.from("subscribe_grants")
      .select("grant_count, used_count")
      .eq("staff_id", sid)
      .eq("grant_status", "active");
    if (tmplId) q = q.in("tmpl_id", [String(tmplId), ""]);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    return (data || []).reduce((sum, g) => sum + Math.max(0, (Number(g.grant_count) || 0) - (Number(g.used_count) || 0)), 0);
  } catch (e) {
    console.error("[subscribeLib] availableCount error", e.message);
    return 0;
  }
}

/**
 * 消耗一次订阅次数（FIFO，优先消耗最早授权；空模板授权视为任意模板可用）
 * 安全审计：读改写计数在进程内加锁串行化（@cloudbase RDB 无原子自增 API），防并发超额消耗
 * @returns {Promise<boolean>} 是否消耗成功（次数不足返回 false）
 */
async function consumeCredit(staffId, tmplId, count = 1) {
  const sid = Number(staffId) || 0;
  const need = Math.max(1, Number(count) || 1);
  return withLock(`subscribe:credit:${sid}`, async () => {
    try {
      let q = db.from("subscribe_grants")
        .select().eq("staff_id", sid).eq("grant_status", "active");
      if (tmplId) q = q.in("tmpl_id", [String(tmplId), ""]);
      const { data, error } = await q.order("created_at", { ascending: true }).limit(1000);
      if (error) throw error;
      const records = (data || []).filter(g => (Number(g.grant_count) || 0) > (Number(g.used_count) || 0));
      let remain = need;
      for (const g of records) {
        if (remain <= 0) break;
        const avail = (Number(g.grant_count) || 0) - (Number(g.used_count) || 0);
        const take = Math.min(avail, remain);
        const usedNow = (Number(g.used_count) || 0) + take;
        const status = usedNow >= (Number(g.grant_count) || 0) ? "consumed" : "active";
        await db.from("subscribe_grants").update({
          used_count: usedNow,
          grant_status: status,
          updated_at: nowSql(),
        }).eq("grant_id", g.grant_id);
        remain -= take;
      }
      return remain <= 0;
    } catch (e) {
      console.error("[subscribeLib] consumeCredit error", e.message);
      return false;
    }
  });
}

// ==================== 发送结果记录 ====================
async function logSend(rec) {
  try {
    const sendId = await nextSeq("subscribe_send_id");
    await db.from("subscribe_sends").insert({
      send_id: sendId,
      staff_id: Number(rec.staff_id) || 0,
      openid: String(rec.openid || "").slice(0, 64),
      app_id: String(rec.app_id || "miniprogram-kxm").slice(0, 32),
      tmpl_id: String(rec.tmpl_id || "").slice(0, 64),
      event_type: String(rec.event_type || "").slice(0, 24),
      biz_type: String(rec.biz_type || "").slice(0, 24),
      biz_id: String(rec.biz_id || "").slice(0, 64),
      page: String(rec.page || "").slice(0, 255),
      payload: rec.payload ? JSON.stringify(rec.payload) : null,
      send_status: String(rec.send_status || "sent").slice(0, 16),
      errcode: Number(rec.errcode) || 0,
      errmsg: String(rec.errmsg || "").slice(0, 255),
      credit_consumed: rec.credit_consumed ? 1 : 0,
      created_at: nowSql(),
    });
  } catch (e) {
    console.error("[subscribeLib] logSend error", e.message);
  }
}

// ==================== 审核结果通知 ====================
/** thing 类字段清洗：去非法字符 + 截断长度（避免 47003） */
function sanitizeThing(v, max, def) {
  let s = String(v || "")
    .trim()
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9·.,，。:：!！()（）【】\-]/g, "")
    .slice(0, max);
  if (!s) s = def;
  return s;
}

/** 组装审核结果通知的模板字段数据 */
function buildReviewData({ taskTitle, result, note }) {
  const accept = result === "approve";
  const noteText = note && String(note).trim();
  const remark = noteText || (accept ? "审核通过，任务已完成" : "请按反馈修改后重新打卡");
  const base3 = taskTitle ? `任务「${taskTitle}」：${remark}` : remark;
  return {
    thing1: { value: sanitizeThing("任务打卡审核", REVIEW_FIELDS.thing1.max, REVIEW_FIELDS.thing1.def) },
    phrase2: { value: accept ? "审核通过" : "审核不通过" },
    time4: { value: nowSql().slice(0, 16) },
    thing3: { value: sanitizeThing(base3, REVIEW_FIELDS.thing3.max, REVIEW_FIELDS.thing3.def) },
  };
}

/**
 * 发送「审核结果通知」给打卡提交人（fire-and-forget，不阻塞审核主流程）
 * 数据流：次数校验 → 微信发送 → 成功则消耗 1 次订阅 → 记录发送结果
 */
async function sendReviewNotification({ appId, openid, staffId, checkinId, taskId, taskTitle, result, note }) {
  const tmplId = TEMPLATES.review_result;
  const accept = result === "approve";
  const base = {
    staff_id: staffId,
    openid: openid || "",
    app_id: appId || "miniprogram-kxm",
    tmpl_id: tmplId,
    event_type: accept ? "review_approve" : "review_reject",
    biz_type: "task_checkin",
    biz_id: String(checkinId || taskId || ""),
    page: taskId ? `pkg-task/task-detail/task-detail?id=${Number(taskId) || ""}` : "",
  };

  if (!openid) {
    await logSend({ ...base, payload: null, send_status: "skip", errcode: -1, errmsg: "无收件人 openid", credit_consumed: 0 });
    return;
  }
  if ((await availableCount(staffId, tmplId)) <= 0) {
    await logSend({ ...base, payload: null, send_status: "skip", errcode: -1, errmsg: "订阅次数不足", credit_consumed: 0 });
    return;
  }

  const data = buildReviewData({ taskTitle, result, note });
  let resp = null;
  try {
    resp = await sendSubscribeMessage({ appId, openid, tmplId, page: base.page, data });
  } catch (e) {
    await logSend({ ...base, payload: data, send_status: "failed", errcode: -2, errmsg: String(e.message || "").slice(0, 255), credit_consumed: 0 });
    return;
  }

  const errcode = Number(resp && resp.errcode);
  if (errcode === 0) {
    await consumeCredit(staffId, tmplId, 1);
    await logSend({ ...base, payload: data, send_status: "sent", errcode: 0, errmsg: "ok", credit_consumed: 1 });
  } else {
    await logSend({ ...base, payload: data, send_status: "failed", errcode, errmsg: String((resp && resp.errmsg) || "").slice(0, 255), credit_consumed: 0 });
  }
}

// ==================== 打卡提醒（定时任务触发） ====================
/** 组装打卡提醒的模板字段数据 */
function buildRemindData({ taskTitle, deadline, checkinCount, nickname }) {
  const progress = checkinCount > 0 ? `已打卡 ${checkinCount} 次` : "尚未开始打卡";
  const remark = checkinCount > 0 ? "今天还没打卡，记得完成" : "今日还未打卡，尽快完成";
  return {
    thing5: { value: sanitizeThing(nickname || "同学", 20, "同学") },
    thing1: { value: sanitizeThing(taskTitle, 20, "学习任务") },
    thing2: { value: sanitizeThing(progress, 20, "尚未开始打卡") },
    thing3: { value: sanitizeThing(remark, 20, "记得打卡") },
    time8: { value: String(deadline || "").slice(0, 10) },
  };
}

/**
 * 发送「打卡提醒」给学生（定时任务按天调用）
 * 数据流：次数校验 → 微信发送 → 成功则消耗 1 次订阅 → 记录发送结果
 * @returns {Promise<{skipped: boolean}>} skipped=true 表示未真正发送（无 openid/次数不足/失败）
 */
async function sendCheckinRemind({ appId, openid, staffId, taskId, taskTitle, deadline, checkinCount, nickname }) {
  const tmplId = TEMPLATES.checkin_remind;
  const base = {
    staff_id: staffId,
    openid: openid || "",
    app_id: appId || "miniprogram-kxm",
    tmpl_id: tmplId,
    event_type: "checkin_remind",
    biz_type: "task",
    biz_id: String(taskId || ""),
    page: taskId ? `pkg-task/task-detail/task-detail?id=${Number(taskId) || ""}` : "",
  };

  if (!openid) {
    await logSend({ ...base, payload: null, send_status: "skip", errcode: -1, errmsg: "无收件人 openid", credit_consumed: 0 });
    return { skipped: true };
  }
  if ((await availableCount(staffId, tmplId)) <= 0) {
    await logSend({ ...base, payload: null, send_status: "skip", errcode: -1, errmsg: "订阅次数不足", credit_consumed: 0 });
    return { skipped: true };
  }

  const data = buildRemindData({ taskTitle, deadline, checkinCount, nickname });
  let resp = null;
  try {
    resp = await sendSubscribeMessage({ appId, openid, tmplId, page: base.page, data });
  } catch (e) {
    await logSend({ ...base, payload: data, send_status: "failed", errcode: -2, errmsg: String(e.message || "").slice(0, 255), credit_consumed: 0 });
    return { skipped: true };
  }

  const errcode = Number(resp && resp.errcode);
  if (errcode === 0) {
    await consumeCredit(staffId, tmplId, 1);
    await logSend({ ...base, payload: data, send_status: "sent", errcode: 0, errmsg: "ok", credit_consumed: 1 });
    return { skipped: false };
  }
  await logSend({ ...base, payload: data, send_status: "failed", errcode, errmsg: String((resp && resp.errmsg) || "").slice(0, 255), credit_consumed: 0 });
  return { skipped: true };
}

module.exports = {
  TEMPLATES,
  getAccessToken,
  availableCount,
  consumeCredit,
  sendReviewNotification,
  sendCheckinRemind,
};
