/**
 * 课小满家庭/家长业务路由（孩子档案 / 邀请码管理 / 家属共享 / 后台密码）
 *
 * 身份：lpAuth 中间件注入 req.lp = { staffId, openid, role, scope }
 *   role：parent（主家长）/ family（家属）/ student（学生）/ admin（平台管理员）
 * 权限：
 *   parent 主家长：孩子档案维护、学生码生成/作废、共享码生成/作废、后台密码重置
 *   family 家属：仅查看孩子档案（只读），无码管理权限
 *   student 学生：无家庭权限
 *   admin 平台管理员：可管理任意家庭（scope=null）
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql } = require("../utils");
const { nextSeq } = require("../seq");
const { LP_APP, createInvite, inviteById, staffById, createLpAccount, genRandomPassword, activateBinding } = require("./lpAuth");
const { logEvent } = require("../events");
const { invalidateStaffRows, cachedStaffRows } = require("../learningLib");
const { textCheckNow, submitForAudit } = require("../contentSecurity");

const router = express.Router();

const me = (req) => String((req.lp && req.lp.staffId) || "");
const myOpenid = (req) => (req.lp && req.lp.openid) || "";
const myRole = (req) => (req.lp && req.lp.role) || "";

/** 孩子档案文本写时内容安全校验；命中违规返回 { error }，否则返回各字段检测结果（安全关闭/失败时放行） */
async function auditChildText(req, { name, schoolName }) {
  let nameCheck = null;
  let schoolCheck = null;
  try {
    if (name) nameCheck = await textCheckNow({ appId: req.appId, content: name, openid: myOpenid(req) });
    if (schoolName) schoolCheck = await textCheckNow({ appId: req.appId, content: schoolName, openid: myOpenid(req) });
  } catch (e) {
    console.error("[lp] 孩子档案内容安全校验失败（放行）", e);
  }
  if (nameCheck && nameCheck.status === "reject") return { error: "孩子姓名包含违规内容，请修改后重试", nameCheck, schoolCheck };
  if (schoolCheck && schoolCheck.status === "reject") return { error: "学校名称包含违规内容，请修改后重试", nameCheck, schoolCheck };
  return { nameCheck, schoolCheck };
}

/** 孩子档案文本预检结果审计留痕（t_content_audits，biz_type=child） */
function logChildAudit(req, childId, { nameCheck, schoolCheck, name, schoolName }) {
  const base = { appId: req.appId, bizType: "child", bizId: childId, mediaType: 1, openid: myOpenid(req) };
  if (nameCheck && !nameCheck.skipped) {
    submitForAudit({ ...base, field: "child_name", content: name, status: nameCheck.status, detail: String((nameCheck.data && nameCheck.data.result && nameCheck.data.result.label) || ""), wx_raw: nameCheck.data }).catch(() => {});
  }
  if (schoolCheck && !schoolCheck.skipped) {
    submitForAudit({ ...base, field: "school_name", content: schoolName, status: schoolCheck.status, detail: String((schoolCheck.data && schoolCheck.data.result && schoolCheck.data.result.label) || ""), wx_raw: schoolCheck.data }).catch(() => {});
  }
}

/** 当前用户是主家长或平台管理员 */
function isParentOrAdmin(req) {
  return ["parent", "admin"].includes(myRole(req));
}

/**
 * 把新建孩子账号自动绑定到主家长的 openid（家长可一键切到孩子身份，不消耗学生邀请码）。
 * 仅在 t_lp_students 追加 (parent openid ↔ 孩子) 行，孩子本人在其它设备绑定的账号不受影响。
 * 主家长尚未登录过小程序（无绑定记录）时静默跳过，登录后经 switchChild 接口按需绑定。
 */
async function autoBindChild(parentStaffId, childStaffId) {
  try {
    const { data, error } = await db.from("lp_students")
      .select("openid").eq("app_id", LP_APP.app_id)
      .eq("staff_id", Number(parentStaffId)).eq("bound_status", 1).limit(50);
    if (error) throw error;
    const openids = [...new Set((data || []).map(r => r.openid).filter(Boolean))];
    for (const openid of openids) {
      await activateBinding(openid, childStaffId);
    }
  } catch (e) {
    console.error("[lp] auto bind child to parent error", e);
  }
}

/** 当前用户的家庭范围（孩子 student staff_id 集合）；admin=null 全部 */
function myScope(req) {
  return req.lp && req.lp.scope;
}

/** 按 child_id 查孩子档案并校验归属（parent=本人名下；admin=任意；family/student=拒绝写） */
async function childOwned(req, childId, { forWrite = true } = {}) {
  if (!childId) return null;
  const { data, error } = await db.from("lp_children")
    .select().eq("child_id", Number(childId)).eq("child_status", 1).limit(1);
  if (error) throw error;
  const child = data && data[0];
  if (!child) return null;
  const role = myRole(req);
  if (role === "admin") return child;
  if (role === "parent" && String(child.parent_staff_id) === me(req)) return child;
  return null;
}

/** 批量组装孩子档案返回体（含当前可用的学生邀请码）：一次 IN 取邀请码 + 员工昵称，避免逐孩子 N+1 */
async function childrenBrief(children) {
  const list = children || [];
  if (list.length === 0) return [];
  const childIds = [...new Set(list.map(c => Number(c.child_id)).filter(Boolean))];
  const staffIds = [...new Set(list.map(c => Number(c.student_staff_id)).filter(Boolean))];

  const [invRes, staffMap] = await Promise.all([
    childIds.length > 0
      ? db.from("lp_invites")
          .select("invite_id, invite_code, kind, status, child_id, created_at")
          .eq("kind", "student").in("child_id", childIds)
          .order("created_at", { ascending: false }).limit(childIds.length * 10)
      : Promise.resolve({ data: [], error: null }),
    cachedStaffRows(staffIds),
  ]);
  if (invRes.error) throw invRes.error;
  // 每个孩子：available 优先，否则取最新一条（已按 created_at 倒序）
  const byChild = {};
  (invRes.data || []).forEach(r => {
    const k = String(r.child_id);
    (byChild[k] = byChild[k] || []).push(r);
  });
  Object.keys(byChild).forEach(k => {
    const rows = byChild[k];
    byChild[k] = rows.find(r => r.status === "available") || rows[0];
  });

  return list.map(child => {
    const code = byChild[String(child.child_id)] || null;
    const s = child.student_staff_id ? (staffMap[String(child.student_staff_id)] || {}) : {};
    return {
      child_id: String(child.child_id),
      student_staff_id: child.student_staff_id ? String(child.student_staff_id) : "",
      child_name: child.child_name || "",
      gender: child.gender != null ? Number(child.gender) : 0,
      birth_date: child.birth_date ? String(child.birth_date).slice(0, 10) : "",
      school_name: child.school_name || "",
      grade: child.grade != null ? Number(child.grade) : 0,
      class_no: child.class_no != null ? Number(child.class_no) : 0,
      student_nickname: s.staff_nickname || "",
      invite_code: code ? code.invite_code : "",
      invite_status: code ? code.status : "",
      invite_id: code ? String(code.invite_id) : "",
      created_at: child.created_at,
    };
  });
}

/** 单个孩子档案（复用批量逻辑） */
async function childBrief(child) {
  const arr = await childrenBrief([child]);
  return arr[0];
}

// ==================== 我的家庭上下文 ====================
router.get("/family/context", async (req, res) => {
  try {
    const role = myRole(req);
    const context = {
      role,
      children: [],
      member_of: null,   // family：所属主家长
      parent_account: null, // parent：后台登录账号
    };

    if (role === "parent") {
      const { data, error } = await db.from("lp_children")
        .select().eq("parent_staff_id", Number(me(req))).eq("child_status", 1)
        .order("created_at", { ascending: true }).limit(100);
      if (error) throw error;
      const staff = await staffById(Number(me(req)));
      context.children = await childrenBrief(data || []);
      context.parent_account = staff ? { username: staff.staff_username, nickname: staff.staff_nickname } : null;
    } else if (role === "family") {
      const { data: members, error: mErr } = await db.from("lp_family_members")
        .select("owner_staff_id").eq("member_staff_id", Number(me(req))).eq("member_status", 1).limit(50);
      if (mErr) throw mErr;
      const owners = (members || []).map(m => Number(m.owner_staff_id)).filter(Boolean);
      if (owners.length > 0) {
        const { data: children, error: cErr } = await db.from("lp_children")
          .select().in("parent_staff_id", owners).eq("child_status", 1)
          .order("created_at", { ascending: true }).limit(200);
        if (cErr) throw cErr;
        context.member_of = owners.map(o => String(o));
        context.children = await childrenBrief(children || []);
      }
    } else if (role === "admin") {
      const { data, error } = await db.from("lp_children")
        .select().eq("child_status", 1).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      context.children = await childrenBrief(data || []);
    }

    res.json(ok(context));
  } catch (e) {
    console.error("[lp] family context error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 孩子档案维护（parent/admin） ====================
// 新增孩子：自动建 t_staff(role=student) 占位密码 + 生成学生邀请码（kind=student，关联孩子）
router.post("/family/children/create", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可维护孩子档案", 403));
    const b = req.body || {};
    const name = String(b.child_name || "").trim().slice(0, 32);
    if (!name) return res.json(fail("请填写孩子姓名"));
    const schoolName = String(b.school_name || "").trim().slice(0, 64);

    const grade = Number(b.grade);
    const classNo = Number(b.class_no);
    if (!Number.isInteger(grade) || grade < 1 || grade > 6) return res.json(fail("年级需为 1-6"));
    if (!Number.isInteger(classNo) || classNo < 1 || classNo > 35) return res.json(fail("班级需为 1-35"));

    // 内容安全：孩子档案文本写时校验（命中违规拒绝；检测失败/关闭放行）
    const audit = await auditChildText(req, { name, schoolName });
    if (audit.error) return res.json(fail(audit.error));

    const parentId = myRole(req) === "admin" ? Number(b.parent_staff_id) || 0 : Number(me(req));
    if (!parentId) return res.json(fail("缺少主家长账号"));

    // 建学生账号（占位密码，无后台登录能力）
    const student = await createLpAccount({ role: "student", nickname: name, openid: "" });

    const childId = await nextSeq("child_id");
    await db.from("lp_children").insert({
      child_id: childId,
      app_id: LP_APP.app_id,
      parent_staff_id: parentId,
      student_staff_id: student.staff_id,
      child_name: name,
      gender: Number(b.gender) || 0,
      birth_date: String(b.birth_date || "").slice(0, 10) || null,
      school_name: schoolName,
      grade,
      class_no: classNo,
      child_status: 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });

    // 内容安全：预检结果审计留痕
    logChildAudit(req, childId, { nameCheck: audit.nameCheck, schoolCheck: audit.schoolCheck, name, schoolName });

    // 生成学生邀请码
    const inv = await createInvite({ kind: "student", ownerStaffId: student.staff_id, childId, createdBy: Number(me(req)) });

    // 一键切换支持：把新建孩子账号绑定到主家长 openid（幂等；不消耗学生邀请码，孩子本人账号不受影响）
    await autoBindChild(parentId, student.staff_id);

    logEvent({
      appId: LP_APP.app_id, openid: myOpenid(req), eventType: "create", eventName: "新增孩子档案",
      pagePath: "/pages/child-edit/index", bizId: String(childId),
      extra: { child_name: name, grade, class_no: classNo },
    });
    const { data: fresh, error: freshErr } = await db.from("lp_children").select().eq("child_id", childId).limit(1);
    if (freshErr) throw freshErr;
    res.json(ok(await childBrief(fresh && fresh[0]), "已添加，可分享学生邀请码给孩子绑定"));
  } catch (e) {
    console.error("[lp] child create error", e);
    res.json(fail("服务异常", 500));
  }
});

// 更新孩子档案（基础信息；不含邀请码）
router.post("/family/children/update", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可维护孩子档案", 403));
    const b = req.body || {};
    const child = await childOwned(req, b.child_id);
    if (!child) return res.json(fail("孩子档案不存在或无权操作", 403));

    const values = { updated_at: nowSql() };
    if (b.child_name !== undefined) {
      const n = String(b.child_name).trim().slice(0, 32);
      if (!n) return res.json(fail("请填写孩子姓名"));
      values.child_name = n;
      if (child.student_staff_id) {
        await db.from("staff").update({ staff_nickname: n, updated_at: nowSql() }).eq("staff_id", Number(child.student_staff_id));
        // 失效 staff 行缓存（孩子改名立即生效）
        try { invalidateStaffRows([Number(child.student_staff_id)]); } catch (_) {}
      }
    }
    if (b.gender !== undefined) values.gender = Number(b.gender) || 0;
    if (b.birth_date !== undefined) values.birth_date = String(b.birth_date || "").slice(0, 10) || null;
    if (b.school_name !== undefined) values.school_name = String(b.school_name || "").slice(0, 64);
    if (b.grade !== undefined) {
      const grade = Number(b.grade);
      if (!Number.isInteger(grade) || grade < 1 || grade > 6) return res.json(fail("年级需为 1-6"));
      values.grade = grade;
    }
    if (b.class_no !== undefined) {
      const classNo = Number(b.class_no);
      if (!Number.isInteger(classNo) || classNo < 1 || classNo > 35) return res.json(fail("班级需为 1-35"));
      values.class_no = classNo;
    }
    if (Object.keys(values).length === 1) return res.json(ok(null, "无变更"));

    // 内容安全：本次有变更的文本字段写时校验（命中违规拒绝；检测失败/关闭放行）
    const audit = await auditChildText(req, {
      name: b.child_name !== undefined ? String(b.child_name).trim().slice(0, 32) : "",
      schoolName: b.school_name !== undefined ? String(b.school_name).trim().slice(0, 64) : "",
    });
    if (audit.error) return res.json(fail(audit.error));

    await db.from("lp_children").update(values).eq("child_id", child.child_id);
    // 内容安全：预检结果审计留痕
    logChildAudit(req, child.child_id, {
      nameCheck: audit.nameCheck, schoolCheck: audit.schoolCheck,
      name: values.child_name !== undefined ? String(values.child_name) : "",
      schoolName: values.school_name !== undefined ? String(values.school_name) : "",
    });
    const { data: fresh, error: freshErr } = await db.from("lp_children").select().eq("child_id", child.child_id).limit(1);
    if (freshErr) throw freshErr;
    res.json(ok(await childBrief(fresh && fresh[0]), "已更新"));
  } catch (e) {
    console.error("[lp] child update error", e);
    res.json(fail("服务异常", 500));
  }
});

// 删除孩子档案（软删；同时作废其学生码并禁用学生账号）
router.post("/family/children/delete", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可维护孩子档案", 403));
    const child = await childOwned(req, req.body && req.body.child_id);
    if (!child) return res.json(fail("孩子档案不存在或无权操作", 403));

    await db.from("lp_children").update({ child_status: 0, updated_at: nowSql() }).eq("child_id", child.child_id);
    // 作废该孩子全部未绑定学生码
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("kind", "student").eq("child_id", child.child_id).eq("status", "available");
    if (child.student_staff_id) {
      await db.from("staff").update({ staff_status: 0, updated_at: nowSql() }).eq("staff_id", Number(child.student_staff_id));
      // 同步锁定该学生名下已绑定的小程序访问（与后台作废语义一致，避免「档案已删、绑定仍显示正常」的残留）
      await db.from("lp_students").update({ bound_status: 0, updated_at: nowSql() })
        .eq("staff_id", Number(child.student_staff_id)).eq("bound_status", 1);
    }
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[lp] child delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 学生邀请码管理（parent/admin） ====================
// 重新生成：作废旧码，发新码（旧码已绑定的孩子不受影响，新码供换绑/新设备）
router.post("/family/children/invite", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可管理学生邀请码", 403));
    const child = await childOwned(req, req.body && req.body.child_id);
    if (!child) return res.json(fail("孩子档案不存在或无权操作", 403));
    if (!child.student_staff_id) return res.json(fail("该孩子暂无学生账号"));

    // 作废旧的有效码
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("kind", "student").eq("child_id", child.child_id).eq("status", "available");
    const inv = await createInvite({ kind: "student", ownerStaffId: child.student_staff_id, childId: child.child_id, createdBy: Number(me(req)) });
    res.json(ok({ invite_id: inv.invite_id, invite_code: inv.invite_code, status: "available" }, "新邀请码已生成（旧码已作废）"));
  } catch (e) {
    console.error("[lp] child invite error", e);
    res.json(fail("服务异常", 500));
  }
});

// 作废学生邀请码：作废该孩子全部学生码（待绑定 + 已绑定），并立即删除孩子侧的绑定设备关系
// （主家长最高权限：作废邀请码后，孩子小程序绑定立即失效，由 lpAuth 实时复核锁定）。
router.post("/family/children/invite/revoke", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可管理学生邀请码", 403));
    const child = await childOwned(req, req.body && req.body.child_id);
    if (!child) return res.json(fail("孩子档案不存在或无权操作", 403));
    // 作废该孩子全部学生码（available 未绑定 + bound 已绑定）
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("kind", "student").eq("child_id", child.child_id).in("status", ["available", "bound"]);
    // 立即删除孩子侧的绑定设备关系（清除绑定，孩子端实时被踢出）
    if (child.student_staff_id) {
      await db.from("lp_students").update({ bound_status: 0, updated_at: nowSql() })
        .eq("staff_id", Number(child.student_staff_id)).eq("bound_status", 1);
    }
    res.json(ok(null, "已作废" + (child.student_staff_id ? "，孩子绑定设备关系已删除" : "")));
  } catch (e) {
    console.error("[lp] child invite revoke error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 家属共享码管理（parent/admin） ====================
// 生成共享码（kind=family，单次使用，绑定即作废）；作废即移除对应家属访问
router.post("/family/share/generate", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可共享", 403));
    const ownerId = myRole(req) === "admin" ? Number((req.body || {}).parent_staff_id) || 0 : Number(me(req));
    if (!ownerId) return res.json(fail("缺少主家长账号"));
    const owner = await staffById(ownerId);
    if (!owner || owner.staff_role !== "parent") return res.json(fail("主家长账号不存在", 400));

    const inv = await createInvite({ kind: "family", ownerStaffId: ownerId, childId: 0, createdBy: Number(me(req)) });
    res.json(ok({ invite_id: inv.invite_id, invite_code: inv.invite_code, status: "available" }, "共享码已生成，可发给家属（单次使用）"));
  } catch (e) {
    console.error("[lp] share generate error", e);
    res.json(fail("服务异常", 500));
  }
});

// 作废共享码（未绑定的码直接作废；已绑定家属 → 码作废 + 解除家属关系 + 锁定其小程序访问）
router.post("/family/share/revoke", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可共享", 403));
    const { invite_id } = req.body || {};
    const inv = await inviteById(invite_id);
    if (!inv || inv.kind !== "family") return res.json(fail("共享码不存在", 400));
    // 归属校验：非 admin 只能作废自己的共享码
    if (myRole(req) !== "admin" && String(inv.owner_staff_id) !== me(req)) {
      return res.json(fail("无权操作该共享码", 403));
    }
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() }).eq("invite_id", inv.invite_id);
    // 已绑定：解除家属关系 + 锁定小程序访问
    if (inv.bound_staff_id) {
      await db.from("lp_family_members").update({ member_status: 0, updated_at: nowSql() })
        .eq("owner_staff_id", inv.owner_staff_id).eq("member_staff_id", inv.bound_staff_id);
      await db.from("lp_students").update({ bound_status: 0, updated_at: nowSql() }).eq("staff_id", inv.bound_staff_id);
    }
    res.json(ok(null, "共享码已作废" + (inv.bound_staff_id ? "，已解除对应家属访问" : "")));
  } catch (e) {
    console.error("[lp] share revoke error", e);
    res.json(fail("服务异常", 500));
  }
});

// 我的共享记录（主家长视角）：全部共享码 + 已绑定家属
router.get("/family/shares", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可查看共享", 403));
    const ownerId = myRole(req) === "admin" ? Number((req.query || {}).parent_staff_id) || 0 : Number(me(req));
    if (!ownerId) return res.json(fail("缺少主家长账号"));
    const { data, error } = await db.from("lp_invites")
      .select().eq("kind", "family").eq("owner_staff_id", ownerId)
      .order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const memberIds = [...new Set((data || []).map(r => r.bound_staff_id).filter(v => v > 0))];
    const memberMap = await cachedStaffRows(memberIds);
    res.json(ok({
      list: (data || []).map(r => ({
        invite_id: String(r.invite_id),
        invite_code: r.invite_code,
        status: r.status,
        bound_staff_id: r.bound_staff_id ? String(r.bound_staff_id) : "",
        bound_member: r.bound_staff_id ? (memberMap[String(r.bound_staff_id)] || {}).staff_nickname || "" : "",
        bound_at: r.bound_at,
        created_at: r.created_at,
      })),
    }));
  } catch (e) {
    console.error("[lp] shares list error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 后台密码（parent，明文仅创建/重置时下发一次） ====================
// 重置密码：返回明文一次（前端掩码显示 + 点击查看）
router.post("/family/password/reset", async (req, res) => {
  try {
    if (myRole(req) !== "parent") return res.json(fail("仅主家长可重置后台密码", 403));
    const newPwd = genRandomPassword(8);
    await db.from("staff").update({
      staff_password: bcrypt.hashSync(newPwd, 10),
      updated_at: nowSql(),
    }).eq("staff_id", Number(me(req)));
    logEvent({
      appId: LP_APP.app_id, openid: myOpenid(req), eventType: "update", eventName: "重置后台登录密码",
      pagePath: "/pages/backend-account/index",
    });
    res.json(ok({ password: newPwd }, "新密码已生成，请妥善保存（仅展示一次）"));
  } catch (e) {
    console.error("[lp] password reset error", e);
    res.json(fail("服务异常", 500));
  }
});

module.exports = router;
