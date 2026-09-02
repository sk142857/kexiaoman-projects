/**
 * 课小满小程序认证（环境内直调云托管，LP JWT）
 *
 * 两层身份，职责分离：
 *   1. 登录/会话：wx.login → code2session → openid → 签发「小程序会话 token」（仅含 openid）。
 *      与微信授权（getUserProfile 等 scope）无关，打开即得，业务后端使用不被授权流程阻塞。
 *   2. 业务身份（邀请码准入，邀请码独立维护在 t_lp_invites，不再挂 t_staff）：
 *      - 身份选择后按邀请码绑定：输入 6 位邀请码绑定 openid ↔ staff_id（t_lp_students）。
 *      - 邀请码分三类（kind）：
 *          student：学生码，由主家长在孩子档案中生成；绑定孩子学生账号（role=student），仅可绑一次。
 *          parent：家长码，由管理员在后台为已注册的主家长账号生成（单次使用，绑定即作废）；绑定已有主家长账号（role=parent）。
 *          family：家属共享码，由主家长生成（单次使用，绑定即作废）；绑定后建家属账号（role=family）并写入家属关系。
 *      - 有码 → 能进业务页面；无码 → 进身份选择/绑定页；邀请码作废 → 立即锁定。
 *
 * 运行配置来源（t_apps.app_id = miniprogram-kxm）：
 *   wechat_appid  课小满 AppID
 *   app_secret    课小满 AppSecret（code2session）
 *   jwt_secret    课小满 JWT 签名密钥
 *   jwt_expires   登录态有效期（默认 7d）
 * 短 TTL 缓存（60s），后台改配置后最多 60s 生效；未配置时回退内置弱密钥并告警
 */
const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql } = require("../utils");
const { nextSeq } = require("../seq");
const { ensureUser, genUniqueNickname } = require("../appAuth");
const { getAppConfig } = require("../apps");
const { cached } = require("../cache");

const router = express.Router();

// ==================== 应用常量 ====================
const LP_APP = { app_id: "miniprogram-kxm", app_name: "课小满", wechat_appid: "wxa8035a4cd63554fe", app_status: 1 };

// 邀请码字符集：排除易混淆 0/O/1/I
const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 角色白名单（个人角色：无家庭、无身份切换，自己发布任务自己打卡，最简单）
const LP_ROLES = ["admin", "parent", "family", "student", "personal"];

// ==================== t_apps 运行配置（缓存 60s，后台修改后最多 60s 生效） ====================
let lpConfigCache = null;
let lpConfigAt = 0;
async function getLpConfig(force) {
  const now = Date.now();
  if (!force && lpConfigCache && now - lpConfigAt < 60 * 1000) return lpConfigCache;
  const row = await getAppConfig(LP_APP.app_id);
  const cfg = {
    appid: (row && row.wechat_appid) || LP_APP.wechat_appid,
    appSecret: (row && row.app_secret) || "",
    jwtSecret: (row && row.jwt_secret) || "",
    jwtExpires: (row && row.jwt_expires) || "7d",
  };
  // fail-closed：密钥缺失时直接拒绝（拒绝再回退内置弱密钥，防止 Token 被伪造）
  if (!cfg.appSecret) {
    console.warn("[lpAuth] 警告：t_apps 中课小满未配置 app_secret，登录/绑定已拒绝（请在后端「小程序配置」中填写）");
    throw new Error("服务未配置小程序 AppSecret（请在后台「小程序配置」填写）");
  }
  if (!cfg.jwtSecret) {
    console.warn("[lpAuth] 警告：t_apps 中课小满未配置 jwt_secret，登录/会话已拒绝（请在后端「小程序配置」中填写）");
    throw new Error("服务未配置 jwt_secret（请在后台「小程序配置」填写）");
  }
  lpConfigCache = cfg;
  lpConfigAt = now;
  return cfg;
}

/** 校验会话 token 并返回 { openid, staffId? }（仅验签，不查绑定；供共享 /api/* 路由身份确认，替代不可信的 X-WX-OPENID 头） */
async function verifyLpToken(token) {
  if (!token) return null;
  try {
    const cfg = await getLpConfig();
    const decoded = jwt.verify(String(token), cfg.jwtSecret);
    return (decoded && decoded.openid)
      ? { openid: decoded.openid, appId: decoded.appId || "", staffId: decoded.staffId ? String(decoded.staffId) : "" }
      : null;
  } catch (_) {
    return null;
  }
}

// ==================== 工具 ====================

/** code2session：登录 code 换 openid（+ session_key） */
async function code2session(code) {
  const cfg = await getLpConfig();
  if (!cfg.appSecret) throw new Error("服务未配置小程序 AppSecret（请在后台「小程序配置」填写）");
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(cfg.appid)}&secret=${encodeURIComponent(cfg.appSecret)}&js_code=${encodeURIComponent(String(code))}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data || data.errcode) {
    throw new Error(`code2session 失败: ${data ? (data.errcode + " " + (data.errmsg || "")) : "空响应"}`);
  }
  return data; // { openid, session_key, ... }
}

/** 生成 6 位大写邀请码 */
function genInviteCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += INVITE_CHARS[crypto.randomInt(INVITE_CHARS.length)];
  return code;
}

/** 生成不冲突的邀请码（查 t_lp_invites 去重） */
async function genUniqueInviteCode() {
  for (let i = 0; i < 10; i++) {
    const code = genInviteCode();
    const { data, error } = await db.from("lp_invites").select("invite_id").eq("invite_code", code).limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return code;
  }
  throw new Error("邀请码生成冲突，请重试");
}

/**
 * 创建一条邀请码记录（学生码或家属码）
 * @param {object} p { kind, ownerStaffId, childId, createdBy }
 * @returns {Promise<{invite_id, invite_code}>}
 */
async function createInvite(p) {
  const code = await genUniqueInviteCode();
  const inviteId = await nextSeq("invite_id");
  await db.from("lp_invites").insert({
    invite_id: inviteId,
    app_id: LP_APP.app_id,
    invite_code: code,
    kind: String(p.kind || "student"),
    owner_staff_id: Number(p.ownerStaffId) || 0,
    child_id: Number(p.childId) || 0,
    status: "available",
    bound_openid: "",
    bound_staff_id: 0,
    bound_at: null,
    created_by: Number(p.createdBy) || 0,
    created_at: nowSql(),
    updated_at: nowSql(),
  });
  return { invite_id: inviteId, invite_code: code };
}

/** 按 invite_id 查邀请码 */
async function inviteById(id) {
  const { data, error } = await db.from("lp_invites").select().eq("invite_id", Number(id)).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

/** 按 staff_id 查员工 */
async function staffById(id) {
  const { data, error } = await db.from("staff").select().eq("staff_id", Number(id)).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

/** 账号级锁定（t_users.locked_until，管理员后台按 user_id 锁定）：锁定期内返回锁定记录，否则 null */
async function userLockedUntil(openid) {
  if (!openid) return null;
  try {
    const { data, error } = await db.from("users")
      .select("locked_until, locked_at, locked_reason, locked_by")
      .eq("openid", openid).eq("app_id", LP_APP.app_id).limit(1);
    if (error) return null;
    const u = data && data[0];
    if (u && u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      return u;
    }
  } catch (_) { /* 查询失败按未锁定处理 */ }
  return null;
}

/** 账号被锁定时的统一提示（含截止时间） */
function lockMsg(until) {
  const base = "账号已被锁定";
  if (!until) return `${base}，请稍后再试`;
  const t = new Date(until);
  if (isNaN(t.getTime())) return `${base}，请稍后再试`;
  const pad = (n) => String(n).padStart(2, "0");
  const s = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return `${base}，${s} 后自动解锁`;
}

/** 格式化锁定详情（原因/时间/解封时间），供小程序锁定页展示 */
function lockInfo(rec) {
  if (!rec || !rec.locked_until) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (v) => {
    const t = new Date(v);
    if (isNaN(t.getTime())) return "";
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  };
  return {
    reason: String(rec.locked_reason || "").slice(0, 255),
    lockedAt: fmt(rec.locked_at),
    unlockAt: fmt(rec.locked_until),
  };
}

/** 按邀请码查找可绑定的邀请记录（学生码/家长码/家属码，未绑定且未作废） */
async function findBindableInvite(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) return null;
  const { data, error } = await db.from("lp_invites")
    .select("invite_id, invite_code, kind, owner_staff_id, child_id, status")
    .eq("invite_code", c).limit(1);
  if (error) throw error;
  const inv = data && data[0];
  if (!inv || !["student", "family", "parent"].includes(inv.kind) || inv.status !== "available") return null;
  return inv;
}

/**
 * 原子领取邀请码（单次使用防并发双绑）：
 * 仅当邀请码仍为 available 时置为 bound 并登记绑定者；已被他人并发绑定则返回 false。
 * 更新条件带 status=available 作为乐观锁；不同网关对 update 影响行数返回不一致，
 * 统一回查 bound_openid 确认抢占结果，避免同一码被两个 openid 同时绑定成功。
 */
async function claimInvite(inv, openid, boundStaffId) {
  const { error } = await db.from("lp_invites")
    .update({
      status: "bound",
      bound_openid: openid,
      bound_staff_id: boundStaffId,
      bound_at: nowSql(),
      updated_at: nowSql(),
    })
    .eq("invite_id", inv.invite_id)
    .eq("status", "available");
  if (error) throw error;
  const { data } = await db.from("lp_invites")
    .select("status, bound_openid").eq("invite_id", inv.invite_id).limit(1);
  const rec = data && data[0];
  return !!(rec && rec.status === "bound" && rec.bound_openid === openid);
}

/** 签发学习星球会话 JWT（含 openid + 活动身份 staffId；业务身份由实时绑定解析） */
async function signToken(openid, staffId) {
  const cfg = await getLpConfig();
  return jwt.sign(
    { openid, appId: LP_APP.app_id, ...(staffId ? { staffId: String(staffId) } : {}) },
    cfg.jwtSecret,
    { expiresIn: cfg.jwtExpires }
  );
}

/** 该 openid 的全部「可用身份」（供登录 / 切换 / 身份切换页）：
 *  1) 显式绑定：t_lp_students（注册建档 / 邀请码 / 历史 auto 行）中 bound_status=1 且账号在职；
 *  2) 家谱继承：openid 绑定的主家长名下孩子（运行时推导，不再把「家长挂孩子」物化成绑定行）。
 *  二者去重合并；这样家长无需任何额外绑定即可在“孩子档案/身份切换”里切入自己名下孩子，
 *  孩子自己的手机凭邀请码显式绑定，两条通道互不影响。
 */
async function listBoundStaffs(openid) {
  // 1) 显式绑定
  const { data, error } = await db.from("lp_students")
    .select("staff_id").eq("app_id", LP_APP.app_id).eq("openid", openid).eq("bound_status", 1).limit(50);
  if (error) throw error;
  const boundIds = (data || []).map(r => Number(r.staff_id)).filter(v => v > 0);

  // 2) 家谱继承：这些绑定中的主家长，其名下孩子
  const inheritIds = [];
  if (boundIds.length > 0) {
    let parentIds = [];
    try {
      const { data: ps, error: pErr } = await db.from("staff")
        .select("staff_id").in("staff_id", boundIds).eq("staff_role", "parent").eq("staff_status", 1).limit(boundIds.length);
      if (!pErr) parentIds = (ps || []).map(p => Number(p.staff_id));
    } catch (_) { parentIds = []; }
    if (parentIds.length > 0) {
      try {
        const { data: cs } = await db.from("lp_children")
          .select("student_staff_id").in("parent_staff_id", parentIds).eq("child_status", 1).limit(300);
        const seen = new Set(boundIds);
        (cs || []).forEach(c => { const sid = Number(c.student_staff_id); if (sid > 0 && !seen.has(sid)) { seen.add(sid); inheritIds.push(sid); } });
      } catch (_) {}
    }
  }

  const allIds = [...new Set([...boundIds, ...inheritIds])];
  if (allIds.length === 0) return [];
  const { data: staffs, error: sErr } = await db.from("staff")
    .select("staff_id, staff_username, staff_nickname, staff_avatar, staff_role, staff_status, pin_hash")
    .in("staff_id", allIds).limit(allIds.length);
  if (sErr) throw sErr;
  const rows = staffs || [];
  const order = { parent: 0, family: 1, student: 2, admin: 3, personal: 4 };
  const inheritSet = new Set(inheritIds.map(String));
  return rows
    .filter(s => s.staff_status === 1 && LP_ROLES.includes(s.staff_role))
    .sort((a, b) => (order[a.staff_role] ?? 9) - (order[b.staff_role] ?? 9))
    .map(s => ({ ...staffBrief(s), pin_enabled: !!s.pin_hash, inherit: inheritSet.has(String(s.staff_id)) }));
}

/**
 * 该 openid 是否可用指定身份（登录态实时校验）：
 *  - 直接绑定：t_lp_students (openid, staff) bound=1；
 *  - 家谱继承：openid 绑定的主家长名下孩子；
 *  - 平台管理员（openid 绑定了 admin 身份）：可代表任意有效学生（与后台“以孩子身份进入/学习视图”一致）。
 * 后台解除绑定/删除家庭后，对应身份即时不可用（实时复核，不依赖缓存）。
 */
async function openidMayUseStaff(openid, staffId) {
  const target = Number(staffId);
  if (!openid || !target) return false;
  if (await hasBoundStaff(openid, target)) return true;

  // openid 已绑定的身份（找主家长 / 平台管理员）
  let boundIds = [];
  try {
    const { data: binds } = await db.from("lp_students")
      .select("staff_id").eq("app_id", LP_APP.app_id).eq("openid", openid).eq("bound_status", 1).limit(50);
    boundIds = (binds || []).map(r => Number(r.staff_id)).filter(v => v > 0);
  } catch (_) { return false; }
  if (!boundIds.length) return false;

  // 家谱继承：openid 绑定的主家长名下孩子
  try {
    const { data: ps } = await db.from("staff")
      .select("staff_id").in("staff_id", boundIds).eq("staff_role", "parent").eq("staff_status", 1).limit(boundIds.length);
    const parentIds = (ps || []).map(p => Number(p.staff_id));
    if (parentIds.length) {
      const { data: rel } = await db.from("lp_children")
        .select("child_id").in("parent_staff_id", parentIds).eq("student_staff_id", target).eq("child_status", 1).limit(1);
      if (rel && rel[0]) return true;
    }
  } catch (_) {}

  // 平台管理员：可代表任意有效学生
  try {
    const { data: as } = await db.from("staff")
      .select("staff_id").in("staff_id", boundIds).eq("staff_role", "admin").eq("staff_status", 1).limit(boundIds.length);
    if (as && as.length) {
      const t = await staffById(target);
      if (t && t.staff_role === "student" && t.staff_status === 1) return true;
    }
  } catch (_) {}
  return false;
}

/** 该 openid 是否已绑定指定 staff_id（有效） */
async function hasBoundStaff(openid, staffId) {
  const { data, error } = await db.from("lp_students")
    .select("id").eq("app_id", LP_APP.app_id).eq("openid", openid)
    .eq("staff_id", Number(staffId)).eq("bound_status", 1).limit(1);
  if (error) throw error;
  return !!(data && data[0]);
}

/** 激活/新增绑定：openid ↔ staff 已存在（含 bound_status=0 被作废的历史行）则恢复为有效，否则新增
 *  @param {string} source 绑定来源：register=注册建档 / invite=邀请码 / auto=家谱自动（家长一键/建档自动）
 *  激活历史行时不改写来源（保留首次来源，便于审计“孩子自己的手机”vs“家长自动挂”） */
async function activateBinding(openid, staffId, source = "invite") {
  const { data, error } = await db.from("lp_students")
    .select("id").eq("app_id", LP_APP.app_id).eq("openid", openid)
    .eq("staff_id", Number(staffId)).limit(1);
  if (error) throw error;
  if (data && data[0]) {
    await db.from("lp_students")
      .update({ bound_status: 1, bound_at: nowSql(), updated_at: nowSql() })
      .eq("id", data[0].id).eq("app_id", LP_APP.app_id).eq("openid", openid);
  } else {
    await db.from("lp_students").insert({
      staff_id: Number(staffId),
      app_id: LP_APP.app_id,
      openid,
      bound_status: 1,
      source: String(source || "invite").slice(0, 16),
      bound_at: nowSql(),
      created_at: nowSql(),
      updated_at: nowSql(),
    });
  }
}

/** 仅校验会话 token 并取 openid（不要求已绑定业务身份，供绑定接口使用） */
async function verifySession(req) {
  const lpHeader = req.headers["x-lp-token"] || "";
  const auth = req.headers.authorization || "";
  const token = lpHeader || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!token) return null;
  try {
    const cfg = await getLpConfig();
    const decoded = jwt.verify(token, cfg.jwtSecret);
    return (decoded && decoded.openid) || null;
  } catch (_) {
    return null;
  }
}

/** 员工简要信息（回传小程序展示） */
function staffBrief(s) {
  const FALLBACK = { admin: "管理员", parent: "主家长", family: "家属", student: "学生", personal: "个人" };
  return {
    staff_id: String(s.staff_id),
    nickname: s.staff_nickname || FALLBACK[s.staff_role] || "学生",
    username: s.staff_username,
    role: s.staff_role,
  };
}

/** 绑定尝试限流（进程内简单滑动窗口，防邀请码爆破） */
const BIND_ATTEMPT = new Map();
function bindAllow(openid, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = BIND_ATTEMPT.get(openid);
  if (!rec || now - rec.start >= windowMs) return true;
  return rec.count < max;
}
function recordBindAttempt(openid) {
  const now = Date.now();
  const rec = BIND_ATTEMPT.get(openid);
  if (!rec || now - rec.start >= 15 * 60 * 1000) BIND_ATTEMPT.set(openid, { start: now, count: 1 });
  else rec.count += 1;
}

// ==================== PIN 校验限流（安全审计 S8） ====================
// 4-6 位数字 PIN 空间有限（≤10^6），必须限流防爆破（切身份/校验/关闭均计入）。
// key = openid:staffId，避免多身份互相干扰；成功校验后清空计数。
const PIN_ATTEMPT = new Map();
function pinAllow(key, max = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = PIN_ATTEMPT.get(key);
  if (!rec || now - rec.start >= windowMs) return true;
  return rec.count < max;
}
function recordPinAttempt(key, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = PIN_ATTEMPT.get(key);
  if (!rec || now - rec.start >= windowMs) PIN_ATTEMPT.set(key, { start: now, count: 1 });
  else rec.count += 1;
}
function clearPinAttempt(key) { PIN_ATTEMPT.delete(key); }

/** 静默注册/刷新 t_users 用户记录（学习星球用户画像，fire-and-forget） */
function touchUserProfile(openid) {
  ensureUser(LP_APP, openid).catch(() => {});
}

/** 生成随机的占位/登录密码（8 位，不含易混淆字符） */
function genRandomPassword(len = 8) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let pwd = "";
  for (let i = 0; i < len; i++) pwd += chars[crypto.randomInt(chars.length)];
  return pwd;
}

/**
 * 微信未授权资料时返回的占位昵称（nickName=「微信用户」），
 * 若直接入库会出现大量同名「微信用户」，视为未提供并走随机昵称「用户+6位」生成策略
 */
const WECHAT_PLACEHOLDER_NICKNAMES = new Set(["微信用户", "wx_user", "微信用户。"]);
function cleanWechatNickname(raw) {
  const s = String(raw || "").trim().slice(0, 32);
  return WECHAT_PLACEHOLDER_NICKNAMES.has(s) ? "" : s;
}

/**
 * 为家长/家属/学生创建 t_staff 账号（家长有后台登录能力，家属/学生无，随机占位密码）
 * 通用账号生成规则：
 * - 登录账号：user_{staff_id}（staff_id 唯一，账号天然唯一）
 * - 昵称：优先使用传入昵称（如微信昵称，保持一致）；未提供或为「微信用户」占位（从后台首建）则复用微信昵称生成策略「用户 + 6 位随机字符串」
 */
async function createLpAccount({ role, nickname, openid }) {
  const staffId = await nextSeq("staff_id");
  const username = `user_${staffId}`;
  const password = genRandomPassword();
  const rawNick = cleanWechatNickname(nickname);
  const values = {
    staff_id: staffId,
    staff_username: username,
    staff_password: require("bcryptjs").hashSync(password, 10),
    staff_nickname: rawNick || await genUniqueNickname(),
    staff_role: role,
    staff_status: 1,
    created_at: nowSql(),
    updated_at: nowSql(),
  };
  await db.from("staff").insert(values);
  return { staff_id: staffId, username, nickname: values.staff_nickname, password };
}

/** 当前用户家庭可见范围：可查看/管理的孩子 student staff_id 集合；admin=null（全部） */
async function familyScope(staffId, role) {
  staffId = String(staffId);
  if (role === "student" || role === "personal") return [staffId];
  if (role !== "parent" && role !== "family") return null; // admin 全部
  // 家庭关系读多写少，短 TTL（15s）缓存；解绑/禁用由绑定校验（bind）实时拦截，scope 缓存不引入越权
  return cached(`familyScope:${staffId}:${role}`, async () => {
    if (role === "parent") {
      const { data, error } = await db.from("lp_children")
        .select("student_staff_id").eq("parent_staff_id", Number(staffId)).eq("child_status", 1).limit(200);
      if (error) throw error;
      return (data || []).map(c => String(c.student_staff_id)).filter(Boolean);
    }
    if (role === "family") {
      const { data: members, error: mErr } = await db.from("lp_family_members")
        .select("owner_staff_id").eq("member_staff_id", Number(staffId)).eq("member_status", 1).limit(50);
      if (mErr) throw mErr;
      const owners = (members || []).map(m => Number(m.owner_staff_id)).filter(Boolean);
      if (owners.length === 0) return [];
      const { data, error } = await db.from("lp_children")
        .select("student_staff_id").in("parent_staff_id", owners).eq("child_status", 1).limit(500);
      if (error) throw error;
      return (data || []).map(c => String(c.student_staff_id)).filter(Boolean);
    }
    return null;
  }, 15 * 1000);
}

// ==================== 登录（拿小程序会话 token，与业务身份解耦） ====================
router.post("/login", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.json(fail("缺少登录 code"));
    let openid = "";
    try {
      const wx = await code2session(code);
      openid = wx.openid || "";
    } catch (e) {
      console.error("[lpAuth] code2session error", e);
      return res.json(fail("登录失败，请稍后重试", 401));
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 账号级锁定（后台按 user_id 锁定）：锁定期内登录直接返回锁定态
    const lockRec = await userLockedUntil(openid);
    if (lockRec) {
      const token = await signToken(openid);
      return res.json(ok({
        token,
        bound: false,
        locked: true,
        lockUntil: lockRec.locked_until,
        lockInfo: lockInfo(lockRec),
        msg: lockMsg(lockRec.locked_until),
      }));
    }

    // 只要 wx.login 成功就签发会话 token；能否进业务页由邀请码绑定决定
    const token = await signToken(openid);

    // 多身份：该 openid 全部有效绑定（家长 + 孩子 + 家属）
    const identities = await listBoundStaffs(openid);

    // 未绑定 → 前端展示身份选择/绑定界面
    if (identities.length === 0) {
      return res.json(ok({ token, bound: false, locked: false, msg: "请选择身份并输入邀请码完成绑定" }));
    }

    // 已绑定 → 解析活动身份：优先前端传入的 activeStaffId（仍有效），否则取第一个
    const preferred = String((req.body || {}).activeStaffId || "");
    let active = identities.find(s => String(s.staff_id) === preferred);
    if (!active) active = identities[0];

    const activeToken = await signToken(openid, active.staff_id);
    touchUserProfile(openid);
    // 注销流程中（7天冷静期）：登录仍签发 token 以便停留在注销页撤销，同时返回待生效申请，前端据此分流到注销页
    let cancelPending = null;
    try {
      const { pendingCancelSummary } = require("../accountLib");
      cancelPending = await pendingCancelSummary(LP_APP.app_id, openid);
    } catch (_) { /* 查询失败不影响登录 */ }
    res.json(ok({
      token: activeToken,
      bound: true,
      locked: false,
      activeStaffId: active.staff_id,
      identities,
      role: active.role,
      staff: active,
      cancel_pending: cancelPending,
    }, "登录成功"));
  } catch (e) {
    console.error("[lpAuth] login error", e);
    res.json(fail((e && e.message) ? e.message : "服务异常", 500));
  }
});

// ==================== 身份选择：注册为主家长（首次静默登录后） ====================
// 用户确认「我是家长」→ 自动创建 t_staff(role=parent) + 自动绑定当前 openid +
// 生成家属共享码 + 下发后台登录账号（明文密码仅此一次）。
// 多身份（共用微信）：已绑定主家长则幂等返回；未绑定时追加家长身份，不影响已有孩子/家属身份。
router.post("/registerParent", async (req, res) => {
  try {
    let openid = await verifySession(req);
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] registerParent code2session error", e);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 注销流程中：禁止注册/绑定/切换（只能停留在注销页撤销）
    if (await notCancelling(res, openid)) return;

    // 账号级锁定：锁定期内禁止注册/绑定
    const lockRec0 = await userLockedUntil(openid);
    if (lockRec0) {
      return res.json(fail(lockMsg(lockRec0.locked_until), 423));
    }

    // 多身份：该 openid 已绑定的全部有效身份
    const identities0 = await listBoundStaffs(openid);

    // 已绑定主家长 → 幂等返回当前状态（活动身份切到家长）
    const parent0 = identities0.find(s => s.role === "parent");
    if (parent0) {
      const token = await signToken(openid, parent0.staff_id);
      return res.json(ok({
        token, bound: true, activeStaffId: parent0.staff_id, identities: identities0,
        role: "parent", staff: parent0,
      }, "已注册"));
    }

    // 家长昵称（可选，来自前端微信昵称；未提供则走通用昵称生成策略）
    const nickname = String((req.body || {}).nickname || "").trim().slice(0, 32);

    // 创建家长账号 + 随机后台登录密码（明文仅此一次返回）
    const parent = await createLpAccount({ role: "parent", nickname, openid });
    const password = parent.password;

    // 自动绑定当前 openid ↔ 家长账号（追加绑定，不影响已有的孩子/家属身份）
    await db.from("lp_students").insert({
      staff_id: parent.staff_id,
      app_id: LP_APP.app_id,
      openid,
      bound_status: 1,
      source: "register",
      bound_at: nowSql(),
      created_at: nowSql(),
      updated_at: nowSql(),
    });

    // 生成家属共享码（单次使用，kind=family）
    const share = await createInvite({ kind: "family", ownerStaffId: parent.staff_id, childId: 0, createdBy: parent.staff_id });

    touchUserProfile(openid);
    const identities = await listBoundStaffs(openid);
    const token = await signToken(openid, parent.staff_id);
    res.json(ok({
      token,
      bound: true,
      activeStaffId: String(parent.staff_id),
      identities,
      role: "parent",
      staff: { staff_id: String(parent.staff_id), nickname: parent.nickname, username: parent.username, role: "parent" },
      share_code: share.invite_code,
      backend: { username: parent.username, password },
    }, "家长注册成功"));
  } catch (e) {
    console.error("[lpAuth] registerParent error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 身份选择：注册为个人（最简单身份，无家庭/无切换） ====================
// 用户确认「我是个人」→ 自动创建 t_staff(role=personal) + 自动绑定当前 openid。
// 个人：自己发布任务、自己打卡，不支持身份切换，无邀请码、无后台账号、无家属关系。
router.post("/registerPersonal", async (req, res) => {
  try {
    let openid = await verifySession(req);
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] registerPersonal code2session error", e);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 注销流程中：禁止注册/绑定/切换（只能停留在注销页撤销）
    if (await notCancelling(res, openid)) return;

    // 账号级锁定：锁定期内禁止注册/绑定
    const lockRec0 = await userLockedUntil(openid);
    if (lockRec0) {
      return res.json(fail(lockMsg(lockRec0.locked_until), 423));
    }

    // 幂等：该 openid 已绑定个人 → 直接返回当前状态
    const identities0 = await listBoundStaffs(openid);
    const personal0 = identities0.find(s => s.role === "personal");
    if (personal0) {
      const token = await signToken(openid, personal0.staff_id);
      return res.json(ok({
        token, bound: true, activeStaffId: personal0.staff_id, identities: identities0,
        role: "personal", staff: personal0,
      }, "已注册"));
    }

    // 个人昵称（可选，来自前端微信昵称；未提供则走通用昵称生成策略）
    const nickname = String((req.body || {}).nickname || "").trim().slice(0, 32);

    // 创建个人账号（无后台登录能力，随机占位密码）
    const personal = await createLpAccount({ role: "personal", nickname, openid });

    // 自动绑定当前 openid ↔ 个人账号（追加绑定，不影响已有身份）
    await db.from("lp_students").insert({
      staff_id: personal.staff_id,
      app_id: LP_APP.app_id,
      openid,
      bound_status: 1,
      source: "register",
      bound_at: nowSql(),
      created_at: nowSql(),
      updated_at: nowSql(),
    });

    touchUserProfile(openid);
    const identities = await listBoundStaffs(openid);
    const token = await signToken(openid, personal.staff_id);
    res.json(ok({
      token,
      bound: true,
      activeStaffId: String(personal.staff_id),
      identities,
      role: "personal",
      staff: { staff_id: String(personal.staff_id), nickname: personal.nickname, username: personal.username, role: "personal" },
    }, "个人注册成功"));
  } catch (e) {
    console.error("[lpAuth] registerPersonal error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 解除当前绑定（重新绑定第一步：立即解绑，可独立于后续换绑） ====================
// 仅清除绑定关系（t_lp_students），不动业务数据（任务/打卡/积分等）。
// 用户确认「重新绑定」后先调用本接口完成解绑；若随后中断下一步绑定，解绑已生效，互不影响。
router.post("/unbind", async (req, res) => {
  try {
    let openid = await verifySession(req);
    if (!openid) return res.json(fail("未登录或登录已过期", 401));

    // 注销流程中：禁止解除绑定（重新绑定同样不得进入）
    if (await notCancelling(res, openid)) return;

    // 当前活动身份（token 里的 staffId）
    const lpHeader = req.headers["x-lp-token"] || "";
    const auth = req.headers.authorization || "";
    const token = lpHeader || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
    let staffId = 0;
    if (token) {
      try {
        const cfg = await getLpConfig();
        const decoded = jwt.verify(token, cfg.jwtSecret);
        staffId = Number(decoded.staffId) || 0;
      } catch (_) { /* 无有效 staffId 时按全部解绑兜底 */ }
    }

    if (staffId) {
      await db.from("lp_students")
        .update({ bound_status: 0, updated_at: nowSql() })
        .eq("app_id", LP_APP.app_id).eq("openid", openid).eq("staff_id", staffId);
    } else {
      await db.from("lp_students")
        .update({ bound_status: 0, updated_at: nowSql() })
        .eq("app_id", LP_APP.app_id).eq("openid", openid).eq("bound_status", 1);
    }
    res.json(ok({ unbound: staffId ? String(staffId) : "" }, "已解除绑定"));
  } catch (e) {
    console.error("[lpAuth] unbind error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 绑定邀请码（会话 token 已含 openid，只需邀请码） ====================
// 按 kind 分支：
//   student：学生码，绑定孩子学生账号（role=student），码置 bound；
//   parent：家长码，单次使用，绑定后台已有主家长账号（role=parent），码置 bound；
//   family：家属共享码，单次使用，创建家属账号（role=family）+ 写家属关系 + 码置 bound。
router.post("/bind", async (req, res) => {
  try {
    const { code } = req.body || {};
    let openid = await verifySession(req);
    // 兼容：无会话 token 时回退到旧的 loginCode 换 openid
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] bind code2session error", e);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 注销流程中：禁止注册/绑定/切换（只能停留在注销页撤销）
    if (await notCancelling(res, openid)) return;

    // 账号级锁定：锁定期内禁止绑定/换绑
    const lockRec1 = await userLockedUntil(openid);
    if (lockRec1) {
      return res.json(fail(lockMsg(lockRec1.locked_until), 423));
    }

    // 限流：同一 openid 15 分钟内最多尝试 10 次
    if (!bindAllow(openid)) return res.json(fail("尝试过于频繁，请 15 分钟后再试", 429));
    recordBindAttempt(openid);

    const inv = await findBindableInvite(code);
    if (!inv) return res.json(fail("邀请码无效、已被绑定或已作废", 400));

    // ==================== 学生码绑定（追加身份，支持共用微信） ====================
    if (inv.kind === "student") {
      const student = await staffById(inv.owner_staff_id);
      if (!student || student.staff_role !== "student" || student.staff_status !== 1) {
        return res.json(fail("该学生账号不可用，请联系家长", 400));
      }
      // 多身份：同一 openid 可追加绑定多个孩子/家长身份；同 staff 幂等。
      // 家谱继承：本 openid 已是该孩子主家长（可切孩）时，直接幂等返回、不消耗学生邀请码
      // （学生码应留给孩子自己的手机/其它设备）。
      if (await openidMayUseStaff(openid, student.staff_id)) {
        const identities = await listBoundStaffs(openid);
        const token = await signToken(openid, student.staff_id);
        return res.json(ok({
          token, bound: true, activeStaffId: String(student.staff_id), identities,
          role: student.staff_role, staff: staffBrief(student),
        }, "绑定成功"));
      }
      // 抢占邀请码（原子，防两个用户并发绑定同一码）
      if (!(await claimInvite(inv, openid, student.staff_id))) {
        return res.json(fail("邀请码已被其他用户绑定，请刷新后重试", 400));
      }
      await activateBinding(openid, student.staff_id);
      touchUserProfile(openid);
      const identities = await listBoundStaffs(openid);
      const token = await signToken(openid, student.staff_id);
      return res.json(ok({
        token,
        bound: true,
        activeStaffId: String(student.staff_id),
        identities,
        role: student.staff_role,
        staff: staffBrief(student),
      }, "绑定成功"));
    }

    // ==================== 家长码绑定（绑定后台已注册的主家长账号，单次使用） ====================
    // 适用：主家长账号已由管理员在后台建立（如后台管理员注册/首建），小程序端输入管理员下发的家长码即可绑定，
    // 无需再走 registerParent 自动建号，避免出现「后台一个账号、小程序一个账号」的双账号。
    if (inv.kind === "parent") {
      const parent = await staffById(inv.owner_staff_id);
      if (!parent || parent.staff_role !== "parent" || parent.staff_status !== 1) {
        return res.json(fail("该主家长账号不可用，请联系管理员", 400));
      }
      // 多身份：同 staff 幂等；不同身份追加
      if (await hasBoundStaff(openid, parent.staff_id)) {
        const identities = await listBoundStaffs(openid);
        const token = await signToken(openid, parent.staff_id);
        return res.json(ok({
          token, bound: true, activeStaffId: String(parent.staff_id), identities,
          role: parent.staff_role, staff: staffBrief(parent),
        }, "绑定成功"));
      }
      // 抢占邀请码（原子，防并发双绑）
      if (!(await claimInvite(inv, openid, parent.staff_id))) {
        return res.json(fail("邀请码已被其他用户绑定，请刷新后重试", 400));
      }
      await activateBinding(openid, parent.staff_id);
      touchUserProfile(openid);
      const identities = await listBoundStaffs(openid);
      const token = await signToken(openid, parent.staff_id);
      return res.json(ok({
        token,
        bound: true,
        activeStaffId: String(parent.staff_id),
        identities,
        role: parent.staff_role,
        staff: staffBrief(parent),
      }, "绑定成功"));
    }

    // ==================== 家属共享码绑定（单次使用） ====================
    const owner = await staffById(inv.owner_staff_id);
    if (!owner || owner.staff_role !== "parent" || owner.staff_status !== 1) {
      return res.json(fail("主家长账号不可用，请联系主家长", 400));
    }
    // 多身份：已是该主家长名下的家属 → 幂等返回（复用家属账号，不重复创建）
    const { data: exRows, error: exErr } = await db.from("lp_students")
      .select("staff_id").eq("app_id", LP_APP.app_id).eq("openid", openid)
      .eq("bound_status", 1).limit(50);
    if (exErr) throw exErr;
    const exStaffIds = (exRows || []).map(r => Number(r.staff_id)).filter(Boolean);
    let reuseFam = null;
    if (exStaffIds.length > 0) {
      const { data: fms } = await db.from("lp_family_members")
        .select("member_staff_id").eq("owner_staff_id", Number(inv.owner_staff_id))
        .in("member_staff_id", exStaffIds).eq("member_status", 1).limit(10);
      if (fms && fms[0]) reuseFam = fms[0].member_staff_id;
    }
    if (reuseFam) {
      const curStaff = await staffById(reuseFam);
      const identities = await listBoundStaffs(openid);
      const token = await signToken(openid, reuseFam);
      return res.json(ok({
        token, bound: true, activeStaffId: String(reuseFam), identities,
        role: curStaff.staff_role, staff: staffBrief(curStaff),
      }, "绑定成功"));
    }

    // 创建家属账号
    const fam = await createLpAccount({
      role: "family",
      nickname: `家属${String(owner.staff_nickname || "").slice(0, 4) || ""}`,
      openid,
    });
    // 抢占邀请码（原子，防并发双绑）；抢占失败仅产生一个无绑定的孤立家属账号，不造成越权
    if (!(await claimInvite(inv, openid, fam.staff_id))) {
      return res.json(fail("邀请码已被其他用户绑定，请刷新后重试", 400));
    }
    // 追加绑定映射（不影响已有家长/孩子身份）
    await activateBinding(openid, fam.staff_id);
    // 写家属关系
    await db.from("lp_family_members").insert({
      app_id: LP_APP.app_id,
      owner_staff_id: owner.staff_id,
      member_staff_id: fam.staff_id,
      member_openid: openid,
      member_status: 1,
      bound_at: nowSql(),
      created_at: nowSql(),
      updated_at: nowSql(),
    });

    touchUserProfile(openid);
    const identities = await listBoundStaffs(openid);
    const token = await signToken(openid, fam.staff_id);
    res.json(ok({
      token,
      bound: true,
      activeStaffId: String(fam.staff_id),
      identities,
      role: "family",
      staff: { staff_id: String(fam.staff_id), nickname: fam.nickname, username: fam.username, role: "family" },
    }, "绑定成功"));
  } catch (e) {
    console.error("[lpAuth] bind error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 切换身份（共用微信：家长 ↔ 孩子 ↔ 家属） ====================
// 校验目标 staff 为本 openid 有效绑定；切到家长/管理员身份需 PIN（若已设置）。
router.post("/switch", async (req, res) => {
  try {
    let openid = await verifySession(req);
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] switch code2session error", e);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 注销流程中：禁止切换身份（共用微信下切到孩子/家属身份等同再次进入业务系统）
    if (await notCancelling(res, openid)) return;

    const lockRec = await userLockedUntil(openid);
    if (lockRec) return res.json(fail(lockMsg(lockRec.locked_until), 423));

    const targetId = Number((req.body || {}).staffId);
    if (!targetId) return res.json(fail("缺少目标身份", 400));

    // 目标身份必须是本 openid 的有效绑定
    const identities = await listBoundStaffs(openid);
    const target = identities.find(s => String(s.staff_id) === String(targetId));
    if (!target) return res.json(fail("无权切换到该身份", 403));

    // 切到家长/管理员身份：若已设 PIN，必须校验（含限流，防 4-6 位 PIN 爆破）
    if (["parent", "admin"].includes(target.role)) {
      const staff = await staffById(targetId);
      if (staff && staff.pin_hash) {
        const pinKey = `pin:${openid}:${targetId}`;
        if (!pinAllow(pinKey)) return res.json(fail("PIN 尝试次数过多，请 15 分钟后再试", 429));
        const pin = String((req.body || {}).pin || "");
        if (!pin || !bcrypt.compareSync(pin, staff.pin_hash)) {
          recordPinAttempt(pinKey);
          return res.json(fail("PIN 错误，请重试", 403));
        }
        clearPinAttempt(pinKey);
      }
    }

    const token = await signToken(openid, targetId);
    res.json(ok({
      token,
      bound: true,
      activeStaffId: String(targetId),
      identities,
      role: target.role,
      staff: target,
    }, "已切换身份"));
  } catch (e) {
    console.error("[lpAuth] switch error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 家长一键切到孩子身份（孩子账号绑定家长 openid，不影响孩子本人账号） ====================
// 家长/管理员在「孩子档案」点击「以孩子身份进入」：
//   - 自动把该孩子学生账号绑定到当前 openid（幂等；不消耗学生邀请码，孩子本人在其它设备绑定的账号不受影响）
//   - 签发孩子身份 token，家长可在自己手机上以孩子身份操作（打卡/完成任务等）
// 与 /switch 区别：/switch 要求目标身份已绑定本 openid；本接口允许家长直接切换到「本人名下的孩子」。
router.post("/switchChild", async (req, res) => {
  try {
    let openid = await verifySession(req);
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] switchChild code2session error", e);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 注销流程中：禁止切换身份
    if (await notCancelling(res, openid)) return;

    const lockRec = await userLockedUntil(openid);
    if (lockRec) return res.json(fail(lockMsg(lockRec.locked_until), 423));

    const targetId = Number((req.body || {}).staffId);
    if (!targetId) return res.json(fail("缺少目标身份", 400));

    // 当前活动身份（token 里的 staffId）：仅家长/管理员可一键切入孩子
    const lpHeader = req.headers["x-lp-token"] || "";
    const auth = req.headers.authorization || "";
    const token = lpHeader || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
    let curStaffId = 0;
    if (token) {
      try {
        const cfg = await getLpConfig();
        const decoded = jwt.verify(token, cfg.jwtSecret);
        curStaffId = Number(decoded.staffId) || 0;
      } catch (_) { /* 无有效身份按未登录处理 */ }
    }
    if (!curStaffId) return res.json(fail("未登录或登录已过期", 401));
    const curStaff = await staffById(curStaffId);
    if (!curStaff || curStaff.staff_status !== 1) return res.json(fail("当前账号不可用", 401));
    const curRole = curStaff.staff_role;
    if (!["parent", "admin"].includes(curRole)) return res.json(fail("仅家长可切换到孩子身份", 403));

    // 目标必须是有效的孩子学生账号
    const target = await staffById(targetId);
    if (!target || target.staff_role !== "student" || target.staff_status !== 1) {
      return res.json(fail("该孩子账号不可用", 400));
    }
    // 家长：目标必须是本人名下孩子（admin 可任意学生）
    if (curRole === "parent") {
      const { data: rel, error: relErr } = await db.from("lp_children")
        .select("child_id").eq("parent_staff_id", curStaffId)
        .eq("student_staff_id", targetId).eq("child_status", 1).limit(1);
      if (relErr) throw relErr;
      if (!(rel && rel[0])) return res.json(fail("无权切换到该孩子身份", 403));
    }

    // 家谱继承即授权：家长名下孩子无需物化绑定即可切入（运行时推导，见 openidMayUseStaff），
    // 不消耗学生邀请码、也不写 lp_students；孩子本人在其它微信凭码绑定的账号完全不受影响。
    // 切换前目标须为「可用身份」（直接绑定或家谱继承），保证即使直接调用本接口也不能越权。
    if (!(await openidMayUseStaff(openid, targetId))) {
      return res.json(fail("无权切换到该孩子身份", 403));
    }

    touchUserProfile(openid);
    const identities = await listBoundStaffs(openid);
    const activeToken = await signToken(openid, targetId);
    res.json(ok({
      token: activeToken,
      bound: true,
      activeStaffId: String(targetId),
      identities,
      role: "student",
      staff: staffBrief(target),
    }, "已切换到孩子身份"));
  } catch (e) {
    console.error("[lpAuth] switchChild error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 身份切换 PIN 管理（家长/管理员自选保护） ====================
// action=set 设置/修改（4-6 位数字）；action=verify 校验；action=remove 关闭（需正确 PIN）。
// 仅当前活动身份为 parent/admin 可操作自己的 PIN。
router.post("/pin", async (req, res) => {
  try {
    let openid = await verifySession(req);
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] pin code2session error", e);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 注销流程中：禁止 PIN 相关操作
    if (await notCancelling(res, openid)) return;

    const { action, pin } = req.body || {};
    const act = String(action || "");
    if (!["set", "verify", "remove"].includes(act)) return res.json(fail("无效操作"));

    // 当前活动身份（token 里的 staffId）
    const lpHeader = req.headers["x-lp-token"] || "";
    const auth = req.headers.authorization || "";
    const token = lpHeader || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
    let staffId = 0;
    if (token) {
      try {
        const cfg = await getLpConfig();
        const decoded = jwt.verify(token, cfg.jwtSecret);
        staffId = Number(decoded.staffId) || 0;
      } catch (_) { /* 无 token 或失效走下面拒绝 */ }
    }
    if (!staffId) return res.json(fail("未登录或登录已过期", 401));

    // 仅 parent/admin 可管理自己的 PIN
    const staff = await staffById(staffId);
    if (!staff || staff.staff_status !== 1 || !["parent", "admin"].includes(staff.staff_role)) {
      return res.json(fail("仅家长/管理员可设置身份 PIN", 403));
    }

    if (act === "set") {
      const p = String(pin || "");
      if (!/^\d{4,6}$/.test(p)) return res.json(fail("PIN 需为 4-6 位数字"));
      await db.from("staff").update({
        pin_hash: bcrypt.hashSync(p, 10),
        updated_at: nowSql(),
      }).eq("staff_id", staffId);
      return res.json(ok(null, "身份 PIN 已开启"));
    }

    if (act === "remove") {
      const pinKey = `pin:${openid}:${staffId}`;
      if (!pinAllow(pinKey)) return res.json(fail("PIN 尝试次数过多，请 15 分钟后再试", 429));
      const p = String(pin || "");
      if (!staff.pin_hash || !bcrypt.compareSync(p, staff.pin_hash)) {
        recordPinAttempt(pinKey);
        return res.json(fail("PIN 错误，请重试", 403));
      }
      clearPinAttempt(pinKey);
      await db.from("staff").update({ pin_hash: "", updated_at: nowSql() }).eq("staff_id", staffId);
      return res.json(ok(null, "身份 PIN 已关闭"));
    }

    // verify（含限流）
    const pinKey = `pin:${openid}:${staffId}`;
    if (!pinAllow(pinKey)) return res.json(fail("PIN 尝试次数过多，请 15 分钟后再试", 429));
    const okPin = staff.pin_hash && bcrypt.compareSync(String(pin || ""), staff.pin_hash);
    if (okPin) clearPinAttempt(pinKey); else recordPinAttempt(pinKey);
    res.json(ok({ valid: !!okPin, enabled: !!staff.pin_hash }, okPin ? "校验通过" : "PIN 错误"));
  } catch (e) {
    console.error("[lpAuth] pin error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== lpAuth 中间件（除 login/bind 外全部 /api/lp/*） ====================
// 每次请求实时复核：staff 有效 + 绑定未锁定，作废即刻生效
// 白名单：纯只读、不含个人数据的查询接口（如合集列表）免登录直接可调，方便未绑定/游客读取
const PUBLIC_LP_PATHS = [];

// 仅需有效会话（含未绑定用户）即可调用的只读接口：身份选择页/注销页的文案与字典支撑
// （绑定文案、字典读取不依赖业务身份，未绑定新用户选择身份前也需读取）
const SESSION_ONLY_LP_PATHS = ["/params", "/dicts"];

// 注销流程中仍放行的接口：注销状态查询 / 申请 / 撤销 + 注销页文案/字典支撑（前端 reLaunch 到注销页后需要这些）
const CANCEL_SUPPORT_PATHS = ["/account/cancel/status", "/account/cancel", "/account/cancel/revoke", "/params", "/dicts"];

/** 注销流程中是否放行该请求路径（兼容 req.path 挂载剥离与 originalUrl 两种形态） */
function isCancelSupportPath(p) {
  return CANCEL_SUPPORT_PATHS.some(k => p === k || p.endsWith(k));
}

/** 是否「仅需会话」的只读接口（未绑定用户也可读取：身份页/注销页文案字典） */
function isSessionOnlyPath(p) {
  return SESSION_ONLY_LP_PATHS.some(k => p === k || p.endsWith(k));
}

/** 注销流程中（有待生效申请）直接返回 460 并结束响应；否则返回 false 继续原逻辑 */
async function notCancelling(res, openid) {
  try {
    const { isCancelling } = require("../accountLib");
    if (await isCancelling(LP_APP.app_id, openid)) {
      res.status(460).json({ code: 460, msg: "注销申请处理中，暂无法执行该操作", data: null });
      return true;
    }
  } catch (_) { /* 查询失败不拦截，避免影响正常流程 */ }
  return false;
}

async function lpAuth(req, res, next) {
  try {
    // 白名单：GET 只读接口无需会话身份（兼容 req.path 挂载剥离与 originalUrl 两种形态）
    if (req.method === "GET") {
      const p = req.path || req.originalUrl || "";
      if (PUBLIC_LP_PATHS.some(k => p === k || p.endsWith(k))) {
        req.lp = null;
        req.lpRole = "";
        req.app = LP_APP;
        req.appId = LP_APP.app_id;
        return next();
      }
    }

    // 优先 X-LP-Token（避免与网关 Authorization 冲突）；兼容 Authorization: Bearer
    const lpHeader = req.headers["x-lp-token"] || "";
    const auth = req.headers.authorization || "";
    const token = lpHeader || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
    if (!token) {
      return res.status(401).json({ code: 401, msg: "未登录或登录已过期", data: null });
    }
    let decoded = null;
    try {
      const cfg = await getLpConfig();
      decoded = jwt.verify(token, cfg.jwtSecret);
    } catch (_) {
      return res.status(401).json({ code: 401, msg: "登录已过期，请重新登录", data: null });
    }
    const openid = decoded.openid;
    if (!openid) {
      return res.status(401).json({ code: 401, msg: "登录已过期，请重新登录", data: null });
    }

    // 数据上报 / 链路补全（collectSession / collectEvent / reportTrace）：仅需有效会话身份即可记录，
    // 未绑定/被锁定的用户（如在身份选择页）也允许上报，不拦截（前端即发即忘）
    const ap = req.path || "";
    const isReport = ap.endsWith("/collectSession") || ap.endsWith("/collectEvent") || ap.endsWith("/reportTrace");

    // 仅需会话的只读接口（/params /dicts）：身份选择页/注销页文案与字典支撑，
    // 未绑定新用户选择身份前也需读取；锁定用户除外（见下方锁定校验）。
    if (isSessionOnlyPath(ap)) {
      // 仍走锁定校验（锁定用户禁止一切，含文案接口），但不要求已绑定业务身份
      const lockRec = await userLockedUntil(openid);
      if (lockRec) {
        return res.status(403).json({
          code: 403,
          msg: lockMsg(lockRec.locked_until),
          lockUntil: lockRec.locked_until,
          lockInfo: lockInfo(lockRec),
          data: null,
        });
      }
      req.lp = { staffId: "", openid, role: "", scope: null };
      req.lpRole = "";
      req.app = LP_APP;
      req.appId = LP_APP.app_id;
      return next();
    }

    // 业务身份由「会话 openid + 活动身份 staffId」实时解析：
    // 允许 = 直接绑定（lp_students）或 家谱继承（openid 绑定的主家长名下孩子）。解除/删除即时生效。
    // 多身份：token 携带当前活动身份 staffId
    const activeStaffId = Number(decoded.staffId) || 0;

    // 锁定检查与身份可用校验相互独立，并行执行（上报接口无需校验，跳过）
    const [lockRec, usableRes] = await Promise.all([
      userLockedUntil(openid),
      isReport
        ? Promise.resolve(false)
        : openidMayUseStaff(openid, activeStaffId),
    ]);

    // 账号级锁定（后台按 user_id 锁定 t_users）：锁定期内实时拦截，作废即刻生效
    if (lockRec) {
      return res.status(403).json({
        code: 403,
        msg: lockMsg(lockRec.locked_until),
        lockUntil: lockRec.locked_until,
        lockInfo: lockInfo(lockRec),
        data: null,
      });
    }

    if (isReport) {
      req.lp = { staffId: "", openid, role: "", scope: null };
      req.lpRole = "";
      req.app = LP_APP;
      req.appId = LP_APP.app_id;
      return next();
    }

    const usable = !!usableRes;

    let staff = null;
    if (activeStaffId) {
      try { staff = await staffById(activeStaffId); } catch (_) { staff = null; }
    }

    const role = staff && LP_ROLES.includes(staff.staff_role) ? staff.staff_role : "";
    const invalid = !staff || staff.staff_status !== 1 || !role || !usable || !activeStaffId;
    if (invalid) {
      // 绑定解除/账号不可用/家谱关系断开 ≠ 账号被锁定：按会话失效处理（前端回身份页重新绑定，不展示锁定态）
      return res.status(401).json({ code: 401, msg: "绑定状态已失效，请重新绑定", data: null });
    }

    // 注销流程中（7天冷静期）：禁止访问业务系统，只能停留在注销页撤销/等待（如抖音/公众号注销流程）。
    // 仅放行注销本身 + 注销页文案支撑接口；前端收到 460 后强制 reLaunch 到注销页。
    // 注意：accountLib 与 lpAuth 相互依赖，此处延迟 require 避免模块加载期的循环依赖。
    if (!isCancelSupportPath(req.path || req.originalUrl || "")) {
      const { getPendingCancellation } = require("../accountLib");
      const pendingCancel = await getPendingCancellation(LP_APP.app_id, openid);
      if (pendingCancel) {
        return res.status(460).json({
          code: 460,
          msg: "注销申请处理中，暂无法使用业务功能",
          cancel: {
            cancel_id: String(pendingCancel.cancel_id),
            mode: pendingCancel.mode,
            status: pendingCancel.status,
            requested_at: pendingCancel.requested_at,
            effective_at: pendingCancel.effective_at || "",
          },
          data: null,
        });
      }
    }

    // 家庭可见范围（parent/family → 其名下孩子的 student staff_id 集合；admin=null 全部；student=本人）
    let scope = null;
    try { scope = await familyScope(staff.staff_id, role); } catch (_) { scope = null; }

    req.lp = {
      staffId: String(staff.staff_id),
      openid,
      role,
      scope, // 可查看/管理的孩子 student staff_id 数组；null=全部（admin）
    };
    req.lpRole = role;
    req.app = LP_APP;
    req.appId = LP_APP.app_id;
    next();
  } catch (e) {
    console.error("[lpAuth] auth error", e);
    return res.json(fail("服务异常", 500));
  }
}

module.exports = {
  router,
  lpAuth,
  LP_APP,
  LP_ROLES,
  genInviteCode,
  genUniqueInviteCode,
  createInvite,
  inviteById,
  findBindableInvite,
  staffById,
  familyScope,
  createLpAccount,
  genRandomPassword,
  signToken,
  listBoundStaffs,
  openidMayUseStaff,
  hasBoundStaff,
  activateBinding,
  verifySession,
  verifyLpToken,
};
