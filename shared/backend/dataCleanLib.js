/**
 * 后台「脏数据清理」核心逻辑（处理历史脏数据：孤儿绑定/邀请码/家庭/空壳账号）
 *
 * 定位：只清理「确定无用」的记录，与「物理清除」（purgeLib，带媒体+审计的全量删除）互补——
 *   物理清除用于按“账号/家庭/用户”整棵删；本模块用于历史遗留的孤儿/残留关联的定点清理。
 *
 * 安全约定（与运维 SQL 等价，全在 JS 内完成）：
 *   - 指向已删除账号的绑定/邀请码/孩子档案/家属关系；
 *   - 历史终态（已作废邀请码、source='auto' 存量绑定行）；
 *   - 完全空壳账号（无绑定、无家庭、无任何业务数据），且绝不触碰 admin / 受保护超管。
 *   - 不做任何“猜测性删除”（如 openid 画像缺失的绑定等，留给人工）。
 */
const { db } = require("./db");
const { isProtectedStaff } = require("./protect");

/** 数值集合：select col limit，返回去重数字集合 */
async function idSet(table, col, extraQ) {
  const set = new Set();
  try {
    let q = db.from(table).select(col);
    if (extraQ) q = extraQ(q);
    const { data, error } = await q.limit(200000);
    if (error) throw error;
    (data || []).forEach(r => {
      const v = Number(r[col]);
      if (Number.isFinite(v) && v > 0) set.add(v);
    });
  } catch (e) {
    console.error(`[dataClean] idSet ${table}.${col} error`, e);
  }
  return set;
}

/** 删除主键列表（分块 in） */
async function deleteByIds(table, pk, ids) {
  const list = [...ids];
  let n = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    if (!chunk.length) continue;
    try {
      const { error } = await db.from(table).delete().in(pk, chunk);
      if (!error) n += chunk.length;
      else console.error(`[dataClean] delete ${table} chunk error`, error);
    } catch (e) { console.error(`[dataClean] delete ${table} chunk error`, e); }
  }
  return n;
}

/** 账号全集（staff_id，排除受保护超管与 admin，仅业务角色） */
async function businessStaffIds() {
  const { data, error } = await db.from("staff")
    .select("staff_id, staff_role")
    .in("staff_role", ["parent", "family", "student", "personal"])
    .limit(200000);
  if (error) throw error;
  const map = {};
  (data || []).forEach(s => {
    const id = Number(s.staff_id);
    if (Number.isFinite(id) && id > 0 && !isProtectedStaff(id)) map[id] = s.staff_role;
  });
  return map; // id -> role
}

/** 被各类业务表“使用”的 staff_id 集合（排除孤儿判断中不应视为使用的表可按需传 options） */
async function anyUsedStaffIds(opts = {}) {
  const used = new Set();
  const addCol = async (table, cols) => {
    for (const col of cols) {
      (await idSet(table, col)).forEach(v => used.add(v));
    }
  };
  await addCol("tasks", ["created_by"]);
  await addCol("task_assignees", ["staff_id"]);
  await addCol("task_checkins", ["created_by", "reviewer"]);
  await addCol("task_collections", ["created_by", "staff_id"]);
  await addCol("subjects", ["staff_id"]);
  await addCol("point_logs", ["staff_id"]);
  await addCol("point_balances", ["staff_id"]);
  await addCol("badge_unlocks", ["staff_id"]);
  await addCol("notifications", ["staff_id"]);
  await addCol("task_timeline", ["created_by"]);
  await addCol("subscribe_grants", ["staff_id"]);
  await addCol("subscribe_sends", ["staff_id"]);
  await addCol("staff_apps", ["staff_id"]);
  await addCol("account_cancellations", ["staff_id"]);
  // 家庭/绑定使用（非业务数据，但作为“仍有归属/仍有人用”的依据）
  await addCol("lp_children", ["parent_staff_id", "student_staff_id"]);
  await addCol("lp_family_members", ["owner_staff_id", "member_staff_id"]);
  await addCol("lp_students", ["staff_id"]);
  if (opts.includeInvites !== false) {
    await addCol("lp_invites", ["owner_staff_id", "bound_staff_id"]);
  }
  return used;
}

// ==================== 类目 ====================
const CATEGORIES = [
  { key: "revoked_invites", label: "已作废邀请码", desc: "删除 status=revoked 的历史作废码（单次码用后/作废的残留）", danger: false },
  { key: "auto_binds", label: "家长挂接(auto)绑定行", desc: "删除旧版“家长挂孩子”物化的 source=auto 绑定（重构后运行时推导，不再需要）", danger: false },
  { key: "orphan_bindings", label: "绑定指向已删账号", desc: "lp_students 中 staff_id 已不存在的孤儿绑定", danger: false },
  { key: "orphan_invites", label: "邀请码指向已删账号", desc: "lp_invites 中归属/绑定账号已不存在的邀请码", danger: false },
  { key: "orphan_children", label: "孤儿孩子档案", desc: "lp_children 中主家长或学生账号已不存在的档案", danger: false },
  { key: "orphan_family", label: "孤儿家属关系", desc: "lp_family_members 中主家长或家属账号已不存在的记录", danger: false },
  { key: "orphan_students", label: "空壳孤儿学生账号", desc: "role=student、无档案/绑定/任何业务数据的学生账号（孩子档案已删后的残留）", danger: false },
  { key: "empty_business_staff", label: "空壳业务账号(家长/家属/个人)", desc: "完全空壳的 parent/family/personal 账号（无绑定/家庭/数据）；可能含“已建档未扫码”账号，请谨慎确认", danger: true },
];

function categoryOf(key) {
  return CATEGORIES.find(c => c.key === key);
}

/** 计算某类目的可清理候选 id（不删除） */
async function candidatesOf(key) {
  const staffMap = await businessStaffIds();
  const staffIds = [...new Set(Object.keys(staffMap).map(Number))];
  const staffSet = new Set(staffIds);
  switch (key) {
    case "revoked_invites": {
      const { data } = await db.from("lp_invites").select("invite_id").eq("status", "revoked").limit(200000);
      return (data || []).map(r => Number(r.invite_id)).filter(v => v > 0);
    }
    case "auto_binds": {
      const { data } = await db.from("lp_students").select("id").eq("source", "auto").limit(200000);
      return (data || []).map(r => Number(r.id)).filter(v => v > 0);
    }
    case "orphan_bindings": {
      const { data } = await db.from("lp_students").select("id, staff_id").limit(200000);
      return (data || []).filter(r => !staffSet.has(Number(r.staff_id))).map(r => Number(r.id)).filter(v => v > 0);
    }
    case "orphan_invites": {
      const { data } = await db.from("lp_invites").select("invite_id, owner_staff_id, bound_staff_id").limit(200000);
      return (data || [])
        .filter(r => (Number(r.owner_staff_id) > 0 && !staffSet.has(Number(r.owner_staff_id)))
          || (Number(r.bound_staff_id) > 0 && !staffSet.has(Number(r.bound_staff_id))))
        .map(r => Number(r.invite_id)).filter(v => v > 0);
    }
    case "orphan_children": {
      const { data } = await db.from("lp_children").select("child_id, parent_staff_id, student_staff_id").limit(200000);
      return (data || [])
        .filter(r => (Number(r.parent_staff_id) > 0 && !staffSet.has(Number(r.parent_staff_id)))
          || (Number(r.student_staff_id) > 0 && !staffSet.has(Number(r.student_staff_id))))
        .map(r => Number(r.child_id)).filter(v => v > 0);
    }
    case "orphan_family": {
      const { data } = await db.from("lp_family_members").select("id, owner_staff_id, member_staff_id").limit(200000);
      return (data || [])
        .filter(r => !staffSet.has(Number(r.owner_staff_id)) || !staffSet.has(Number(r.member_staff_id)))
        .map(r => Number(r.id)).filter(v => v > 0);
    }
    case "orphan_students":
    case "empty_business_staff": {
      // 空壳：在业务角色账号中，未被任何“使用/归属”引用的
      const used = await anyUsedStaffIds({ includeInvites: key === "empty_business_staff" });
      return staffIds.filter(id => {
        const role = staffMap[id];
        if (key === "orphan_students" && role !== "student") return false;
        if (key === "empty_business_staff" && role === "student") return false;
        return !used.has(id);
      });
    }
    default:
      throw new Error("未知清理类目: " + key);
  }
}

function tableOf(key) {
  const map = {
    revoked_invites: ["lp_invites", "invite_id"],
    auto_binds: ["lp_students", "id"],
    orphan_bindings: ["lp_students", "id"],
    orphan_invites: ["lp_invites", "invite_id"],
    orphan_children: ["lp_children", "child_id"],
    orphan_family: ["lp_family_members", "id"],
    orphan_students: ["staff", "staff_id"],
    empty_business_staff: ["staff", "staff_id"],
  };
  return map[key] || [];
}

/** 各类目当前计数（供预览） */
async function previewClean() {
  const out = [];
  for (const c of CATEGORIES) {
    try {
      const ids = await candidatesOf(c.key);
      out.push({ key: c.key, label: c.label, desc: c.desc, danger: c.danger, count: ids.length });
    } catch (e) {
      out.push({ key: c.key, label: c.label, desc: c.desc, danger: c.danger, count: -1, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

/** 执行某类目清理，返回 { key, deleted, table, affected_ids } */
async function runClean(key) {
  const cat = categoryOf(key);
  if (!cat) throw new Error("未知清理类目: " + key);
  const ids = await candidatesOf(key);
  const [table, pk] = tableOf(key);
  const deleted = ids.length ? await deleteByIds(table, pk, ids) : 0;
  return { key, label: cat.label, table, deleted, candidate: ids.length, affected_ids: ids.slice(0, 200) };
}

module.exports = { CATEGORIES, previewClean, runClean, candidatesOf };
