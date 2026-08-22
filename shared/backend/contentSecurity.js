/**
 * 内容安全审核（旁路模块，与业务链路完全隔离）
 *
 * 设计目标：
 *  - 业务写路径不改：本模块只在「共享媒体登记层 + 文本写路由」处 fire-and-forget 挂钩，
 *    检测失败/关闭一律不影响业务（fail-open + 打卡人工审核兜底）。
 *  - 独立侧表 t_content_audits：检测结果不写任何业务表；读路径用 mergeAudit 派生展示级别。
 *  - 全局开关：t_apps.content_security 存 JSON（{"enabled":true,"scene":2}），
 *    关闭 = 入队/worker/merge 全链路短路，出参与接入前逐字节一致。
 *  - 媒体路径漂移：图片/视频后台压缩会换新路径并删原文件，压缩完成后 repointAudit
 *    把审核记录重指到新路径（结果随文件走，不重复检测）。
 *  - 判级策略：仅微信接口 result.label=100 视为通过，其余一律 reject 拦截（疑似也拦截）。
 *  - 原始返回审计：微信接口完整返回 JSON 存 wx_raw，供后台「内容安全」详情抽屉展示。
 *
 * 检测接口（微信官方内容安全）：
 *  - 文本：security.msgSecCheck v2（同步）
 *  - 图片：security.imgSecCheck（同步，≤1MB，先 sharp 压尺寸）
 *  - 音频：security.mediaCheckAsync（异步，提交 trace_id 后轮询）
 *  - 视频：mediaCheckAsync 不支持视频，改为 ffmpeg 抽 3 帧 → imgSecCheck（覆盖画面）
 *
 * 隔离说明：本模块不依赖业务路由，仅依赖 db / apps / seq / subscribeLib(getAccessToken)。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const sharp = require("sharp");
const { db } = require("./db");
const { getAppConfig } = require("./apps");
const { getAccessToken } = require("./subscribeLib");
const { nextSeq } = require("./seq");
const { nowSql, genId } = require("./utils");
const { notifyContentViolation } = require("./notificationLib");

const execFileP = promisify(execFile);

// ==================== 常量 ====================
const WX_MSG_SEC_CHECK = "https://api.weixin.qq.com/wxa/msg_sec_check";
const WX_IMG_SEC_CHECK = "https://api.weixin.qq.com/wxa/img_sec_check";
const WX_MEDIA_CHECK_ASYNC = "https://api.weixin.qq.com/wxa/media_check_async";

// imgSecCheck 要求：≤1MB，尺寸 100x100 ~ 750x1334
const IMG_MIN_SIZE = 100;
const IMG_MAX_EDGE = 750;
const IMG_MAX_HEIGHT = 1334;
const IMG_MAX_BYTES = 1024 * 1024;
// mediaCheckAsync 音频要求 ≤20MB
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
// 视频抽帧张数（首/中/尾）
const VIDEO_FRAMES = 3;
// 文本最长（msgSecCheck v2 上限 2500 字符）
const TEXT_MAX_LEN = 2500;
// worker 每轮批处理量（免费额度 300 次/分，轮询 15s/轮，批 20 足够）
const BATCH_SIZE = 20;

// ==================== 开关（读 t_apps.content_security JSON，getAppConfig 已缓存 60s） ====================

/** 读取小程序内容安全配置；解析失败/未配置一律视为关闭（fail-safe） */
async function readSecurityCfg(appId) {
  const key = appId || "miniprogram-kxm";
  try {
    const cfg = await getAppConfig(key);
    const cs = JSON.parse((cfg && cfg.content_security) || "{}");
    return { enabled: !!cs.enabled, scene: Number(cs.scene) || 2 };
  } catch (_) {
    return { enabled: false, scene: 2 };
  }
}

/** 当前是否开启内容安全（失败一律 false，保证关闭=零影响） */
async function securityEnabled(appId) {
  try {
    const c = await readSecurityCfg(appId);
    return !!c.enabled;
  } catch (_) {
    return false;
  }
}

/** MIME → media_type（2 图片 / 3 音频 / 4 视频 / 0 不支持） */
function mediaTypeOf(contentType) {
  const t = String(contentType || "");
  if (/^image\//i.test(t)) return 2;
  if (/^audio\//i.test(t)) return 3;
  if (/^video\//i.test(t)) return 4;
  return 0;
}

// ==================== 入队（fire-and-forget，内部捕获异常，绝不抛给业务） ====================

/**
 * 提交一条内容审核任务
 * @param {object} p
 * @param {string} [p.appId] 小程序 app_id（默认 miniprogram-kxm）
 * @param {string} p.bizType 业务类型 task/checkin/profile/collection/review_note/file（file=媒体）
 * @param {string|number} [p.bizId] 业务ID（媒体=biz_id 存 file_path）
 * @param {string} [p.field] 字段名（文本用，如 title/description/checkin_note）
 * @param {number} [p.mediaType] 1文本 2图片 3音频 4视频
 * @param {string} [p.content] 文本内容（文本）或文件相对路径（媒体）
 * @param {string} [p.openid] 提交用户 openid
 */
async function submitForAudit({ appId, bizType, bizId, field = "", mediaType = 1, content = "", openid = "", status = "", detail = "", wx_raw = null } = {}) {
  try {
    const app = appId || "miniprogram-kxm";
    if (!(await securityEnabled(app))) return;
    const mt = Number(mediaType) || 1;
    // 媒体 biz_id 存 file_path（最长约 50 字符）；文本 biz_id 存业务 ID。统一按列宽 128 截断，避免路径被截导致读侧匹配不上
    const id = String(bizId == null ? "" : bizId).slice(0, 128);
    const raw = String(content || "");
    if (mt === 1) {
      const text = raw.trim();
      if (!text) return;
      if (text.length > TEXT_MAX_LEN) content = text.slice(0, TEXT_MAX_LEN);
      else content = text;
      if (!id || !field) return;
    } else {
      const p = String(raw || "").trim();
      if (!p) return;
      content = p.slice(0, 500);
    }
    if (!bizType) return;

    // 去重：同 key 已有 pending 任务则跳过（编辑后重新提交会新建记录，保持可审计）
    let q = db.from("content_audits").select("audit_id")
      .eq("biz_type", String(bizType).slice(0, 24))
      .eq("biz_id", id);
    if (mt === 1) q = q.eq("field", String(field).slice(0, 32)).eq("media_type", 1);
    const { data, error } = await q.eq("status", "pending").limit(5);
    if (!error && data && data.length > 0) return;

    const auditId = await nextSeq("content_audit_id");
    const base = {
      audit_id: auditId,
      app_id: app,
      biz_type: String(bizType).slice(0, 24),
      biz_id: id,
      field: mt === 1 ? String(field).slice(0, 32) : "",
      media_type: mt,
      content: String(content).slice(0, 2000),
      openid: String(openid || "").slice(0, 64),
      enqueued_at: nowSql(),
    };
    if (status && ["pass", "reject", "risk", "skip"].includes(status)) {
      // 写时校验预检结果直接落库（如昵称/头像），不进 worker 重复检测
      base.status = status;
      base.detail = String(detail || "").slice(0, 500);
      base.detected_at = nowSql();
      if (wx_raw != null) base.wx_raw = typeof wx_raw === "string" ? wx_raw : JSON.stringify(wx_raw);
      await db.from("content_audits").insert(base);
      return;
    }
    base.status = "pending";
    base.retries = 0;
    await db.from("content_audits").insert(base);
  } catch (e) {
    console.error("[security] submitForAudit error", e.message);
  }
}

/** 媒体压缩后路径漂移：把审核记录从旧路径重指到新路径（结果随文件走，不重复检测） */
async function repointAudit(oldPath, newPath) {
  try {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const { error } = await db.from("content_audits")
      .update({ biz_id: String(newPath), content: String(newPath) })
      .eq("biz_type", "file").eq("biz_id", String(oldPath));
    if (error) throw error;
  } catch (e) {
    console.error("[security] repointAudit error", e.message);
  }
}

// ==================== 读时合并（唯一与业务展示耦合的点，失败透传） ====================

/** 数组分块 */
function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 给一批已序列化的业务记录派生内容安全展示级别（原地修改并返回）。
 * 门控依据：记录自带 risk_status（worker 实时回写，业务表承载）：
 *  - reject → 全量脱敏（文本 ****、图片/音视频置空），display=audit_rejected
 *  - pending → 内容可见 + 逐张图片磨砂加锁（仅检测中的图），display=audit_reviewing
 *  - pass / 缺失 → display=full
 *  - 安全关闭 / 检测失败 → 原样透传，不带任何 display 字段（前端零感知）
 * @param {Array<object>} records 已序列化的记录数组（须带 risk_status 字段）
 * @param {object} cfg
 * @param {string} cfg.appId 小程序 app_id
 * @param {string} cfg.bizType 业务类型（task/checkin/...）
 * @param {(r)=>string|number} cfg.bizId 取记录业务 ID
 * @param {Array<{field:string,get:(r)=>string}>} [cfg.texts] 文本字段
 * @param {Array<{field:string,get:(r)=>string|string[]}>} [cfg.media] 媒体字段（数组或单路径）
 */
async function mergeAudit(records, cfg) {
  try {
    if (!cfg || !Array.isArray(records) || records.length === 0) return records;
    if (!(await securityEnabled(cfg.appId))) return records;
    const texts = cfg.texts || [];
    const media = cfg.media || [];
    const bizType = String(cfg.bizType || "");
    if (!bizType) return records;

    // 1) 记录级门控：reject 全脱敏；pending 收集；其余 full
    const pendingRecs = [];
    for (const r of records) {
      const rs = String(r.risk_status || "pass");
      if (rs === "reject") {
        maskRecord(r, texts, media);
        r.display = "audit_rejected";
        r.audit_notice = "部分内容未通过安全检测";
      } else if (rs === "pending") {
        pendingRecs.push(r);
      } else {
        r.display = "full";
        r.audit_notice = "";
      }
    }

    // 2) pending 记录：逐张图片查侧表状态（媒体审核行 content=路径，按 biz_type+content 唯一定位）
    if (pendingRecs.length > 0) {
      const pathSet = new Set();
      pendingRecs.forEach((r) => {
        media.forEach((m) => {
          if (!m.get) return;
          const v = m.get(r);
          if (Array.isArray(v)) v.forEach((p) => { if (p) pathSet.add(String(p)); });
        });
      });
      const statusMap = {};
      // 分块并行查询，每块 limit 收敛（不再 5000 + 全局排序），去重取每个 content 最新一行
      await Promise.all(chunkArr([...pathSet], 200).map(async (chunk) => {
        const { data, error } = await db.from("content_audits")
          .select("content, status")
          .eq("biz_type", bizType).in("content", chunk)
          .order("audit_id", { ascending: false }).limit(chunk.length * 3);
        if (error) throw error;
        const seen = new Set();
        (data || []).forEach((row) => {
          if (!seen.has(row.content)) { seen.add(row.content); statusMap[row.content] = row.status; }
        });
      }));
      pendingRecs.forEach((r) => {
        media.forEach((m) => {
          const v = m.get(r);
          if (Array.isArray(v)) {
            r[m.field + "_states"] = v.filter(Boolean).map((p) => (statusMap[String(p)] === "pending" ? "reviewing" : "ok"));
          }
        });
        r.display = "audit_reviewing";
        r.audit_notice = "内容安全检测中";
      });
    }
    return records;
  } catch (e) {
    console.error("[security] mergeAudit error", e.message);
    return records; // 失败降级：透传
  }
}

/** 全量脱敏一条记录（reject 门控） */
function maskRecord(r, texts, media) {
  texts.forEach((t) => { r[t.field] = "****"; });
  media.forEach((m) => {
    const v = m.get(r);
    if (Array.isArray(v)) { r[m.field] = []; r[m.field + "_states"] = []; }
    else r[m.field] = "";
  });
}

// ==================== 微信官方接口调用 ====================

function statusFromSuggest(suggest) {
  const s = String(suggest || "").toLowerCase();
  if (s === "risky") return "reject";
  if (s === "review") return "risk";
  return "pass";
}

/**
 * 解析微信内容安全接口返回：
 *  - 有 result.suggest → 按 suggest 归一化（risky→reject / review→risk / pass→pass）
 *  - errcode 87014（命中敏感内容但未带 result）→ reject
 *  - errcode 0 无 result → pass（fail-open）
 *  - 其余 errcode → null（硬错误，调用方抛错走重试/降级）
 */
function wxStatus(data) {
  const result = data && data.result;
  if (result && result.suggest) return statusFromSuggest(result.suggest);
  const err = Number(data && data.errcode) || 0;
  if (err === 87014) return "reject";
  if (err === 0) return "pass";
  return null;
}

/**
 * 判定结果（业务策略：仅 label=100 通过，其余一律违规拦截）：
 *  - 有 result.label → Number(label)===100 ? pass : reject（含疑似 review 一律 reject）
 *  - 无 label → 按 suggest 归一化（pass→pass；risky/review→reject）
 *  - 无 result → errcode 兜底（87014→reject；0→pass；其余→null 硬错误）
 */
function verdictFromWx(data) {
  const result = data && data.result;
  if (result && result.label !== undefined && result.label !== null) {
    return Number(result.label) === 100 ? "pass" : "reject";
  }
  const s = String((result && result.suggest) || "").toLowerCase();
  if (s === "pass") return "pass";
  if (s === "risky" || s === "review") return "reject";
  return wxStatus(data);
}

/** 记录一条最终结论（raw=微信接口完整返回，JSON 存 wx_raw 供后台审计） */
async function finalize(row, status, detail, raw) {
  const s = ["pass", "reject", "risk", "skip"].includes(status) ? status : "skip";
  const values = { status: s, detail: String(detail || "").slice(0, 500), detected_at: nowSql(), next_poll_at: null };
  if (raw !== undefined) {
    values.wx_raw = raw == null ? null : (typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  const { error } = await db.from("content_audits")
    .update(values)
    .eq("audit_id", row.audit_id);
  if (error) throw error;
  // 业务风险状态即时回写（task/checkin 直接定位；file 解析引用该媒体的业务记录）
  await syncAfterFinalize(row).catch((e) => console.error("[security] syncAfterFinalize error", e.message));
}

/** 解析引用某媒体路径的业务记录（任务图/打卡图/语音/视频/封面）；仅用于旧模型遗留数据对账 */
async function resolveMediaRecords(path) {
  const p = String(path || "");
  if (!p) return [];
  const out = [];
  const seen = new Set();
  const push = (bizType, bizId) => {
    const k = `${bizType}:${String(bizId)}`;
    if (!seen.has(k)) { seen.add(k); out.push({ bizType, bizId: String(bizId) }); }
  };
  try {
    const { data: tRows } = await db.from("tasks").select("task_id").like("images", `%${p}%`).limit(50);
    (tRows || []).forEach((t) => push("task", t.task_id));
  } catch (_) {}
  try {
    const [r1, r2, r3, r4] = await Promise.all([
      db.from("task_checkins").select("checkin_id").like("checkin_images", `%${p}%`).limit(50),
      db.from("task_checkins").select("checkin_id").eq("voice_url", p).limit(50),
      db.from("task_checkins").select("checkin_id").eq("video_url", p).limit(50),
      db.from("task_checkins").select("checkin_id").eq("video_cover", p).limit(50),
    ]);
    [...(r1.data || []), ...(r2.data || []), ...(r3.data || []), ...(r4.data || [])]
      .forEach((c) => push("checkin", c.checkin_id));
  } catch (_) {}
  return out;
}

/**
 * 媒体审核行归属重绑：上传登记时无法知道业务记录（biz_type='file'/路径），
 * 业务创建/编辑时调用本函数把媒体审核行归属到真实业务记录（biz_type=checkin/task，biz_id=业务ID）。
 */
async function rebindAudit({ bizType, bizId, paths }) {
  try {
    if (!paths || paths.length === 0 || bizId == null) return;
    if (bizType !== "task" && bizType !== "checkin") return;
    const bid = String(bizId);
    const list = paths.map((p) => String(p).replace(/^\/+/, "")).filter(Boolean);
    if (list.length === 0) return;
    for (const chunk of chunkArr(list, 200)) {
      const { error } = await db.from("content_audits")
        .update({ biz_type: bizType, biz_id: bid, field: "" })
        .eq("biz_type", "file").in("biz_id", chunk);
      if (error) throw error;
    }
  } catch (e) {
    console.error("[security] rebindAudit error", e.message);
  }
}

/**
 * 聚合回写业务记录 risk_status（立即对业务状态做处理）：
 *  - 该记录全部审核行（文本 + 媒体，均按 biz_type+biz_id 定位）中任一 reject/risk → reject
 *  - 否则任一 pending → pending；否则 pass
 *  - 业务表：t_lp_tasks.risk_status / t_lp_task_checkins.risk_status
 */
async function syncRecordRisk({ bizType, bizId, appId }) {
  try {
    if (!bizType || bizId == null) return;
    if (bizType !== "task" && bizType !== "checkin") return;
    const bid = String(bizId);
    // 短路判断：任一 reject/risk → reject；否则任一 pending → pending；否则 pass（3 次 limit(1) 并行，不拉全量状态）
    const [rejRes, riskRes, pendRes] = await Promise.all([
      db.from("content_audits").select("status").eq("biz_type", bizType).eq("biz_id", bid).eq("status", "reject").limit(1),
      db.from("content_audits").select("status").eq("biz_type", bizType).eq("biz_id", bid).eq("status", "risk").limit(1),
      db.from("content_audits").select("status").eq("biz_type", bizType).eq("biz_id", bid).eq("status", "pending").limit(1),
    ]);
    let risk = "pass";
    if ((rejRes.data && rejRes.data[0]) || (riskRes.data && riskRes.data[0])) risk = "reject";
    else if (pendRes.data && pendRes.data[0]) risk = "pending";
    const table = bizType === "task" ? "tasks" : "task_checkins";
    const keyCol = bizType === "task" ? "task_id" : "checkin_id";
    const num = Number(bid);
    const keyVal = Number.isFinite(num) ? num : bid;
    // 读取当前业务记录（旧风险状态 + 归属学生 + 任务标题），用于违规首次命中时发系统通知
    let record = null;
    try {
      const { data: recRows } = await db.from(table).select().eq(keyCol, keyVal).limit(1);
      record = recRows && recRows[0];
    } catch (_) {}
    const oldRisk = record ? String(record.risk_status || "") : "";
    await db.from(table).update({ risk_status: risk }).eq(keyCol, keyVal);
    // 系统通知：风险首次转入「违规」时通知提交学生 + 家长/家属（站内信；幂等：仅 old→reject 转换才发）
    if (risk === "reject" && oldRisk !== "reject" && record) {
      const createdBy = Number(record.created_by);
      let taskTitle = bizType === "task" ? String(record.title || "") : "";
      if (bizType === "checkin") {
        try {
          const { data: tRows } = await db.from("tasks").select("title").eq("task_id", Number(record.task_id)).limit(1);
          if (tRows && tRows[0]) taskTitle = tRows[0].title || "";
        } catch (_) {}
      }
      if (createdBy > 0) {
        notifyContentViolation({
          appId: appId || "miniprogram-kxm",
          studentStaffId: createdBy,
          taskTitle,
          bizName: bizType === "task" ? "任务" : "打卡",
          bizType,
          bizId: bid,
        }).catch((e) => console.error("[security] notifyContentViolation error", e.message));
      }
    }
  } catch (e) {
    console.error("[security] syncRecordRisk error", e.message);
  }
}

/** 审核行终态后：重读当前业务归属（媒体行可能已被 rebindAudit 归属到业务记录），回写 risk_status */
async function syncAfterFinalize(row) {
  try {
    if (!row) return;
    const { data } = await db.from("content_audits")
      .select("biz_type, biz_id, app_id").eq("audit_id", row.audit_id).limit(1);
    const cur = (data && data[0]) || row;
    if (cur.biz_type === "task" || cur.biz_type === "checkin") {
      await syncRecordRisk({ bizType: cur.biz_type, bizId: cur.biz_id, appId: cur.app_id });
    }
  } catch (e) {
    console.error("[security] syncAfterFinalize error", e.message);
  }
}

/** 失败退避：重试不足则延后，超限则 skip（fail-open） */
async function bumpRetry(row, errMsg) {
  const retries = (Number(row.retries) || 0) + 1;
  if (retries >= 3) {
    console.error("[security] 检测失败自动跳过", row.audit_id, errMsg);
    await finalize(row, "skip", `检测失败自动跳过: ${String(errMsg).slice(0, 200)}`);
    return;
  }
  await db.from("content_audits")
    .update({ retries, next_poll_at: nowSql(new Date(Date.now() + 60 * 1000)) })
    .eq("audit_id", row.audit_id);
}

/** 文本检测（msgSecCheck v2，同步），返回 { status, data }；硬错误抛出；安全关闭返回 skipped */
async function textCheckNow({ appId, content, openid, scene }) {
  if (!(await securityEnabled(appId))) return { status: "pass", skipped: true };
  const cfg = await readSecurityCfg(appId);
  const token = await getAccessToken(appId);
  const resp = await fetch(
    `${WX_MSG_SEC_CHECK}?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(content || "").slice(0, TEXT_MAX_LEN), version: 2, scene: scene || cfg.scene, openid: openid || "" }),
    }
  );
  const data = await resp.json();
  const status = verdictFromWx(data);
  if (status === null) throw new Error(`msgSecCheck ${data.errcode} ${data.errmsg || ""}`);
  return { status, data };
}

/** 图片检测（imgSecCheck，同步；下载→压缩→检测），返回 { status, data }；硬错误抛出；安全关闭返回 skipped */
async function imageCheckNow({ appId, path }) {
  if (!(await securityEnabled(appId))) return { status: "pass", skipped: true };
  const { publicUrl } = require("./storage");
  const resp = await fetch(publicUrl(path));
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
  const orig = Buffer.from(await resp.arrayBuffer());
  if (orig.length === 0) throw new Error("图片内容为空");
  const { buffer, tooSmall } = await shrinkImage(orig);
  if (tooSmall) return { status: "pass", data: null };
  const { status, data } = await imgSecCheckCall({ appId, buffer });
  return { status, data };
}

/** imgSecCheck 调用（buffer 须已按 ≤1MB 压缩），返回 { status, data } */
async function imgSecCheckCall({ appId, buffer }) {
  const token = await getAccessToken(appId);
  const fd = new FormData();
  fd.append("media", new Blob([buffer], { type: "image/jpeg" }), "media.jpg");
  const r2 = await fetch(`${WX_IMG_SEC_CHECK}?access_token=${encodeURIComponent(token)}`, { method: "POST", body: fd });
  const data = await r2.json();
  const status = verdictFromWx(data);
  if (status === null) throw new Error(`imgSecCheck ${data.errcode} ${data.errmsg || ""}`);
  return { status, data };
}

/** 文本检测（msgSecCheck v2，同步） */
async function checkText(row) {
  const { status, data } = await textCheckNow({ appId: row.app_id, content: row.content, openid: row.openid });
  if (data) await finalize(row, status, String((data.result && data.result.label) || ""), data);
  else await finalize(row, status, "");
}

/** sharp 压缩图片到 imgSecCheck 要求（≤1MB，尺寸上限内）；过小图直接 pass 语义由调用方处理 */
async function shrinkImage(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (w < IMG_MIN_SIZE || h < IMG_MIN_SIZE) return { buffer, tooSmall: true };
  let out = buffer;
  if (buffer.length > IMG_MAX_BYTES || w > IMG_MAX_EDGE || h > IMG_MAX_HEIGHT) {
    out = await sharp(buffer)
      .rotate()
      .resize(IMG_MAX_EDGE, IMG_MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  }
  return { buffer: out, tooSmall: false };
}

/** 图片检测（imgSecCheck，同步；form-data 上传 ≤1MB 图） */
async function checkImage(row) {
  const { publicUrl } = require("./storage");
  const resp = await fetch(publicUrl(row.content));
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
  const orig = Buffer.from(await resp.arrayBuffer());
  if (orig.length === 0) { await finalize(row, "skip", "空文件"); return; }
  const { buffer, tooSmall } = await shrinkImage(orig);
  if (tooSmall) { await finalize(row, "pass", "图片过小，不检测"); return; }
  const { status, data } = await imgSecCheckCall({ appId: row.app_id, buffer });
  await finalize(row, status, String((data.result && data.result.label) || ""), data);
}

/** 音频检测（mediaCheckAsync，异步提交，返回后轮询） */
async function checkAudio(row) {
  const size = await fileSizeOf(row.content);
  if (size !== null && size > MEDIA_MAX_BYTES) { await finalize(row, "skip", "音频超 20MB，跳过自动检测"); return; }
  const cfg = await readSecurityCfg(row.app_id);
  const token = await getAccessToken(row.app_id);
  const { publicUrl } = require("./storage");
  const resp = await fetch(
    `${WX_MEDIA_CHECK_ASYNC}?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_url: publicUrl(row.content), media_type: 1, version: 2, scene: cfg.scene, openid: row.openid }),
    }
  );
  const data = await resp.json();
  const err = Number(data && data.errcode) || 0;
  if (err !== 0) throw new Error(`mediaCheckAsync ${err} ${(data && data.errmsg) || ""}`);
  if (!data.trace_id) throw new Error("mediaCheckAsync 未返回 trace_id");
  await db.from("content_audits")
    .update({ trace_id: data.trace_id, next_poll_at: nowSql(new Date(Date.now() + 30 * 1000)) })
    .eq("audit_id", row.audit_id);
}

/** 轮询异步检测结果（带 trace_id 的行） */
async function pollMediaAsync(row) {
  const token = await getAccessToken(row.app_id);
  const resp = await fetch(
    `${WX_MEDIA_CHECK_ASYNC}?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace_id: row.trace_id }),
    }
  );
  const data = await resp.json();
  const result = data && data.result;
  if (result && (result.suggest || result.label !== undefined)) {
    await finalize(row, verdictFromWx(data), String((result && result.label) || ""), data);
    return;
  }
  const err = Number(data && data.errcode) || 0;
  if (err === 87014) { await finalize(row, "reject", "命中敏感内容", data); return; }
  if (err !== 0) throw new Error(`mediaCheckAsync poll ${err} ${(data && data.errmsg) || ""}`);
  // 尚未出结果：延后轮询（上限 12 次 ≈ 6 分钟，超时 fail-open）
  const retries = (Number(row.retries) || 0) + 1;
  if (retries >= 12) { await finalize(row, "skip", "检测超时"); return; }
  await db.from("content_audits")
    .update({ retries, next_poll_at: nowSql(new Date(Date.now() + 60 * 1000)) })
    .eq("audit_id", row.audit_id);
}

// ==================== 视频抽帧检测（mediaCheckAsync 不支持视频，抽帧走图片检测） ====================

let FFMPEG_OK = null;
async function ffmpegReady() {
  if (FFMPEG_OK !== null) return FFMPEG_OK;
  try {
    await execFileP("ffmpeg", ["-version"], { timeout: 15000 });
    FFMPEG_OK = true;
  } catch (_) {
    console.error("[security] ffmpeg 不可用，视频抽帧检测跳过");
    FFMPEG_OK = false;
  }
  return FFMPEG_OK;
}

async function probeDuration(file) {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const d = Number((stdout || "").trim());
    return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
  } catch (_) {
    return 0;
  }
}

async function extractFrame(src, out, seek) {
  await execFileP("ffmpeg", [
    "-y", "-ss", String(seek), "-i", src, "-vframes", "1", "-q:v", "3", out,
  ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
}

/** 单帧图片检测（复用 imgSecCheck）；返回 { status, data }（data=微信完整返回，供整段审计） */
async function checkFrame(filePath, row) {
  const buf = await fs.promises.readFile(filePath);
  const { buffer, tooSmall } = await shrinkImage(buf);
  if (tooSmall) return { status: "pass", data: null };
  return await imgSecCheckCall({ appId: row.app_id, buffer });
}

/** 视频检测：ffmpeg 抽 3 帧 → imgSecCheck，任一帧 reject 则整条 reject */
async function checkVideo(row) {
  const { publicUrl } = require("./storage");
  const url = publicUrl(row.content);
  if (!(await ffmpegReady())) { await finalize(row, "skip", "ffmpeg 不可用，跳过视频检测"); return; }
  // 超大视频（≥300MB）不下载抽帧，避免 worker 阻塞/带宽占用（正常打卡视频远小于此）
  const vSize = await fileSizeOf(row.content);
  if (vSize !== null && vSize > 300 * 1024 * 1024) { await finalize(row, "skip", "视频超大，跳过自动检测"); return; }
  const tmp = path.join(os.tmpdir(), `kxm_sec_${genId()}_src`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载视频失败 HTTP ${resp.status}`);
    const { Readable } = require("stream");
    const { pipeline } = require("stream/promises");
    await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(tmp));

    const dur = await probeDuration(tmp);
    const frames = [];
    for (let i = 0; i < VIDEO_FRAMES; i++) {
      const seek = dur > 0 ? Math.max(0, Math.floor(dur * (i + 1) / (VIDEO_FRAMES + 1))) : 0;
      const out = path.join(os.tmpdir(), `kxm_sec_${genId()}_f${i}.jpg`);
      try {
        await extractFrame(tmp, out, seek);
        frames.push(out);
      } catch (_) { /* 单帧失败忽略 */ }
    }
    if (frames.length === 0) { await finalize(row, "skip", "视频抽帧失败，跳过自动检测"); return; }
    let worst = "pass";
    const frameRaws = [];
    for (const f of frames) {
      try {
        const { status, data } = await checkFrame(f, row);
        frameRaws.push({ frame: path.basename(f), status, raw: data });
        if (status === "reject") { worst = "reject"; break; }
        if (status === "risk" && worst === "pass") worst = "risk";
      } catch (e) {
        console.error("[security] 视频帧检测失败", e.message);
      }
    }
    await finalize(row, worst, worst === "reject" ? "视频画面命中违规" : "", { frames: frameRaws });
  } finally {
    try { await fs.promises.unlink(tmp); } catch (_) {}
    // 清理临时帧文件（尽力而为）
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith("kxm_sec_") && f.endsWith(".jpg")) {
        try { await fs.promises.unlink(path.join(os.tmpdir(), f)); } catch (_) {}
      }
    }
  }
}

// ==================== Worker ====================

async function fileSizeOf(relPath) {
  try {
    const { data } = await db.from("file_uploads").select("file_size").eq("file_path", relPath).limit(1);
    return (data && data[0]) ? Number(data[0].file_size) : null;
  } catch (_) {
    return null;
  }
}

/** 单条任务分发处理 */
async function processRow(row) {
  // 该 app 已关闭内容安全：保留 pending，读侧透传即可，不做任何检测
  if (!(await securityEnabled(row.app_id))) return;
  if (row.trace_id) { await pollMediaAsync(row); return; }
  switch (Number(row.media_type)) {
    case 1: await checkText(row); break;
    case 2: await checkImage(row); break;
    case 3: await checkAudio(row); break;
    case 4: await checkVideo(row); break;
    default: await finalize(row, "skip", "未知媒体类型");
  }
}

let workerRunning = false;

/**
 * 内容安全 worker（定时轮询 pending 任务）：
 *  - 无 trace_id：文本/图片同步检测；音频提交异步检测（写 trace_id+next_poll_at）；视频抽帧检测
 *  - 有 trace_id 且到轮询时间：查异步检测结果
 *  - 开关关闭：跳过处理（读侧透传，无任何影响）
 */
async function runAuditWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const { data, error } = await db.from("content_audits")
      .select()
      .eq("status", "pending")
      .order("enqueued_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (error) throw error;
    for (const row of data || []) {
      // 退避/轮询时间未到 → 跳过本轮到下轮
      if (row.next_poll_at && new Date(row.next_poll_at).getTime() > Date.now()) continue;
      try {
        await processRow(row);
      } catch (e) {
        console.error("[security] 处理任务失败", row.audit_id, e.message);
        await bumpRetry(row, e.message);
      }
    }
  } catch (e) {
    console.error("[security] worker error", e.message);
  } finally {
    workerRunning = false;
  }
}

/** 启动 worker（启动 3s 后先跑一次，之后每 intervalMs 轮询） */
function startAuditWorker(intervalMs = 15000) {
  setTimeout(() => runAuditWorker().catch(() => {}), 3000);
  setInterval(() => runAuditWorker().catch(() => {}), intervalMs);
  // 启动对账：把升级前已有审核结果、但业务表 risk_status 仍是 pending 的记录补算一次（一次/进程）
  setTimeout(() => reconcileStaleRisk().catch(() => {}), 10000);
  // 启动诊断：输出各小程序内容安全开关状态（排查「为什么没有检测」）
  setTimeout(async () => {
    try {
      const { BUILTIN_APPS } = require("./apps");
      for (const id of Object.keys(BUILTIN_APPS)) {
        const cfg = await readSecurityCfg(id);
        console.log(`[security] 内容安全配置 ${id}: enabled=${cfg.enabled} scene=${cfg.scene}`);
      }
    } catch (e) {
      console.error("[security] 启动诊断失败", e.message);
    }
  }, 5000);
  console.log("[security] 内容安全 worker 已启动（每", intervalMs / 1000, "s 轮询）");
}

/** 对账：迁移旧模型 file 行归属 + 对 risk_status='pending' 的业务记录按现有审核结果补算 */
async function reconcileStaleRisk() {
  try {
    // 1) 旧模型遗留：把 biz_type='file'（biz_id=路径）的审核行归属到引用它的业务记录
    const { data: fileRows } = await db.from("content_audits")
      .select("audit_id, biz_id").eq("biz_type", "file").limit(2000);
    for (const row of fileRows || []) {
      try {
        const recs = await resolveMediaRecords(row.biz_id);
        if (recs.length > 0) {
          await db.from("content_audits")
            .update({ biz_type: recs[0].bizType, biz_id: recs[0].bizId, field: "" })
            .eq("audit_id", row.audit_id);
        }
      } catch (_) {}
    }
    // 2) 升级前已有审核结果、但业务表 risk_status 仍是 pending 的记录补算一次
    const { data: tasks } = await db.from("tasks").select("task_id").eq("risk_status", "pending").limit(2000);
    for (const t of tasks || []) await syncRecordRisk({ bizType: "task", bizId: t.task_id });
    const { data: checks } = await db.from("task_checkins").select("checkin_id").eq("risk_status", "pending").limit(2000);
    for (const c of checks || []) await syncRecordRisk({ bizType: "checkin", bizId: c.checkin_id });
    console.log("[security] risk_status 对账完成（遗留 file 行:", (fileRows || []).length, "）");
  } catch (e) {
    console.error("[security] reconcileStaleRisk error", e.message);
  }
}

module.exports = {
  securityEnabled,
  readSecurityCfg,
  mediaTypeOf,
  submitForAudit,
  mergeAudit,
  repointAudit,
  rebindAudit,
  syncRecordRisk,
  textCheckNow,
  imageCheckNow,
  runAuditWorker,
  startAuditWorker,
};
