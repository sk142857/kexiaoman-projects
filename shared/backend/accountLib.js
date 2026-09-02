/**
 * 账号注销（家长/个人）
 *
 * 数据表：t_lp_account_cancellations（逻辑名 account_cancellations）
 * 模式：immediate 立即注销 / grace 7天冷静期（默认）。
 * 语义：注销只清除「绑定关系 + 账号可用态 + 相关邀请码」，不动业务数据（任务/打卡/积分等）。
 *  - 立即注销：立即执行注销并记录 executed。
 *  - 7天注销：写入 pending（effective_at=申请+7天），期间可撤销；到期由 sweepDueCancellations 执行。
 *
 * 仅 parent / personal 角色可用（其余角色无此功能，由调用方 + 本模块双重校验）。
 */
const { db } = require("./db");
const { nowSql } = require("./utils");
const { nextSeq } = require("./seq");
const { LP_APP } = require("./routes/lpAuth");

const GRACE_DAYS = 7;
const ALLOWED_ROLES = ["parent", "personal"];

/** 校验角色是否可注销 */
function roleCanCancel(role) {
  return ALLOWED_ROLES.includes(String(role || ""));
}

/**
 * 执行注销：清除绑定关系 + 禁用账号 + 作废相关邀请码（保留业务数据）
 * @param {object} rec 注销申请记录 { staff_id, openid, app_id }
 */
async function executeCancellation(rec) {
  const staffId = Number(rec && rec.staff_id) || 0;
  const openid = String((rec && rec.openid) || "");
  const appId = String((rec && rec.app_id) || LP_APP.app_id);
  if (!staffId) return;

  // 1) 解除绑定（该 openid 对该 staff 的绑定；作废即锁）
  try {
    await db.from("lp_students")
      .update({ bound_status: 0, updated_at: nowSql() })
      .eq("app_id", appId).eq("staff_id", staffId).eq("bound_status", 1);
  } catch (e) {
    console.error("[accountLib] 注销解绑失败", e);
  }

  // 2) 禁用账号（个人/家长注销后不可再登录；业务数据保留）
  try {
    await db.from("staff").update({ staff_status: 0, updated_at: nowSql() }).eq("staff_id", staffId);
  } catch (e) {
    console.error("[accountLib] 注销禁用账号失败", e);
  }

  // 3) 作废相关邀请码（名下待绑定码 + 已绑定到该账号的码；孩子码/家属共享码/家长码）
  try {
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("owner_staff_id", staffId).eq("status", "available");
  } catch (_) {}
  try {
    await db.from("lp_invites").update({ status: "revoked", updated_at: nowSql() })
      .eq("bound_staff_id", staffId).eq("status", "bound");
  } catch (_) {}
}

/** 某 openid 当前待生效（pending）的注销申请；无则返回 null */
async function getPendingCancellation(appId, openid) {
  const app = appId || LP_APP.app_id;
  try {
    const { data, error } = await db.from("account_cancellations")
      .select().eq("app_id", app).eq("openid", String(openid || ""))
      .eq("status", "pending").order("cancel_id", { ascending: false }).limit(1);
    if (error) return null;
    return (data && data[0]) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 申请注销
 * @returns {Promise<{ mode, status, effective_at, msg }>}
 */
async function requestCancellation({ appId, staffId, openid, role, mode = "grace" }) {
  const staff = Number(staffId) || 0;
  const oid = String(openid || "");
  const app = appId || LP_APP.app_id;
  const m = String(mode || "grace") === "immediate" ? "immediate" : "grace";

  // 已有待生效申请 → 幂等返回（避免重复申请）
  const existing = await getPendingCancellation(app, oid);
  if (existing) {
    return {
      mode: existing.mode,
      status: "pending",
      effective_at: existing.effective_at || "",
      msg: existing.mode === "grace" ? "已提交7天注销申请，可在生效前撤销" : "注销申请处理中",
    };
  }

  if (m === "immediate") {
    // 立即注销：写入 executed 记录并立即执行
    const cancelId = await nextSeq("account_cancel_id");
    const now = nowSql();
    await db.from("account_cancellations").insert({
      cancel_id: cancelId,
      app_id: app,
      staff_id: staff,
      openid: oid,
      mode: "immediate",
      status: "executed",
      requested_at: now,
      effective_at: now,
      executed_at: now,
      created_at: now,
      updated_at: now,
    });
    await executeCancellation({ staff_id: staff, openid: oid, app_id: app });
    return { mode: "immediate", status: "executed", effective_at: now, msg: "账号已注销" };
  }

  // 7天冷静期
  const cancelId = await nextSeq("account_cancel_id");
  const now = nowSql();
  const effectiveAt = nowSql(new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000));
  await db.from("account_cancellations").insert({
    cancel_id: cancelId,
    app_id: app,
    staff_id: staff,
    openid: oid,
    mode: "grace",
    status: "pending",
    requested_at: now,
    effective_at: effectiveAt,
    created_at: now,
    updated_at: now,
  });
  return { mode: "grace", status: "pending", effective_at: effectiveAt, msg: "已提交7天注销申请，冷静期内可撤销" };
}

/** 撤销待生效的注销申请；返回是否撤销成功 */
async function cancelPendingCancellation(appId, openid) {
  const app = appId || LP_APP.app_id;
  try {
    const { error } = await db.from("account_cancellations")
      .update({ status: "cancelled", cancelled_at: nowSql(), updated_at: nowSql() })
      .eq("app_id", app).eq("openid", String(openid || "")).eq("status", "pending");
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("[accountLib] 撤销注销失败", e);
    return false;
  }
}

/**
 * 待生效注销申请的「前端摘要」（无则 null）。
 * 注销流程中（7天冷静期）用户不得进入业务系统，只能停留在注销页撤销/等待，
 * 登录 / 中间件 / 注销页统一复用此摘要格式（与抖音/公众号注销流程一致）。
 */
async function pendingCancelSummary(appId, openid) {
  const p = await getPendingCancellation(appId, openid);
  return p ? {
    cancel_id: String(p.cancel_id),
    mode: p.mode,
    status: p.status,
    requested_at: p.requested_at,
    effective_at: p.effective_at || "",
  } : null;
}

/** 注销流程中（有待生效申请）→ 禁止注册/绑定/切换/解绑等一切进入业务系统的操作 */
async function isCancelling(appId, openid) {
  return !!(await getPendingCancellation(appId, openid));
}

/** 扫描并执行到期的 pending 注销申请（定时任务调用） */
async function sweepDueCancellations() {
  try {
    const now = nowSql();
    const { data, error } = await db.from("account_cancellations")
      .select().eq("status", "pending").lte("effective_at", now).limit(500);
    if (error) return 0;
    const rows = (data || []).filter(r => Number(r.staff_id) > 0);
    for (const rec of rows) {
      try {
        await executeCancellation(rec);
        await db.from("account_cancellations")
          .update({ status: "executed", executed_at: nowSql(), updated_at: nowSql() })
          .eq("cancel_id", rec.cancel_id);
      } catch (e) {
        console.error("[accountLib] 到期注销执行失败", rec.cancel_id, e);
      }
    }
    return rows.length;
  } catch (e) {
    console.error("[accountLib] sweepDueCancellations error", e);
    return 0;
  }
}

module.exports = {
  roleCanCancel,
  requestCancellation,
  cancelPendingCancellation,
  getPendingCancellation,
  pendingCancelSummary,
  isCancelling,
  executeCancellation,
  sweepDueCancellations,
  GRACE_DAYS,
};
