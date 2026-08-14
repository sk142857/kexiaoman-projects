/**
 * 课小满小程序认证（环境内直调云托管，LP JWT）
 *
 * 两层身份，职责分离：
 *   1. 登录/会话：wx.login → code2session → openid → 签发「小程序会话 token」（仅含 openid）。
 *      与微信授权（getUserProfile 等 scope）无关，打开即得，业务后端使用不被授权流程阻塞。
 *   2. 业务身份（邀请码准入，邀请码独立维护在 t_lp_invites，不再挂 t_staff）：
 *      - 身份选择后按邀请码绑定：输入 6 位邀请码绑定 openid ↔ staff_id（t_lp_students）。
 *      - 邀请码分两类（kind）：
 *          student：学生码，由主家长在孩子档案中生成；绑定孩子学生账号（role=student），仅可绑一次。
 *          family：家属共享码，由主家长生成（单次使用，绑定即作废）；绑定后建家属账号（role=family）并写入家属关系。
 *      - 有码 → 能进业务页面；无码 → 进身份选择/绑定页；邀请码作废 → 立即锁定。
 *
 * 运行配置来源（t_apps.app_id = learning-planet）：
 *   wechat_appid  课小满 AppID
 *   app_secret    课小满 AppSecret（code2session）
 *   jwt_secret    课小满 JWT 签名密钥
 *   jwt_expires   登录态有效期（默认 7d）
 * 短 TTL 缓存（60s），后台改配置后最多 60s 生效；未配置时回退内置弱密钥并告警
 */
const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql } = require("../utils");
const { nextSeq } = require("../seq");
const { ensureUser } = require("../appAuth");
const { getAppConfig } = require("../apps");

const router = express.Router();

// ==================== 应用常量 ====================
const LP_APP = { app_id: "learning-planet", app_name: "课小满", wechat_appid: "wxa8035a4cd63554fe", app_status: 1 };

// 邀请码字符集：排除易混淆 0/O/1/I
const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 角色白名单
const LP_ROLES = ["admin", "parent", "family", "student"];

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
    jwtSecret: (row && row.jwt_secret) || "lp-insecure-fallback",
    jwtExpires: (row && row.jwt_expires) || "7d",
  };
  if (!cfg.appSecret) {
    console.warn("[lpAuth] 警告：t_apps 中课小满未配置 app_secret，code2session 登录将失败（请在后端「小程序配置」中填写）");
  }
  if (!(row && row.jwt_secret)) {
    console.warn("[lpAuth] 警告：t_apps 中课小满未配置 jwt_secret，已回退内置弱密钥（请尽快在后台配置）");
  }
  lpConfigCache = cfg;
  lpConfigAt = now;
  return cfg;
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

/** 按邀请码查找可绑定的邀请记录（学生码或家属码，未绑定且未作废） */
async function findBindableInvite(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) return null;
  const { data, error } = await db.from("lp_invites")
    .select("invite_id, invite_code, kind, owner_staff_id, child_id, status")
    .eq("invite_code", c).limit(1);
  if (error) throw error;
  const inv = data && data[0];
  if (!inv || !["student", "family"].includes(inv.kind) || inv.status !== "available") return null;
  return inv;
}

/** 签发学习星球会话 JWT（仅含小程序用户身份 openid；业务身份由邀请码绑定实时解析） */
async function signToken(openid) {
  const cfg = await getLpConfig();
  return jwt.sign(
    { openid, appId: LP_APP.app_id },
    cfg.jwtSecret,
    { expiresIn: cfg.jwtExpires }
  );
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
  return {
    staff_id: String(s.staff_id),
    nickname: s.staff_nickname || (s.staff_role === "admin" ? "管理员" : "学生"),
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

/** 生成唯一登录账号（如 fm_xxx / st_xxx，保证唯一） */
async function genUniqueUsername(prefix) {
  for (let i = 0; i < 8; i++) {
    const uname = `${prefix}${Date.now().toString(36)}${crypto.randomInt(100, 999)}`;
    const { data, error } = await db.from("staff").select("staff_id").eq("staff_username", uname).limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return uname;
  }
  return `${prefix}${Date.now()}`;
}

/** 为家长/家属/学生创建 t_staff 账号（家长有后台登录能力，家属/学生无，随机占位密码） */
async function createLpAccount({ role, nickname, openid }) {
  const prefix = role === "family" ? "fm_" : role === "parent" ? "pt_" : "st_";
  const username = await genUniqueUsername(prefix);
  const password = genRandomPassword();
  const staffId = await nextSeq("staff_id");
  const values = {
    staff_id: staffId,
    staff_username: username,
    staff_password: require("bcryptjs").hashSync(password, 10),
    staff_nickname: String(nickname || "").slice(0, 32),
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
  if (role === "student") return [staffId];
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
  return null; // admin 全部
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
      console.error("[lpAuth] code2session error", e.message);
      return res.json(fail("登录失败，请稍后重试", 401));
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 只要 wx.login 成功就签发会话 token；能否进业务页由邀请码绑定决定
    const token = await signToken(openid);

    const { data: rows, error } = await db.from("lp_students")
      .select().eq("app_id", LP_APP.app_id).eq("openid", openid).limit(1);
    if (error) throw error;
    const bind = rows && rows[0];

    // 未绑定 → 前端展示身份选择/绑定界面
    if (!bind) {
      return res.json(ok({ token, bound: false, locked: false, msg: "请选择身份并输入邀请码完成绑定" }));
    }

    // 已绑定 → 实时校验绑定状态
    // 区分新老用户：只有存在「绑定取消/锁定记录」(bound_status=0) 才向用户展示锁定；
    // 新用户（无绑定记录）在上方直接返回，永远不会有锁定
    if (bind.bound_status !== 1) {
      return res.json(ok({ token, bound: false, locked: true, msg: "您的绑定已解除，请输入新的邀请码重新绑定" }));
    }
    // 绑定记录仍有效但账号不可用（员工被删除/停用）→ 不锁定，走正常换绑流程
    const staff = await staffById(bind.staff_id);
    if (!staff || staff.staff_status !== 1) {
      return res.json(ok({ token, bound: false, locked: false, msg: "当前绑定账号不可用，请更换邀请码" }));
    }

    touchUserProfile(openid);
    res.json(ok({
      token,
      bound: true,
      locked: false,
      role: staff.staff_role,
      staff: staffBrief(staff),
    }, "登录成功"));
  } catch (e) {
    console.error("[lpAuth] login error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 身份选择：注册为主家长（首次静默登录后） ====================
// 用户确认「我是家长」→ 自动创建 t_staff(role=parent) + 自动绑定当前 openid +
// 生成家属共享码 + 下发后台登录账号（明文密码仅此一次）。
// 已绑定用户调用会返回当前绑定状态，不重复创建。
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
        console.error("[lpAuth] registerParent code2session error", e.message);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 已绑定 → 返回当前状态
    const { data: rows, error } = await db.from("lp_students")
      .select().eq("app_id", LP_APP.app_id).eq("openid", openid).limit(1);
    if (error) throw error;
    const bind = rows && rows[0];
    if (bind && bind.bound_status === 1) {
      const cur = await staffById(bind.staff_id);
      if (cur && cur.staff_status === 1) {
        const token = await signToken(openid);
        return res.json(ok({
          token, bound: true, role: cur.staff_role, staff: staffBrief(cur),
        }, "已注册"));
      }
    }

    // 家长昵称（可选，来自前端微信昵称）
    const nickname = String((req.body || {}).nickname || "").trim().slice(0, 32);

    // 创建家长账号 + 随机后台登录密码（明文仅此一次返回）
    const parent = await createLpAccount({ role: "parent", nickname: nickname || "家长", openid });
    const password = parent.password;

    // 自动绑定当前 openid ↔ 家长账号
    if (bind) {
      await db.from("lp_students")
        .update({ staff_id: parent.staff_id, bound_status: 1, updated_at: nowSql() })
        .eq("id", bind.id).eq("app_id", LP_APP.app_id).eq("openid", openid);
    } else {
      await db.from("lp_students").insert({
        staff_id: parent.staff_id,
        app_id: LP_APP.app_id,
        openid,
        bound_status: 1,
        bound_at: nowSql(),
        created_at: nowSql(),
        updated_at: nowSql(),
      });
    }

    // 生成家属共享码（单次使用，kind=family）
    const share = await createInvite({ kind: "family", ownerStaffId: parent.staff_id, childId: 0, createdBy: parent.staff_id });

    touchUserProfile(openid);
    const token = await signToken(openid);
    res.json(ok({
      token,
      bound: true,
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

// ==================== 绑定邀请码（会话 token 已含 openid，只需邀请码） ====================
// 按 kind 分支：
//   student：学生码，绑定孩子学生账号（role=student），码置 bound；
//   family：家属共享码，单次使用，创建家属账号（role=family）+ 写家属关系 + 码置 bound。
router.post("/bind", async (req, res) => {
  try {
    const { code, rebind } = req.body || {};
    let openid = await verifySession(req);
    // 兼容：无会话 token 时回退到旧的 loginCode 换 openid
    if (!openid) {
      const loginCode = (req.body || {}).loginCode;
      if (!loginCode) return res.json(fail("缺少登录凭证"));
      try {
        const wx = await code2session(loginCode);
        openid = wx.openid || "";
      } catch (e) {
        console.error("[lpAuth] bind code2session error", e.message);
        return res.json(fail("登录失败，请稍后重试", 401));
      }
    }
    if (!openid) return res.json(fail("登录失败，未获取到用户身份", 401));

    // 限流：同一 openid 15 分钟内最多尝试 10 次
    if (!bindAllow(openid)) return res.json(fail("尝试过于频繁，请 15 分钟后再试", 429));
    recordBindAttempt(openid);

    const inv = await findBindableInvite(code);
    if (!inv) return res.json(fail("邀请码无效、已被绑定或已作废", 400));

    // ==================== 学生码绑定 ====================
    if (inv.kind === "student") {
      const student = await staffById(inv.owner_staff_id);
      if (!student || student.staff_role !== "student" || student.staff_status !== 1) {
        return res.json(fail("该学生账号不可用，请联系家长", 400));
      }
      // 当前 openid 是否已绑定
      const { data: rows, error } = await db.from("lp_students")
        .select().eq("app_id", LP_APP.app_id).eq("openid", openid).limit(1);
      if (error) throw error;
      if (rows && rows[0]) {
        const b = rows[0];
        // 同码重复绑定（含网络失败后的重试）：幂等返回成功
        if (String(b.staff_id) === String(student.staff_id)) {
          if (b.bound_status !== 1) {
            await db.from("lp_students")
              .update({ bound_status: 1, updated_at: nowSql() })
              .eq("id", b.id).eq("app_id", LP_APP.app_id).eq("openid", openid);
          }
          const token = await signToken(openid);
          return res.json(ok({ token, bound: true, role: student.staff_role, staff: staffBrief(student) }, "绑定成功"));
        }
        // 已绑定其他账号：当前绑定仍有效（账号在职 + 绑定未锁定）且未显式申请重绑 → 拒绝
        let currentValid = false;
        try {
          const cur = await staffById(b.staff_id);
          currentValid = !!(cur && cur.staff_status === 1 && b.bound_status === 1);
        } catch (_) { currentValid = false; }
        if (currentValid && !rebind) {
          return res.json(fail("该账号已绑定其他邀请码，如需更换请重新绑定", 400));
        }
        await db.from("lp_students")
          .update({ staff_id: student.staff_id, bound_status: 1, updated_at: nowSql() })
          .eq("id", b.id).eq("app_id", LP_APP.app_id).eq("openid", openid);
      } else {
        await db.from("lp_students").insert({
          staff_id: student.staff_id,
          app_id: LP_APP.app_id,
          openid,
          bound_status: 1,
          bound_at: nowSql(),
          created_at: nowSql(),
          updated_at: nowSql(),
        });
      }
      // 邀请码置为已绑定
      await db.from("lp_invites").update({
        status: "bound",
        bound_openid: openid,
        bound_staff_id: student.staff_id,
        bound_at: nowSql(),
        updated_at: nowSql(),
      }).eq("invite_id", inv.invite_id);
      touchUserProfile(openid);
      const token = await signToken(openid);
      return res.json(ok({
        token,
        bound: true,
        role: student.staff_role,
        staff: staffBrief(student),
      }, "绑定成功"));
    }

    // ==================== 家属共享码绑定（单次使用） ====================
    const owner = await staffById(inv.owner_staff_id);
    if (!owner || owner.staff_role !== "parent" || owner.staff_status !== 1) {
      return res.json(fail("主家长账号不可用，请联系主家长", 400));
    }
    // 该 openid 已绑定家属关系 → 幂等返回
    const { data: exRows, error: exErr } = await db.from("lp_students")
      .select().eq("app_id", LP_APP.app_id).eq("openid", openid).limit(1);
    if (exErr) throw exErr;
    if (exRows && exRows[0]) {
      const b = exRows[0];
      const curStaff = await staffById(b.staff_id);
      // 已是家属身份：若非同一主家长的家属，需显式换绑（rebind）
      if (curStaff && curStaff.staff_role === "family") {
        const { data: fm, error: fmErr } = await db.from("lp_family_members")
          .select("id").eq("member_staff_id", Number(curStaff.staff_id))
          .eq("owner_staff_id", Number(inv.owner_staff_id))
          .eq("member_status", 1).limit(1);
        if (fmErr) throw fmErr;
        if (fm && fm[0] && b.bound_status === 1 && curStaff.staff_status === 1) {
          const token = await signToken(openid);
          return res.json(ok({ token, bound: true, role: curStaff.staff_role, staff: staffBrief(curStaff) }, "绑定成功"));
        }
        // 已是别的家庭家属，未显式重绑 → 拒绝（身份一次性锁定）
        if (b.bound_status === 1 && curStaff.staff_status === 1 && !rebind) {
          return res.json(fail("该账号已绑定其他家庭，如需更换请重新绑定", 400));
        }
      } else if (b.bound_status === 1 && curStaff && curStaff.staff_status === 1 && !rebind) {
        // 已绑定学生/家长等其他身份：禁止直接换成家属（身份一次性锁定）
        return res.json(fail("该账号已绑定其他身份，如需更换请重新绑定", 400));
      }
    }

    // 创建家属账号
    const fam = await createLpAccount({
      role: "family",
      nickname: `家属${String(owner.staff_nickname || "").slice(0, 4) || ""}`,
      openid,
    });
    // 绑定映射
    const { data: rows2, error: err2 } = await db.from("lp_students")
      .select().eq("app_id", LP_APP.app_id).eq("openid", openid).limit(1);
    if (err2) throw err2;
    if (rows2 && rows2[0]) {
      await db.from("lp_students")
        .update({ staff_id: fam.staff_id, bound_status: 1, updated_at: nowSql() })
        .eq("id", rows2[0].id).eq("app_id", LP_APP.app_id).eq("openid", openid);
    } else {
      await db.from("lp_students").insert({
        staff_id: fam.staff_id,
        app_id: LP_APP.app_id,
        openid,
        bound_status: 1,
        bound_at: nowSql(),
        created_at: nowSql(),
        updated_at: nowSql(),
      });
    }
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
    // 邀请码置为已绑定（单次使用）
    await db.from("lp_invites").update({
      status: "bound",
      bound_openid: openid,
      bound_staff_id: fam.staff_id,
      bound_at: nowSql(),
      updated_at: nowSql(),
    }).eq("invite_id", inv.invite_id);

    touchUserProfile(openid);
    const token = await signToken(openid);
    res.json(ok({
      token,
      bound: true,
      role: "family",
      staff: { staff_id: String(fam.staff_id), nickname: fam.nickname, username: fam.username, role: "family" },
    }, "绑定成功"));
  } catch (e) {
    console.error("[lpAuth] bind error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== lpAuth 中间件（除 login/bind 外全部 /api/lp/*） ====================
// 每次请求实时复核：staff 有效 + 绑定未锁定，作废即刻生效
// 白名单：纯只读、不含个人数据的查询接口（如合集列表）免登录直接可调，方便未绑定/游客读取
const PUBLIC_LP_PATHS = ["/collections"];

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

    // 业务身份由「会话 openid ↔ 邀请码绑定」实时解析，绑定换绑即时生效
    let bind = null;
    try {
      const { data } = await db.from("lp_students")
        .select().eq("app_id", LP_APP.app_id).eq("openid", openid).limit(1);
      bind = (data && data[0]) || null;
    } catch (_) { /* 查询失败按未绑定处理 */ }

    let staff = null;
    if (bind) {
      try { staff = await staffById(bind.staff_id); } catch (_) { staff = null; }
    }

    const role = staff && LP_ROLES.includes(staff.staff_role) ? staff.staff_role : "";
    const locked = !staff || staff.staff_status !== 1 || !role || !bind || bind.bound_status !== 1;
    if (locked) {
      return res.status(403).json({ code: 403, msg: "访问已锁定，请联系管理员", data: null });
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
};
