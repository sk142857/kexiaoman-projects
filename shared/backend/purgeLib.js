/**
 * 后台「物理清除」核心逻辑（一键清除账号及其全部关联数据）
 *
 * 与「普通删除」（cascadeDeleteStaffData）的区别：
 * - 范围更彻底：以目标账号为中心沿家庭图（lp_children 家长↔孩子、lp_family_members 主家长↔家属）
 *   BFS 扩散，把「主家长 + 名下孩子 + 家属」整棵家庭树连同各自业务数据一并物理删除。
 * - 完整审计：删除前可预览（collectPurgeManifest）完整删除清单（逐表计数 + 样本），
 *   删除后写入 t_lp_staff_purges 持久化审计，后台「物理清除审计」可回看。
 * - 媒体物理删除：任务/打卡/合集图片与语音/视频/封面文件同步从云存储物理删除。
 *
 * 安全约束：
 * - 受保护账号（protect.js isProtectedStaff，如 999999 超管）禁止清除。
 * - 操作人自己（actor）绝不会被级联删除。
 * - 系统配置类数据（staff_events 审计、菜单、角色、序列、模板、参数等）不删除。
 */
const { db, countRows } = require("./db");
const { nextSeq } = require("./seq");
const { nowSql } = require("./utils");
const { parseImgList, invalidateStaffRows, invalidateCollectionRows } = require("./learningLib");
const { removeFiles } = require("./storage");
const { isProtectedStaff } = require("./protect");
const { getClientIp, getBrowserFingerprint } = require("./staffAudit");

// ==================== 清单项定义 ====================
// 每个表：key（逻辑名）/ label（中文名）/ pk（主键，用于精确计数与分页收集）
const ITEM_DEFS = [
  { key: "tasks", label: "任务", table: "tasks", pk: "task_id" },
  { key: "task_checkins", label: "打卡", table: "task_checkins", pk: "checkin_id" },
  { key: "task_assignees", label: "任务派发", table: "task_assignees", pk: "" },
  { key: "task_timeline", label: "任务时间轴", table: "task_timeline", pk: "event_id" },
  { key: "task_collections", label: "合集", table: "task_collections", pk: "collection_id" },
  { key: "subjects", label: "科目", table: "subjects", pk: "subject_id" },
  { key: "point_logs", label: "积分账本", table: "point_logs", pk: "log_id" },
  { key: "point_balances", label: "积分余额", table: "point_balances", pk: "" },
  { key: "badge_unlocks", label: "徽章解锁", table: "badge_unlocks", pk: "" },
  { key: "notifications", label: "系统通知", table: "notifications", pk: "notify_id" },
  { key: "subscribe_grants", label: "订阅授权", table: "subscribe_grants", pk: "grant_id" },
  { key: "subscribe_sends", label: "订阅发送", table: "subscribe_sends", pk: "send_id" },
  { key: "lp_students", label: "绑定关系", table: "lp_students", pk: "id" },
  { key: "lp_invites", label: "邀请码", table: "lp_invites", pk: "invite_id" },
  { key: "lp_children", label: "孩子档案", table: "lp_children", pk: "child_id" },
  { key: "lp_family_members", label: "家属关系", table: "lp_family_members", pk: "id" },
  { key: "account_cancellations", label: "注销申请", table: "account_cancellations", pk: "cancel_id" },
  { key: "content_audits", label: "内容安全审核", table: "content_audits", pk: "audit_id" },
  { key: "file_uploads", label: "文件登记", table: "file_uploads", pk: "file_id" },
  { key: "users", label: "微信用户", table: "users", pk: "user_id" },
  { key: "user_sessions", label: "会话画像", table: "user_sessions", pk: "" },
  { key: "user_events", label: "用户事件", table: "user_events", pk: "" },
  { key: "api_trace", label: "接口链路", table: "api_trace", pk: "" },
  { key: "staff", label: "账号（家长/孩子/家属/个人）", table: "staff", pk: "staff_id" },
];

/** 中文字段名映射（样本行展示用，避免暴露内部列名） */
const FIELD_CN = {
  task_id: "任务ID", checkin_id: "打卡ID", title: "标题", checkin_date: "日期",
  created_by: "归属账号", child_id: "孩子档案ID", child_name: "孩子姓名",
  parent_staff_id: "主家长", student_staff_id: "孩子账号", owner_staff_id: "归属账号",
  member_staff_id: "家属账号", staff_id: "账号", invite_code: "邀请码",
  openid: "openid", user_uid: "用户ID", nickname: "昵称", name: "名称",
  collection_id: "合集ID", subject_id: "科目ID", log_id: "流水ID", badge_key: "徽章",
  notify_id: "通知ID", grant_id: "授权ID", send_id: "发送ID", id: "ID",
  cancel_id: "注销ID", audit_id: "审核ID", file_path: "文件路径", file_id: "文件ID",
  username: "账号", staff_username: "账号", staff_nickname: "昵称", staff_role: "角色",
  account: "账号", status: "状态", reason: "原因", biz_type: "业务类型", biz_id: "业务ID",
  event_name: "事件", created_at: "时间",
};

/** 表 → 展示用主字段（样本行取 { 主字段, 关联标识 }，控制体积） */
const SAMPLE_FIELDS = {
  tasks: ["task_id", "title", "created_by"],
  task_checkins: ["checkin_id", "task_id", "checkin_date", "created_by"],
  task_assignees: ["task_id", "staff_id"],
  task_timeline: ["event_id", "task_id", "event_name"],
  task_collections: ["collection_id", "name", "staff_id"],
  subjects: ["subject_id", "name", "staff_id"],
  point_logs: ["log_id", "staff_id", "reason"],
  point_balances: ["staff_id"],
  badge_unlocks: ["staff_id", "badge_key"],
  notifications: ["notify_id", "staff_id", "title"],
  subscribe_grants: ["grant_id", "staff_id"],
  subscribe_sends: ["send_id", "staff_id"],
  lp_students: ["id", "staff_id", "openid"],
  lp_invites: ["invite_id", "invite_code", "kind", "owner_staff_id"],
  lp_children: ["child_id", "child_name", "parent_staff_id", "student_staff_id"],
  lp_family_members: ["id", "owner_staff_id", "member_staff_id"],
  account_cancellations: ["cancel_id", "staff_id", "status"],
  content_audits: ["audit_id", "biz_type", "biz_id", "status"],
  file_uploads: ["file_id", "file_path", "openid"],
  users: ["user_id", "openid", "nickname"],
  user_sessions: ["openid"],
  user_events: ["openid", "event_name"],
  api_trace: ["openid", "api_path"],
  staff: ["staff_id", "staff_username", "staff_nickname", "staff_role"],
};

/** 数值去重、过滤非法值，分块（避免 SQL IN 过长）；兼容标量（单个 id/openid）入参 */
function numList(arr) {
  const list = Array.isArray(arr) ? arr : [arr];
  return [...new Set(list.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0))];
}
function strList(arr) {
  const list = Array.isArray(arr) ? arr : [arr];
  return [...new Set(list.map(v => String(v || "").trim()).filter(Boolean))];
}
const CHUNK = 500;
function* chunks(list, size = CHUNK) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/** 按数值 pk 分页收集主键（数值 pk 升序翻页，避免大集合一次 in() 超限） */
async function collectIdsByPk(table, pk, buildQ, { batch = 500, max = 200000 } = {}) {
  const ids = [];
  let last = 0;
  while (ids.length < max) {
    let q = db.from(table).select(pk);
    if (buildQ) q = buildQ(q);
    if (last) q = q.gt(pk, last);
    const { data, error } = await q.order(pk, { ascending: true }).limit(batch);
    if (error) throw error;
    const rows = data || [];
    if (rows.length === 0) break;
    let cursor = last;
    rows.forEach(r => {
      const v = Number(r[pk]);
      if (Number.isFinite(v) && v > 0) { ids.push(v); cursor = Math.max(cursor, v); }
    });
    last = cursor;
    if (rows.length < batch) break;
  }
  return ids;
}

/**
 * 收集清除范围：以目标账号为中心确定「应一并清除的账号 + 绑定 openid」。
 * 扩散规则（只向下一层，避免误删上级）：
 * - family=true（默认）：目标=主家长 → 一并清除「名下孩子（student 账号）+ 家属（family 账号）」；
 *   目标=孩子/家属/个人 → 仅清除目标本人（其名下无下级）。
 * - family=false（单账号模式，用于用户清理触发的孤儿账号）：仅清除目标本人，
 *   孩子/家属等家庭其余账号保留（只删目标「自己相关」的账号）。
 * @returns {Promise<{staff: number[], staffInfo: Object, openids: string[], childIds: number[]}>}
 */
async function gatherScope(staffId, opts = {}) {
  const seed = Number(staffId);
  const family = opts.family !== false;
  const staffSet = new Set([seed]);
  const staffInfo = {};
  const openidSet = new Set();
  const childIds = [];

  // 目标角色（决定扩散方向）
  let targetRole = "";
  try {
    const { data } = await db.from("staff").select("staff_id, staff_role").eq("staff_id", seed).limit(1);
    if (data && data[0]) targetRole = data[0].staff_role;
  } catch (_) {}

  // 主家长：扩散到名下孩子 + 家属（一层；孩子/家属名下无下级）
  if (family && targetRole === "parent") {
    try {
      const { data } = await db.from("lp_children").select("child_id, student_staff_id").eq("parent_staff_id", seed).limit(500);
      (data || []).forEach(c => {
        const sid = Number(c.student_staff_id);
        if (Number.isFinite(sid) && sid > 0) staffSet.add(sid);
        if (Number(c.child_id)) childIds.push(Number(c.child_id));
      });
    } catch (_) {}
    try {
      const { data } = await db.from("lp_family_members").select("member_staff_id, member_openid").eq("owner_staff_id", seed).limit(500);
      (data || []).forEach(f => {
        const sid = Number(f.member_staff_id);
        if (Number.isFinite(sid) && sid > 0) staffSet.add(sid);
        if (f.member_openid) openidSet.add(f.member_openid);
      });
    } catch (_) {}
  }

  // 收集范围内所有账号的绑定 openid（含目标本人；孩子/家属自己的绑定）
  for (const sid of [...staffSet]) {
    try {
      const { data } = await db.from("lp_students").select("openid").eq("staff_id", sid).limit(2000);
      (data || []).forEach(r => { if (r.openid) openidSet.add(r.openid); });
    } catch (_) {}
  }

  // 孩子档案 ID：主家长名下的 + 范围内孩子作为 student 的（内容审核/邀请码按 child_id 关联）
  const staffArr = [...staffSet];
  if (staffArr.length) {
    try {
      const { data } = await db.from("lp_children")
        .select("child_id").in("parent_staff_id", staffArr).limit(2000);
      (data || []).forEach(c => childIds.push(Number(c.child_id)));
      const { data: d2 } = await db.from("lp_children")
        .select("child_id").in("student_staff_id", staffArr).limit(2000);
      (d2 || []).forEach(c => childIds.push(Number(c.child_id)));
    } catch (_) {}
  }

  // 账号信息（角色/昵称/账号），供审计展示
  if (staffArr.length) {
    try {
      const { data } = await db.from("staff")
        .select("staff_id, staff_username, staff_nickname, staff_role").in("staff_id", staffArr).limit(500);
      (data || []).forEach(s => { staffInfo[String(s.staff_id)] = s; });
    } catch (_) {}
  }

  return { staff: staffArr, staffInfo, openids: [...openidSet], childIds: [...new Set(childIds)] };
}

/** 收集范围内业务行主键：任务 / 打卡 / 合集（供清单统计、媒体收集与级联删除） */
async function gatherBizIds(scope) {
  const staffArr = scope.staff;
  const taskIds = staffArr.length
    ? await collectIdsByPk("tasks", "task_id", q => q.in("created_by", staffArr))
    : [];
  const checkinIds = staffArr.length
    ? await collectIdsByPk("task_checkins", "checkin_id", q => q.in("created_by", staffArr))
    : [];
  const colIds = staffArr.length
    ? await collectIdsByPk("task_collections", "collection_id", q => q.or(`created_by.in.(${staffArr.join(",")}),staff_id.in.(${staffArr.join(",")})`))
    : [];
  return { taskIds, checkinIds, colIds };
}

/** 收集范围内全部云存储媒体路径（任务/打卡/合集 + 文件登记），供物理删除 */
async function collectMediaPaths(scope, taskIds, checkinIds, colIds) {
  const paths = new Set();
  const staffArr = scope.staff;
  const openids = scope.openids;

  const addJson = (raw) => parseImgList(raw).forEach(p => paths.add(p));
  // 任务图片
  if (taskIds.length) {
    try {
      for (const c of chunks(taskIds)) {
        const { data } = await db.from("tasks").select("task_id, images").in("task_id", c).limit(c.length);
        (data || []).forEach(t => addJson(t.images));
      }
    } catch (_) {}
  }
  // 打卡媒体（图/语音/视频/封面）
  if (checkinIds.length) {
    try {
      for (const c of chunks(checkinIds)) {
        const { data } = await db.from("task_checkins")
          .select("checkin_id, checkin_images, voice_url, video_url, video_cover").in("checkin_id", c).limit(c.length);
        (data || []).forEach(ck => {
          addJson(ck.checkin_images);
          if (ck.voice_url) paths.add(ck.voice_url);
          if (ck.video_url) paths.add(ck.video_url);
          if (ck.video_cover) paths.add(ck.video_cover);
        });
      }
    } catch (_) {}
  }
  // 合集封面
  if (colIds.length) {
    try {
      for (const c of chunks(colIds)) {
        const { data } = await db.from("task_collections").select("collection_id, cover_images").in("collection_id", c).limit(c.length);
        (data || []).forEach(col => addJson(col.cover_images));
      }
    } catch (_) {}
  }
  // 文件登记中的其余路径（按 openid；含头像、语音直传等）
  if (openids.length) {
    try {
      for (const c of chunks(openids)) {
        const { data } = await db.from("file_uploads").select("file_path").in("openid", c).limit(c.length * 100);
        (data || []).forEach(f => { if (f.file_path) paths.add(f.file_path); });
      }
    } catch (_) {}
  }
  return [...paths];
}

/**
 * 构建「删除审计清单」（预览与执行共用）：逐表计数 + 样本行。
 * @param {number|string} staffId 目标账号
 * @param {object} [opts] { family: boolean } 是否随主家长扩散整棵家庭树（默认 true；用户清理触发的孤儿账号传 false）
 * @returns {Promise<{target, scope, items, media_files}>}
 */
async function collectPurgeManifest(staffId, opts = {}) {
  const id = Number(staffId);
  if (!id) throw new Error("缺少目标账号");
  if (isProtectedStaff(id)) throw new Error("超级管理员账号受强保护，禁止物理清除");

  let target = null;
  try {
    const { data } = await db.from("staff").select().eq("staff_id", id).limit(1);
    target = (data && data[0]) || null;
  } catch (_) {}
  if (!target) throw new Error("目标账号不存在");

  const scope = await gatherScope(id, opts);
  const biz = await gatherBizIds(scope);
  const staffArr = scope.staff;
  const openids = scope.openids;
  const taskIds = biz.taskIds;
  const checkinIds = biz.checkinIds;
  const colIds = biz.colIds;
  const childIds = scope.childIds;

  // 逐表统计
  const items = [];
  const countOf = async (table, pk, buildQ) => {
    try {
      if (pk) return await countRows(table, pk, buildQ);
      // 无合适主键的表：回退拉主键列计数（limit 上限 20000）
      const { data } = await buildQ(db.from(table).select()).limit(20000);
      return (data || []).length;
    } catch (_) { return 0; }
  };
  const sampleOf = async (table, fields, buildQ, cap = 5) => {
    try {
      const { data } = await buildQ(db.from(table).select(...fields)).limit(cap);
      return (data || []).map(r => {
        const out = {};
        fields.forEach(f => { out[FIELD_CN[f] || f] = r[f]; });
        return out;
      });
    } catch (_) { return []; }
  };
  const stat = async (def, buildQ) => {
    const count = await countOf(def.table, def.pk, buildQ);
    const sample = count > 0 ? await sampleOf(def.table, SAMPLE_FIELDS[def.key] || ["*"], buildQ) : [];
    items.push({ key: def.key, table: def.table, label: def.label, count, sample });
  };

  const buildStaffQ = (q) => q.in("staff_id", staffArr);

  // —— 业务数据（按账号）——
  await stat(ITEM_DEFS[0], q => q.in("created_by", staffArr));                       // tasks
  // task_checkins：本人创建的打卡 ∪ 本人名下任务下的打卡（规避空 in() 子句）
  {
    const clauses = [`created_by.in.(${staffArr.join(",")})`];
    if (taskIds.length) clauses.push(`task_id.in.(${taskIds.join(",")})`);
    await stat(ITEM_DEFS[1], q => q.or(clauses.join(",")));
  }
  if (taskIds.length) await stat(ITEM_DEFS[2], q => q.or(`task_id.in.(${taskIds.join(",")}),staff_id.in.(${staffArr.join(",")})`)); // task_assignees
  else await stat(ITEM_DEFS[2], q => q.in("staff_id", staffArr));
  if (taskIds.length || checkinIds.length) {
    const clauses = [`created_by.in.(${staffArr.join(",")})`];
    if (taskIds.length) clauses.push(`task_id.in.(${taskIds.join(",")})`);
    if (checkinIds.length) clauses.push(`checkin_id.in.(${checkinIds.join(",")})`);
    await stat(ITEM_DEFS[3], q => q.or(clauses.join(",")));                          // task_timeline
  } else {
    await stat(ITEM_DEFS[3], q => q.in("created_by", staffArr));
  }
  await stat(ITEM_DEFS[4], q => q.or(`created_by.in.(${staffArr.join(",")}),staff_id.in.(${staffArr.join(",")})`)); // task_collections
  await stat(ITEM_DEFS[5], buildStaffQ);                                            // subjects
  await stat(ITEM_DEFS[6], buildStaffQ);                                            // point_logs
  await stat(ITEM_DEFS[7], buildStaffQ);                                            // point_balances
  await stat(ITEM_DEFS[8], buildStaffQ);                                            // badge_unlocks
  await stat(ITEM_DEFS[9], buildStaffQ);                                            // notifications

  // —— 授权 / 绑定 / 关系 ——
  if (openids.length) await stat(ITEM_DEFS[10], q => q.or(`staff_id.in.(${staffArr.join(",")}),openid.in.(${openids.join(",")})`)); // subscribe_grants
  else await stat(ITEM_DEFS[10], buildStaffQ);
  if (openids.length) await stat(ITEM_DEFS[11], q => q.or(`staff_id.in.(${staffArr.join(",")}),openid.in.(${openids.join(",")})`)); // subscribe_sends
  else await stat(ITEM_DEFS[11], buildStaffQ);
  if (openids.length) await stat(ITEM_DEFS[12], q => q.or(`staff_id.in.(${staffArr.join(",")}),openid.in.(${openids.join(",")})`)); // lp_students
  else await stat(ITEM_DEFS[12], buildStaffQ);
  // 邀请码：归属 / 绑定账号 / 绑定 openid / 关联孩子档案
  {
    const clauses = [`owner_staff_id.in.(${staffArr.join(",")})`, `bound_staff_id.in.(${staffArr.join(",")})`];
    if (openids.length) clauses.push(`bound_openid.in.(${openids.join(",")})`);
    if (childIds.length) clauses.push(`child_id.in.(${childIds.join(",")})`);
    await stat(ITEM_DEFS[13], q => q.or(clauses.join(",")));
  }
  await stat(ITEM_DEFS[14], q => q.or(`parent_staff_id.in.(${staffArr.join(",")}),student_staff_id.in.(${staffArr.join(",")})`)); // lp_children
  {
    const clauses = [`owner_staff_id.in.(${staffArr.join(",")})`, `member_staff_id.in.(${staffArr.join(",")})`];
    if (openids.length) clauses.push(`member_openid.in.(${openids.join(",")})`);
    await stat(ITEM_DEFS[15], q => q.or(clauses.join(",")));
  }
  if (openids.length) await stat(ITEM_DEFS[16], q => q.or(`staff_id.in.(${staffArr.join(",")}),openid.in.(${openids.join(",")})`)); // account_cancellations
  else await stat(ITEM_DEFS[16], buildStaffQ);

  // —— 内容安全 / 文件 / 用户 ——
  {
    const clauses = [];
    if (openids.length) clauses.push(`openid.in.(${openids.join(",")})`);
    if (staffArr.length) clauses.push(`biz_type.eq.profile,biz_id.in.(${staffArr.join(",")})`);
    if (taskIds.length) clauses.push(`biz_type.eq.task,biz_id.in.(${taskIds.join(",")})`);
    if (checkinIds.length) clauses.push(`biz_type.eq.checkin,biz_id.in.(${checkinIds.join(",")})`);
    if (childIds.length) clauses.push(`biz_type.eq.child,biz_id.in.(${childIds.join(",")})`);
    if (clauses.length) await stat(ITEM_DEFS[17], q => q.or(clauses.join(",")));
    else await stat(ITEM_DEFS[17], q => q.eq("openid", -1));
  }
  if (openids.length) await stat(ITEM_DEFS[18], q => q.in("openid", openids));       // file_uploads
  else await stat(ITEM_DEFS[18], q => q.eq("openid", -1));
  if (openids.length) await stat(ITEM_DEFS[19], q => q.in("openid", openids));       // users
  else await stat(ITEM_DEFS[19], q => q.eq("openid", -1));
  if (openids.length) await stat(ITEM_DEFS[20], q => q.in("openid", openids));       // user_sessions
  else await stat(ITEM_DEFS[20], q => q.eq("openid", -1));
  if (openids.length) await stat(ITEM_DEFS[21], q => q.in("openid", openids));       // user_events
  else await stat(ITEM_DEFS[21], q => q.eq("openid", -1));
  if (openids.length) await stat(ITEM_DEFS[22], q => q.in("openid", openids));       // api_trace
  else await stat(ITEM_DEFS[22], q => q.eq("openid", -1));
  await stat(ITEM_DEFS[23], q => q.in("staff_id", staffArr));                        // staff 账号

  const mediaPaths = await collectMediaPaths(scope, taskIds, checkinIds, colIds);

  return {
    target: {
      staff_id: String(target.staff_id),
      username: target.staff_username,
      nickname: target.staff_nickname || "",
      role: target.staff_role,
      status: target.staff_status,
    },
    scope: {
      staff: staffArr.map(sid => {
        const info = scope.staffInfo[String(sid)] || {};
        return { staff_id: String(sid), username: info.staff_username || "", nickname: info.staff_nickname || "", role: info.staff_role || "" };
      }),
      openids: openids.map(o => ({ openid: o })),
      childIds,
    },
    items,
    media_files: mediaPaths.length,
    _biz: { taskIds, checkinIds, colIds },
  };
}

// ==================== 执行物理删除 ====================

/** 数值列分块 in 删除 */
async function delByNum(table, col, vals, extraQ) {
  const list = numList(vals);
  for (const c of chunks(list)) {
    let q = db.from(table).delete().in(col, c);
    if (extraQ) q = extraQ(q);
    await q;
  }
}
/** 字符串列分块 in 删除 */
async function delByStr(table, col, vals, extraQ) {
  const list = strList(vals);
  for (const c of chunks(list)) {
    let q = db.from(table).delete().in(col, c);
    if (extraQ) q = extraQ(q);
    await q;
  }
}
/** 数值列分块 in 更新（如解除合集归属） */
async function updByNum(table, col, vals, values, extraQ) {
  const list = numList(vals);
  for (const c of chunks(list)) {
    let q = db.from(table).update(values).in(col, c);
    if (extraQ) q = extraQ(q);
    await q;
  }
}

/**
 * 执行物理清除：按清单删除全部关联数据 + 物理删除云存储媒体 + 写入审计记录。
 * @param {number|string} staffId 目标账号
 * @param {number|string} actorStaffId 操作人
 * @param {object} [opts] { family: boolean } 是否随主家长扩散整棵家庭树（默认 true）
 * @returns {Promise<{purge_id, manifest, deleted_counts, media_files, failed}>}
 */
async function executePurge(staffId, actorStaffId, req, opts = {}) {
  const id = Number(staffId);
  if (!id) throw new Error("缺少目标账号");
  if (isProtectedStaff(id)) throw new Error("超级管理员账号受强保护，禁止物理清除");
  const actor = Number(actorStaffId) || 0;

  const manifest = await collectPurgeManifest(id, opts);
  // 后台管理账号（role=admin）不参与物理清除（仅支持业务角色：主家长/孩子/家属/个人）
  if (manifest.target.role === "admin") {
    throw new Error("后台管理账号不支持物理清除，请使用常规删除");
  }
  const { scope, items } = manifest;
  const staffArr = scope.staff;
  const openids = scope.openids;
  const { taskIds, checkinIds, colIds } = manifest._biz;
  const childIds = (scope.childIds || []).map(Number).filter(v => Number.isFinite(v) && v > 0);

  // 受保护账号 & 操作人自己排除出账号删除集（数据仍按范围删，但账号行保留）
  const deletableStaff = numList(staffArr).filter(s => !isProtectedStaff(s) && s !== actor);
  const failures = [];
  const deletedCounts = {};
  const note = async (fn, label) => {
    try { await fn(); } catch (e) {
      failures.push(`${label}: ${(e && e.message) || e}`);
      console.error(`[purge] ${label} error`, e);
    }
  };

  // —— 业务数据 ——
  // 1) 收集范围内全部云存储媒体并物理删除（幂等；删除登记记录）
  await note(async () => {
    const mediaPaths = await collectMediaPaths(scope, taskIds, checkinIds, colIds);
    const { deleted } = await removeFiles(mediaPaths);
    if (deleted.length) { try { await delByStr("file_uploads", "file_path", deleted); } catch (_) {} }
    deletedCounts.media_files = deleted.length;
  }, "删除媒体文件");

  // 2) 任务 / 打卡 / 派发 / 时间轴 / 合集
  if (taskIds.length) {
    await note(() => delByNum("task_checkins", "task_id", taskIds), "删除任务打卡");
    await note(() => delByNum("task_assignees", "task_id", taskIds), "删除任务派发");
    await note(() => delByNum("task_timeline", "task_id", taskIds), "删除任务时间轴");
    await note(() => delByNum("tasks", "task_id", taskIds), "删除任务");
    deletedCounts.tasks = taskIds.length;
  }
  if (checkinIds.length) {
    await note(() => delByNum("task_checkins", "checkin_id", checkinIds), "删除他人任务下打卡");
    await note(() => delByNum("task_timeline", "checkin_id", checkinIds), "删除打卡时间轴");
    deletedCounts.task_checkins = checkinIds.length;
  }
  if (staffArr.length) {
    // 删除本家庭成员在「他人任务」上的打卡前，先记录各任务应回退的打卡次数（保持 task.checkin_count 一致）
    try {
      const { data } = await db.from("task_checkins")
        .select("task_id").in("created_by", staffArr).limit(20000);
      const needDec = {};
      (data || []).forEach(r => {
        const tid = Number(r.task_id);
        if (tid && !taskIds.includes(tid)) needDec[tid] = (needDec[tid] || 0) + 1;
      });
      for (const [tid, cnt] of Object.entries(needDec)) {
        try {
          const { data: tRows } = await db.from("tasks").select("checkin_count").eq("task_id", Number(tid)).limit(1);
          const cur = (tRows && tRows[0] && Number(tRows[0].checkin_count)) || 0;
          const target = Math.max(0, cur - cnt);
          await db.from("tasks").update({ checkin_count: target, updated_at: nowSql() }).eq("task_id", Number(tid));
        } catch (_) {}
      }
    } catch (e) {
      console.error("[purge] 回退他人任务打卡计数失败", e);
    }
    await note(() => delByNum("task_checkins", "created_by", staffArr), "删除其余打卡");
    await note(() => delByNum("task_assignees", "staff_id", staffArr), "删除其余派发");
    await note(() => delByNum("task_timeline", "created_by", staffArr), "删除其余时间轴");
  }
  if (colIds.length) {
    await note(() => updByNum("tasks", "collection_id", colIds, { collection_id: 0, updated_at: nowSql() }), "解除合集归属");
    await note(() => delByNum("task_collections", "collection_id", colIds), "删除合集");
    deletedCounts.task_collections = colIds.length;
    try { invalidateCollectionRows(colIds); } catch (_) {}
  }
  await note(() => delByNum("subjects", "staff_id", staffArr), "删除科目");
  await note(() => delByNum("point_logs", "staff_id", staffArr), "删除积分账本");
  await note(() => delByNum("point_balances", "staff_id", staffArr), "删除积分余额");
  await note(() => delByNum("badge_unlocks", "staff_id", staffArr), "删除徽章解锁");
  await note(() => delByNum("notifications", "staff_id", staffArr), "删除系统通知");

  // —— 授权 / 绑定 / 关系 ——
  if (staffArr.length) {
    await note(() => delByNum("subscribe_grants", "staff_id", staffArr), "删除订阅授权");
    await note(() => delByNum("subscribe_sends", "staff_id", staffArr), "删除订阅发送");
    await note(() => delByNum("lp_students", "staff_id", staffArr), "删除绑定关系");
    await note(() => delByNum("staff_apps", "staff_id", staffArr), "删除小程序授权");
  }
  if (openids.length) {
    await note(() => delByStr("subscribe_grants", "openid", openids), "删除订阅授权(openid)");
    await note(() => delByStr("subscribe_sends", "openid", openids), "删除订阅发送(openid)");
    await note(() => delByStr("lp_students", "openid", openids), "删除绑定关系(openid)");
    await note(() => delByStr("lp_family_members", "member_openid", openids), "删除家属关系(openid)");
    await note(() => delByStr("account_cancellations", "openid", openids), "删除注销申请");
  }
  if (staffArr.length) {
    await note(() => delByNum("lp_invites", "owner_staff_id", staffArr), "删除邀请码(归属)");
    await note(() => delByNum("lp_invites", "bound_staff_id", staffArr), "删除邀请码(绑定)");
  }
  if (openids.length) await note(() => delByStr("lp_invites", "bound_openid", openids), "删除邀请码(绑定openid)");
  if (childIds.length) await note(() => delByNum("lp_invites", "child_id", childIds), "删除邀请码(孩子)");
  if (staffArr.length) {
    await note(() => delByNum("lp_children", "parent_staff_id", staffArr), "删除孩子档案");
    await note(() => delByNum("lp_children", "student_staff_id", staffArr), "删除孩子档案(孩子)");
    await note(() => delByNum("lp_family_members", "owner_staff_id", staffArr), "删除家属关系");
    await note(() => delByNum("lp_family_members", "member_staff_id", staffArr), "删除家属关系(家属)");
  }
  if (staffArr.length) await note(() => delByNum("account_cancellations", "staff_id", staffArr), "删除注销申请(账号)");

  // —— 内容安全 / 文件 / 用户 ——
  if (openids.length) {
    await note(() => delByStr("content_audits", "openid", openids), "删除内容安全审核");
    await note(() => delByStr("user_sessions", "openid", openids), "删除会话画像");
    await note(() => delByStr("user_events", "openid", openids), "删除用户事件");
    await note(() => delByStr("api_trace", "openid", openids), "删除接口链路");
    await note(() => delByStr("users", "openid", openids), "删除微信用户");
  }
  if (taskIds.length) await note(() => delByNum("content_audits", "biz_id", taskIds, q => q.eq("biz_type", "task")), "删除任务内容审核");
  if (checkinIds.length) await note(() => delByNum("content_audits", "biz_id", checkinIds, q => q.eq("biz_type", "checkin")), "删除打卡内容审核");
  if (childIds.length) await note(() => delByNum("content_audits", "biz_id", childIds, q => q.eq("biz_type", "child")), "删除孩子档案审核");
  if (staffArr.length) await note(() => delByNum("content_audits", "biz_id", staffArr, q => q.eq("biz_type", "profile")), "删除资料审核");
  await note(() => delByStr("file_uploads", "openid", openids), "删除文件登记");

  // —— 账号（家长/孩子/家属/个人）——
  if (deletableStaff.length) await note(() => delByNum("staff", "staff_id", deletableStaff), "删除账号");

  // 缓存失效
  try { invalidateStaffRows(deletableStaff); } catch (_) {}
  try { const { invalidatePrefix } = require("./cache"); invalidatePrefix("staffapps:"); } catch (_) {}
  try { const { invalidatePrefix } = require("./cache"); invalidatePrefix("familyScope:"); } catch (_) {}

  // —— 写审计记录 ——
  const summary = items.map(it => ({ key: it.key, label: it.label, count: it.count }));
  const purgeId = await nextSeq("purge_id");
  let actorUsername = "";
  try {
    const { data } = await db.from("staff").select("staff_username").eq("staff_id", actor).limit(1);
    if (data && data[0]) actorUsername = data[0].staff_username || "";
  } catch (_) {}
  await db.from("staff_purges").insert({
    purge_id: purgeId,
    app_id: "miniprogram-kxm",
    target_kind: "staff",
    target_staff_id: Number(id),
    target_role: manifest.target.role,
    target_username: String(manifest.target.username || "").slice(0, 64),
    target_nickname: String(manifest.target.nickname || "").slice(0, 64),
    scope_staff_ids: staffArr.join(","),
    scope_openids: openids.join(","),
    summary: JSON.stringify(summary),
    manifest: JSON.stringify(items),
    media_files: manifest.media_files,
    status: failures.length ? "partial" : "done",
    fail_detail: failures.join("；").slice(0, 2000),
    operator_staff_id: actor,
    operator_username: actorUsername,
    client_ip: req ? getClientIp(req) : "",
    client_fingerprint: req ? getBrowserFingerprint(req) : "",
    created_at: nowSql(),
  });

  return {
    purge_id: String(purgeId),
    target: manifest.target,
    scope: { staff: manifest.scope.staff, openids: manifest.scope.openids },
    deleted_counts: deletedCounts,
    items: summary,
    media_files: manifest.media_files,
    status: failures.length ? "partial" : "done",
    failed: failures,
  };
}

// ==================== 微信用户（openid）冗余数据物理清理 ====================
// 场景：后台「用户管理 → 物理清理」删除某微信用户。仅删除该用户（openid）「自己相关」的数据：
//   1. openid 维度的绑定/文件/会话/事件/链路/审核/订阅/注销/用户画像（users 行）；
//   2. 因删除该绑定而「完全孤儿化」的业务账号（该账号的全部绑定都来自本 openid）：
//      以单账号模式物理清除（family=false，不扩散家庭树，绝不触碰其它 openid 关联的家庭成员/孩子）。

/** 判断某 staff 删除 openid 绑定后是否完全孤儿化（该账号的全部绑定都只来自本 openid） */
async function staffOrphanAfterUser(openid, staffId) {
  const sid = Number(staffId);
  if (!sid || isProtectedStaff(sid)) return false;
  try {
    const { data: sRows } = await db.from("staff").select("staff_role").eq("staff_id", sid).limit(1);
    if (!(sRows && sRows[0]) || sRows[0].staff_role === "admin") return false;
    const { data: binds } = await db.from("lp_students").select("openid").eq("staff_id", sid).limit(200);
    const rows = binds || [];
    if (rows.length === 0) return false;
    return rows.every(b => b.openid === openid);
  } catch (_) {
    return false;
  }
}

// openid 维度清单项（直接按 openid 归属；样本字段取一条代表性字段）
const USER_ITEM_DEFS = [
  { key: "users", label: "微信用户画像", table: "users", col: "openid", pk: "user_id", cols: ["openid", "nickname"] },
  { key: "lp_students", label: "绑定关系", table: "lp_students", col: "openid", pk: "id", cols: ["openid", "staff_id"] },
  { key: "lp_family_members", label: "家属关系", table: "lp_family_members", col: "member_openid", pk: "id", cols: ["member_openid", "member_staff_id"] },
  { key: "lp_invites", label: "邀请码", table: "lp_invites", col: "bound_openid", pk: "invite_id", cols: ["invite_code", "bound_openid"] },
  { key: "account_cancellations", label: "注销申请", table: "account_cancellations", col: "openid", pk: "cancel_id", cols: ["openid", "status"] },
  { key: "subscribe_grants", label: "订阅授权", table: "subscribe_grants", col: "openid", pk: "grant_id", cols: ["openid"] },
  { key: "subscribe_sends", label: "订阅发送", table: "subscribe_sends", col: "openid", pk: "send_id", cols: ["openid"] },
  { key: "content_audits", label: "内容安全审核", table: "content_audits", col: "openid", pk: "audit_id", cols: ["openid", "biz_type"] },
  { key: "file_uploads", label: "文件登记", table: "file_uploads", col: "openid", pk: "file_id", cols: ["file_path", "openid"] },
  { key: "user_sessions", label: "会话画像", table: "user_sessions", col: "openid", pk: "", cols: ["openid"] },
  { key: "user_events", label: "用户事件", table: "user_events", col: "openid", pk: "", cols: ["openid", "event_name"] },
  { key: "api_trace", label: "接口链路", table: "api_trace", col: "openid", pk: "", cols: ["openid", "api_path"] },
];

/** 孤儿账号清单中不与 openid 维度重复的业务表 key（避免同一行被双重统计） */
const USER_STAFF_SIDE_KEYS = new Set([
  "tasks", "task_checkins", "task_assignees", "task_timeline", "task_collections",
  "subjects", "point_logs", "point_balances", "badge_unlocks", "notifications",
  "staff_apps", "lp_children", "staff",
]);

/** openid 维度逐表统计（数量 + 样本），供用户清理预览 */
async function statUserOpenid(openid) {
  const items = [];
  const countOf = async (def) => {
    try {
      if (def.pk) return await countRows(def.table, def.pk, q => q.eq(def.col, openid));
      const { data } = await db.from(def.table).select(def.col).eq(def.col, openid).limit(20000);
      return (data || []).length;
    } catch (_) { return 0; }
  };
  for (const def of USER_ITEM_DEFS) {
    const count = await countOf(def);
    let sample = [];
    if (count > 0) {
      try {
        const { data } = await db.from(def.table).select(...def.cols).eq(def.col, openid).limit(5);
        sample = (data || []).map(r => {
          const out = {};
          def.cols.forEach(f => { out[FIELD_CN[f] || f] = r[f]; });
          return out;
        });
      } catch (_) { /* 无样本不影响 */ }
    }
    items.push({ key: def.key, table: def.table, label: def.label, count, sample });
  }
  return items;
}

/**
 * 构建「用户冗余清理审计清单」（预览与执行共用）。
 * @param {string} openid 目标微信用户 openid
 * @returns {Promise<{target, scope, items, media_files}>}
 */
async function collectUserPurgeManifest(openid) {
  const oid = String(openid || "").trim();
  if (!oid) throw new Error("缺少用户 openid");

  // 用户画像（昵称/UID），仅作审计展示
  let nickname = "";
  let userUid = "";
  try {
    const { data } = await db.from("users").select("openid, nickname, user_uid").eq("openid", oid).limit(1);
    if (data && data[0]) { nickname = data[0].nickname || ""; userUid = data[0].user_uid || ""; }
  } catch (_) {}

  // 因删除本 openid 而完全孤儿化的绑定账号
  let boundStaffIds = [];
  try {
    const { data } = await db.from("lp_students").select("staff_id").eq("openid", oid).limit(500);
    boundStaffIds = [...new Set((data || []).map(r => Number(r.staff_id)).filter(v => v > 0))];
  } catch (_) {}
  const orphanStaffIds = [];
  for (const sid of boundStaffIds) {
    if (await staffOrphanAfterUser(oid, sid)) orphanStaffIds.push(sid);
  }

  // openid 维度清单
  const openidItems = await statUserOpenid(oid);
  const byKey = {};
  openidItems.forEach(it => { byKey[it.key] = it; });

  // 孤儿账号的业务数据（单账号模式），与 openid 维度不重叠的部分并入
  let mediaFiles = 0;
  for (const sid of orphanStaffIds) {
    try {
      const sm = await collectPurgeManifest(sid, { family: false });
      mediaFiles += sm.media_files || 0;
      (sm.items || []).forEach(it => {
        if (!USER_STAFF_SIDE_KEYS.has(it.key)) return; // openid 维度已覆盖的跳过
        if (byKey[it.key]) {
          byKey[it.key].count += Number(it.count) || 0;
        } else {
          byKey[it.key] = it;
        }
      });
    } catch (_) { /* 单个账号统计失败不阻断 */ }
  }
  const items = Object.values(byKey);

  // 孤儿账号简报（scope.staff 供预览展示）
  let orphanBrief = [];
  if (orphanStaffIds.length) {
    try {
      const { data } = await db.from("staff")
        .select("staff_id, staff_username, staff_nickname, staff_role").in("staff_id", orphanStaffIds).limit(100);
      orphanBrief = (data || []).map(s => ({
        staff_id: String(s.staff_id), username: s.staff_username || "",
        nickname: s.staff_nickname || "", role: s.staff_role || "",
      }));
    } catch (_) {}
  }

  return {
    target: { staff_id: "", username: userUid || oid, nickname: nickname || oid, role: "user", openid: oid },
    scope: { staff: orphanBrief, openids: [oid] },
    items,
    media_files: mediaFiles,
    orphan_staff_ids: orphanStaffIds,
  };
}

/**
 * 执行用户冗余数据物理清理：删除 openid 维度全部数据 + 完全孤儿化的业务账号数据 + 写入审计。
 * 只删除该用户自己相关的数据（绝不触碰其它 openid 的用户数据）。
 */
async function executeUserPurge(openid, actorStaffId, req, opts = {}) {
  const oid = String(openid || "").trim();
  if (!oid) throw new Error("缺少用户 openid");
  const actor = Number(actorStaffId) || 0;
  const userId = Number((opts && opts.userId) || 0); // 权威删除键（用户管理列表按 user_id 展示）

  const manifest = await collectUserPurgeManifest(oid);
  const orphanStaffIds = manifest.orphan_staff_ids || [];
  const failures = [];
  const note = async (fn, label) => {
    try { await fn(); } catch (e) {
      failures.push(`${label}: ${(e && e.message) || e}`);
      console.error(`[purge:user] ${label} error`, e);
    }
  };

  // 1) openid 维度：物理删媒体 + 清登记/画像/会话/事件/链路/审核/订阅/绑定/注销/邀请码/用户行
  await note(async () => {
    const { data: files } = await db.from("file_uploads").select("file_path").eq("openid", oid).limit(10000);
    const paths = [...new Set((files || []).map(f => f.file_path).filter(Boolean))];
    if (paths.length) {
      const { deleted } = await removeFiles(paths);
      if (deleted.length) { try { await delByStr("file_uploads", "file_path", deleted); } catch (_) {} }
    }
  }, "删除用户媒体文件");
  await note(() => delByStr("file_uploads", "openid", oid), "删除文件登记");
  await note(() => delByStr("user_sessions", "openid", oid), "删除会话画像");
  await note(() => delByStr("user_events", "openid", oid), "删除用户事件");
  await note(() => delByStr("api_trace", "openid", oid), "删除接口链路");
  await note(() => delByStr("content_audits", "openid", oid), "删除内容安全审核");
  await note(() => delByStr("subscribe_grants", "openid", oid), "删除订阅授权");
  await note(() => delByStr("subscribe_sends", "openid", oid), "删除订阅发送");
  await note(() => delByStr("lp_family_members", "member_openid", oid), "删除家属关系");
  await note(() => delByStr("lp_invites", "bound_openid", oid), "删除邀请码");
  await note(() => delByStr("account_cancellations", "openid", oid), "删除注销申请");
  await note(() => delByStr("lp_students", "openid", oid), "删除绑定关系");
  // 用户画像行：按 openid 与（给定则）主键 user_id 双重删除，保证用户管理列表对应行必然移除
  await note(() => delByStr("users", "openid", oid), "删除微信用户画像");
  if (userId) await note(() => delByNum("users", "user_id", [userId]), "删除微信用户画像(按ID)");

  // 复核：用户画像行必须已删除；仍在则视为失败，禁止对外“已清理成功”
  try {
    const q = userId ? db.from("users").select("user_id").eq("user_id", userId) : db.from("users").select("openid").eq("openid", oid);
    const { data: still } = await q.limit(1);
    if (still && still.length > 0) failures.push("用户画像未删除：记录仍存在（请重试或检查迁移）");
  } catch (_) { /* 复核失败不追加 */ }

  // 关键失败 = 除“云存储媒体删除失败”（可容忍，不影响记录清理）外的删除失败
  const criticalFailures = failures.filter(f => !String(f).startsWith("删除用户媒体文件"));

  // 2) 完全孤儿化的绑定账号：单账号物理清除（family=false，不扩散家庭树，不动其它 openid 的账号）
  for (const sid of orphanStaffIds) {
    try {
      await executePurge(sid, actor, req, { family: false });
    } catch (e) {
      failures.push(`孤儿账号 ${sid}: ${(e && e.message) || e}`);
      console.error(`[purge:user] orphan staff ${sid} error`, e);
    }
  }

  // 缓存失效（用户信息与 familyScope 关联缓存）
  try { const { invalidatePrefix } = require("./cache"); invalidatePrefix("staffapps:"); } catch (_) {}

  // 3) 写用户清理审计（kind=user）
  const summary = manifest.items.map(it => ({ key: it.key, label: it.label, count: it.count }));
  const purgeId = await nextSeq("purge_id");
  let actorUsername = "";
  try {
    const { data } = await db.from("staff").select("staff_username").eq("staff_id", actor).limit(1);
    if (data && data[0]) actorUsername = data[0].staff_username || "";
  } catch (_) {}
  await db.from("staff_purges").insert({
    purge_id: purgeId,
    app_id: "miniprogram-kxm",
    target_kind: "user",
    target_staff_id: orphanStaffIds[0] || 0,
    target_role: "user",
    target_username: String(manifest.target.username || "").slice(0, 64),
    target_nickname: String(manifest.target.nickname || "").slice(0, 64),
    scope_staff_ids: orphanStaffIds.join(","),
    scope_openids: oid,
    summary: JSON.stringify(summary),
    manifest: JSON.stringify(manifest.items),
    media_files: manifest.media_files,
    status: criticalFailures.length ? "partial" : "done",
    fail_detail: failures.join("；").slice(0, 2000),
    operator_staff_id: actor,
    operator_username: actorUsername,
    client_ip: req ? getClientIp(req) : "",
    client_fingerprint: req ? getBrowserFingerprint(req) : "",
    created_at: nowSql(),
  });

  return {
    purge_id: String(purgeId),
    target: manifest.target,
    scope: { staff: manifest.scope.staff, openids: manifest.scope.openids },
    orphan_staff_ids: orphanStaffIds,
    items: summary,
    media_files: manifest.media_files,
    status: criticalFailures.length ? "partial" : "done",
    failed: failures,
  };
}

// ==================== 双向强物理删除（V2：删任何一方，把连到的整块都清掉，不留孤儿） ====================
// 语义：
//   - 删小程序用户(openid)：把它“绑定的账号”连同整棵向下家庭树（主家长→孩子/家属）全部删除，
//     并删除这些账号绑定的所有 openid 的用户画像/会话/文件/媒体等（孩子自己手机的 openid 也一并清，
//     因为它们属于被删家庭）；反之删后台账号/主家长同理（executePurge family=true 已删其 openid 用户）。
//   - 删孩子/家属/个人这类“非主家长”openid：只删该账号自身及其数据（不向上牵连家长）。

/** openid 已绑定（bound=1）的业务账号及角色 */
async function boundStaffsOf(oid) {
  const out = [];
  try {
    const { data } = await db.from("lp_students")
      .select("staff_id").eq("app_id", "miniprogram-kxm").eq("openid", oid).eq("bound_status", 1).limit(100);
    const ids = [...new Set((data || []).map(r => Number(r.staff_id)).filter(v => v > 0))];
    if (!ids.length) return out;
    const { data: staffs } = await db.from("staff")
      .select("staff_id, staff_role").in("staff_id", ids).limit(ids.length);
    (staffs || []).forEach(s => {
      const sid = Number(s.staff_id);
      const role = s.staff_role;
      if (["parent", "family", "student", "personal"].includes(role)) out.push({ staff_id: sid, role });
    });
  } catch (_) {}
  return out;
}

/** 用户清理锚点：parent→整棵家庭(family:true)；family/student/personal→单账号(family:false) */
async function userPurgeAnchors(oid) {
  const bound = await boundStaffsOf(oid);
  const parents = bound.filter(b => b.role === "parent");
  const others = bound.filter(b => b.role !== "parent");
  return { parents: parents.map(b => b.staff_id), others: others.map(b => b.staff_id) };
}

/** 用户清理预览（与执行一致：按锚点整棵/整块统计） */
async function collectUserPurgeManifest2(oid) {
  const oid2 = String(oid || "").trim();
  const anchors = await userPurgeAnchors(oid2);
  const itemsMap = {};
  const scopeStaff = [];
  const seenStaff = new Set();
  const scopeOpenids = [];
  let mediaFiles = 0;
  const addStaffManifest = async (staffId, family) => {
    try {
      const m = await collectPurgeManifest(staffId, { family });
      (m.items || []).forEach(it => {
        const cur = itemsMap[it.key];
        if (cur) cur.count += Number(it.count) || 0;
        else itemsMap[it.key] = { ...it };
      });
      (m.scope.staff || []).forEach(s => {
        if (!seenStaff.has(s.staff_id)) { seenStaff.add(s.staff_id); scopeStaff.push(s); }
      });
      (m.scope.openids || []).forEach(o => { if (!scopeOpenids.includes(o.openid)) scopeOpenids.push(o.openid); });
      mediaFiles += m.media_files || 0;
    } catch (_) {}
  };
  for (const p of anchors.parents) await addStaffManifest(p, true);
  for (const o of anchors.others) await addStaffManifest(o, false);

  let items;
  if (anchors.parents.length || anchors.others.length) {
    items = Object.values(itemsMap);
  } else {
    items = await statUserOpenid(oid2); // 无绑定账号：仅该 openid 自身
  }
  let nickname = oid2;
  let username = oid2;
  try {
    const { data } = await db.from("users").select("nickname, user_uid").eq("openid", oid2).limit(1);
    if (data && data[0]) { nickname = data[0].nickname || oid2; username = data[0].user_uid || oid2; }
  } catch (_) {}
  return {
    target: { staff_id: "", username, nickname, role: "user", openid: oid2 },
    scope: { staff: scopeStaff, openids: scopeOpenids.length ? scopeOpenids : [oid2] },
    items,
    media_files: mediaFiles,
    anchors: { parents: anchors.parents, others: anchors.others },
  };
}

/** openid 维度兜底清理（无绑定账号时的纯 openid 数据 + 已删账号残留） */
async function cleanOpenidRows(oid) {
  const failures = [];
  const note = async (fn, label) => {
    try { await fn(); } catch (e) { failures.push(`${label}: ${(e && e.message) || e}`); }
  };
  await note(async () => {
    const { data: files } = await db.from("file_uploads").select("file_path").eq("openid", oid).limit(10000);
    const paths = [...new Set((files || []).map(f => f.file_path).filter(Boolean))];
    if (paths.length) {
      const { deleted } = await removeFiles(paths);
      if (deleted.length) { try { await delByStr("file_uploads", "file_path", deleted); } catch (_) {} }
    }
  }, "删除用户媒体文件");
  await note(() => delByStr("file_uploads", "openid", oid), "删除文件登记");
  await note(() => delByStr("user_sessions", "openid", oid), "删除会话画像");
  await note(() => delByStr("user_events", "openid", oid), "删除用户事件");
  await note(() => delByStr("api_trace", "openid", oid), "删除接口链路");
  await note(() => delByStr("content_audits", "openid", oid), "删除内容安全审核");
  await note(() => delByStr("subscribe_grants", "openid", oid), "删除订阅授权");
  await note(() => delByStr("subscribe_sends", "openid", oid), "删除订阅发送");
  await note(() => delByStr("lp_family_members", "member_openid", oid), "删除家属关系");
  await note(() => delByStr("lp_invites", "bound_openid", oid), "删除邀请码");
  await note(() => delByStr("account_cancellations", "openid", oid), "删除注销申请");
  await note(() => delByStr("lp_students", "openid", oid), "删除绑定关系");
  await note(() => delByStr("users", "openid", oid), "删除微信用户画像");
  return failures;
}

/** 双向强物理删除小程序用户（V2） */
async function executeUserPurge2(openid, actorStaffId, req, opts = {}) {
  const oid = String(openid || "").trim();
  if (!oid) throw new Error("缺少用户 openid");
  const actor = Number(actorStaffId) || 0;
  const userId = Number((opts && opts.userId) || 0);
  const failures = [];

  const anchors = await userPurgeAnchors(oid);
  // 1) 锚定账号：主家长→整棵家庭（family:true，含孩子/家属及其绑定用户全部清掉）；其它→单账号
  for (const p of anchors.parents) {
    try { await executePurge(p, actor, req, { family: true }); }
    catch (e) { failures.push(`主家长 ${p} 清理失败: ${(e && e.message) || e}`); }
  }
  for (const o of anchors.others) {
    // 若该账号已被上面某家庭整棵删除（父含子）则跳过
    if (anchors.parents.length) {
      const still = await (async () => {
        try { const { data } = await db.from("staff").select("staff_id").eq("staff_id", o).limit(1); return !!(data && data[0]); } catch (_) { return false; }
      })();
      if (!still) continue;
    }
    try { await executePurge(o, actor, req, { family: false }); }
    catch (e) { failures.push(`账号 ${o} 清理失败: ${(e && e.message) || e}`); }
  }
  // 2) 兜底清理该 openid 自身残留（含无绑定账号/已删账号残留）
  failures.push(...(await cleanOpenidRows(oid)));

  // 3) 复核：用户画像必须已删除
  try {
    const q = userId ? db.from("users").select("user_id").eq("user_id", userId) : db.from("users").select("openid").eq("openid", oid);
    const { data: still } = await q.limit(1);
    if (still && still.length > 0) failures.push("用户画像未删除：记录仍存在（请重试或检查迁移）");
  } catch (_) {}

  const criticalFailures = failures.filter(f => !String(f).includes("媒体文件"));
  // 4) 审计（kind=user）
  const summary = anchors.parents.length || anchors.others.length
    ? [{ key: "staff_family", label: "关联后台账号及家庭", count: anchors.parents.length + anchors.others.length }]
    : [];
  const purgeId = await nextSeq("purge_id");
  let actorUsername = "";
  try {
    const { data } = await db.from("staff").select("staff_username").eq("staff_id", actor).limit(1);
    if (data && data[0]) actorUsername = data[0].staff_username || "";
  } catch (_) {}
  await db.from("staff_purges").insert({
    purge_id: purgeId,
    app_id: "miniprogram-kxm",
    target_kind: "user",
    target_staff_id: anchors.parents[0] || anchors.others[0] || 0,
    target_role: "user",
    target_username: String(userId || oid).slice(0, 64),
    target_nickname: String(oid).slice(0, 64),
    scope_staff_ids: [...anchors.parents, ...anchors.others].join(","),
    scope_openids: oid,
    summary: JSON.stringify(summary),
    manifest: JSON.stringify(summary),
    media_files: 0,
    status: criticalFailures.length ? "partial" : "done",
    fail_detail: failures.join("；").slice(0, 2000),
    operator_staff_id: actor,
    operator_username: actorUsername,
    client_ip: req ? getClientIp(req) : "",
    client_fingerprint: req ? getBrowserFingerprint(req) : "",
    created_at: nowSql(),
  });

  return {
    purge_id: String(purgeId),
    target: { staff_id: "", username: String(userId || oid), nickname: oid, role: "user" },
    anchors,
    scope: { staff: [], openids: [oid] },
    items: summary,
    media_files: 0,
    status: criticalFailures.length ? "partial" : "done",
    failed: failures,
  };
}

module.exports = { collectPurgeManifest, executePurge, gatherScope, collectUserPurgeManifest, executeUserPurge, collectUserPurgeManifest2, executeUserPurge2 };
