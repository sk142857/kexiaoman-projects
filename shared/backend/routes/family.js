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
const { LP_APP, createInvite, inviteById, staffById, createLpAccount, genRandomPassword } = require("./lpAuth");
const { logEvent } = require("../events");

const router = express.Router();

const me = (req) => String((req.lp && req.lp.staffId) || "");
const myOpenid = (req) => (req.lp && req.lp.openid) || "";
const myRole = (req) => (req.lp && req.lp.role) || "";

/** 当前用户是主家长或平台管理员 */
function isParentOrAdmin(req) {
  return ["parent", "admin"].includes(myRole(req));
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

/** 组装孩子档案返回体（含当前可用的学生邀请码） */
async function childBrief(child) {
  const code = await currentInviteForChild(child.child_id);
  let nickname = "";
  if (child.student_staff_id) {
    const s = await staffById(child.student_staff_id).catch(() => null);
    if (s) nickname = s.staff_nickname || "";
  }
  return {
    child_id: String(child.child_id),
    student_staff_id: child.student_staff_id ? String(child.student_staff_id) : "",
    child_name: child.child_name || "",
    gender: child.gender != null ? Number(child.gender) : 0,
    birth_date: child.birth_date ? String(child.birth_date).slice(0, 10) : "",
    school_name: child.school_name || "",
    grade: child.grade != null ? Number(child.grade) : 0,
    class_no: child.class_no != null ? Number(child.class_no) : 0,
    student_nickname: nickname,
    invite_code: code ? code.invite_code : "",
    invite_status: code ? code.status : "",
    invite_id: code ? String(code.invite_id) : "",
    created_at: child.created_at,
  };
}

/** 查某个孩子的当前有效学生邀请码（available 优先，无则返回最新 bound/revoked 记录） */
async function currentInviteForChild(childId) {
  if (!childId) return null;
  const { data, error } = await db.from("lp_invites")
    .select("invite_id, invite_code, kind, status, created_at")
    .eq("kind", "student").eq("child_id", Number(childId))
    .order("created_at", { ascending: false }).limit(10);
  if (error) throw error;
  const rows = data || [];
  return rows.find(r => r.status === "available") || rows[0] || null;
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
      context.children = await Promise.all((data || []).map(childBrief));
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
        context.children = await Promise.all((children || []).map(childBrief));
      }
    } else if (role === "admin") {
      const { data, error } = await db.from("lp_children")
        .select().eq("child_status", 1).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      context.children = await Promise.all((data || []).map(childBrief));
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

    const grade = Number(b.grade);
    const classNo = Number(b.class_no);
    if (!Number.isInteger(grade) || grade < 1 || grade > 6) return res.json(fail("年级需为 1-6"));
    if (!Number.isInteger(classNo) || classNo < 1 || classNo > 35) return res.json(fail("班级需为 1-35"));

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
      school_name: String(b.school_name || "").slice(0, 64),
      grade,
      class_no: classNo,
      child_status: 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });

    // 生成学生邀请码
    const inv = await createInvite({ kind: "student", ownerStaffId: student.staff_id, childId, createdBy: Number(me(req)) });

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

    await db.from("lp_children").update(values).eq("child_id", child.child_id);
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

// 作废学生邀请码（仅作废该孩子仍「待绑定」的码；已绑定码不受影响，
// 绑定访问由 lpAuth 按 staff/bound_status 实时复核，作废只影响尚未绑定的码）
router.post("/family/children/invite/revoke", async (req, res) => {
  try {
    if (!isParentOrAdmin(req)) return res.json(fail("仅主家长可管理学生邀请码", 403));
    const child = await childOwned(req, req.body && req.body.child_id);
    if (!child) return res.json(fail("孩子档案不存在或无权操作", 403));
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("kind", "student").eq("child_id", child.child_id).eq("status", "available");
    res.json(ok(null, "已作废"));
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
    const memberMap = {};
    if (memberIds.length > 0) {
      const { data: staffs } = await db.from("staff")
        .select("staff_id, staff_nickname, staff_username").in("staff_id", memberIds).limit(memberIds.length);
      (staffs || []).forEach(s => { memberMap[String(s.staff_id)] = s; });
    }
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
