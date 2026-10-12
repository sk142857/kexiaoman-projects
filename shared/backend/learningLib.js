/**
 * 学习模块公共逻辑（后台学习管理 / 课小满小程序共用）
 * 任务/打卡/合集 关联查询、任务派发、学习仪表盘统计（等级/连击/徽章/提醒）
 */
const { db } = require("./db");
const { nowSql, formatDate, withLock } = require("./utils");
const { nextSeq } = require("./seq");
const { cache, cached, invalidatePrefix } = require("./cache");

// ==================== 参考数据行缓存 ====================
// 员工昵称/合集名等读多写少，按行缓存（TTL 60s），写数据后 invalidatePrefix 失效
const STAFF_TTL = 60 * 1000;
const COL_TTL = 60 * 1000;

/** 批量取员工昵称信息（缓存命中省 RDB 往返），返回 { staff_id(string) -> {staff_id, staff_username, staff_nickname} } */
async function cachedStaffRows(ids) {
  const uniq = [...new Set((ids || []).map(x => String(x)).filter(Boolean))];
  if (uniq.length === 0) return {};
  const map = {};
  const miss = [];
  for (const id of uniq) {
    if (cache.has(`staff:${id}`)) map[id] = cache.get(`staff:${id}`);
    else miss.push(id);
  }
  if (miss.length > 0) {
    try {
      const { data, error } = await db.from("staff")
        .select("staff_id, staff_username, staff_nickname, staff_avatar")
        .in("staff_id", miss).limit(miss.length);
      if (!error && Array.isArray(data)) data.forEach(s => {
        const k = String(s.staff_id);
        map[k] = s;
        cache.set(`staff:${k}`, s, { ttl: STAFF_TTL });
      });
    } catch (_) { /* 缓存失败不回写，下次再查 */ }
  }
  return map;
}

/** 批量取合集名称（缓存命中省 RDB 往返），返回 { collection_id(string) -> {collection_id, name} } */
async function cachedCollectionNames(ids) {
  const uniq = [...new Set((ids || []).map(x => String(x)).filter(Boolean))];
  if (uniq.length === 0) return {};
  const map = {};
  const miss = [];
  for (const id of uniq) {
    if (cache.has(`col:${id}`)) map[id] = cache.get(`col:${id}`);
    else miss.push(id);
  }
  if (miss.length > 0) {
    try {
      const { data, error } = await db.from("task_collections")
        .select("collection_id, name").in("collection_id", miss).limit(miss.length);
      if (!error && Array.isArray(data)) data.forEach(c => {
        const k = String(c.collection_id);
        map[k] = c;
        cache.set(`col:${k}`, c, { ttl: COL_TTL });
      });
    } catch (_) { /* 缓存失败不回写，下次再查 */ }
  }
  return map;
}

/** 员工/合集资料变更后调用，让对应行缓存失效 */
function invalidateStaffRows(ids) {
  (ids || []).forEach(id => cache.delete(`staff:${String(id)}`));
}
function invalidateCollectionRows(ids) {
  (ids || []).forEach(id => cache.delete(`col:${String(id)}`));
}

/** 按字典编码批量取启用字典项（科目下拉等参考数据；缓存 60s，写时失效） */
async function cachedDictItems(dictCode, status = 1) {
  const code = String(dictCode || "").slice(0, 32);
  if (!code) return [];
  return cached(`dict:${code}`, async () => {
    try {
      let q = db.from("dict_items").select().eq("dict_code", code);
      if (status != null) q = q.eq("item_status", status);
      const { data, error } = await q.order("sort", { ascending: true }).limit(500);
      if (error) return [];
      return (data || []).filter(Boolean);
    } catch (_) {
      return [];
    }
  }, 60 * 1000);
}

/** 字典项变更后调用，让对应字典缓存失效 */
function invalidateDictItems(dictCodes) {
  [...new Set((dictCodes || []).map(String).filter(Boolean))].forEach(code => cache.delete(`dict:${code}`));
}

// ==================== 打卡方式 ====================
// 任务发布指定打卡方式：image 图文 / voice 语音 / video 视频（1GB 内，后端 ffmpeg 压缩）
const CHECKIN_TYPE_MAP = { image: "图文", voice: "语音", video: "视频" };
const CHECKIN_TYPE_ALLOWED = ["image", "voice", "video"];
/** 规范化打卡方式：空/非法回退 image */
function normalizeCheckinType(v) {
  const s = String(v || "image").trim();
  return CHECKIN_TYPE_ALLOWED.includes(s) ? s : "image";
}

// ==================== 来源端 ====================
// 发布任务/打卡来自哪个端：web（Web 后台）/ miniprogram（小程序）
const TASK_SOURCE_ALLOWED = ["web", "miniprogram"];
const TASK_SOURCE_DEFAULT = "web";
/** 规范化来源端：空/非法回退 web */
function normalizeTaskSource(v, fallback = TASK_SOURCE_DEFAULT) {
  const s = String(v || "").trim();
  if (TASK_SOURCE_ALLOWED.includes(s)) return s;
  return TASK_SOURCE_ALLOWED.includes(String(fallback || "").trim()) ? String(fallback).trim() : TASK_SOURCE_DEFAULT;
}

// ==================== 图片字段解析 ====================
/** 图片字段解析：兼容 JSON 数组字符串 / 逗号分隔 / 数组，返回相对路径数组 */
function parseImgList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const s = String(value || "").trim();
  if (!s || s === "[]") return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch (_) { /* 非 JSON，按逗号分隔处理 */ }
  }
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

// ==================== 关联信息附加 ====================

/** 任务附加派发人员：assignee_ids（数组）+ assignee_names（昵称数组） */
async function attachAssignees(rows) {
  const list = rows || [];
  if (list.length === 0) return list;
  const taskIds = [...new Set(list.map(r => r.task_id).filter(v => v !== undefined && v !== null && v !== ""))];
  if (taskIds.length === 0) return list;
  const byTask = {};
  const staffIds = new Set();
  const { data: assigns, error } = await db.from("task_assignees")
    .select("task_id, staff_id").in("task_id", taskIds).limit(5000);
  if (!error && Array.isArray(assigns)) assigns.forEach(a => {
    const k = String(a.task_id);
    (byTask[k] = byTask[k] || []).push(Number(a.staff_id));
    staffIds.add(String(a.staff_id));
  });
  const nameMap = await cachedStaffRows([...staffIds]);
  return list.map(r => {
    const ids = byTask[String(r.task_id)] || [];
    return {
      ...r,
      assignee_ids: ids,
      assignee_names: ids.map(id => nameMap[String(id)] ? (nameMap[String(id)].staff_nickname || nameMap[String(id)].staff_username || String(id)) : String(id)),
    };
  });
}

/** 创建人/打卡人按 staff_id 附加员工信息 */
async function attachStaffInfo(rows) {
  const ids = [...new Set((rows || []).map(r => r.created_by).filter(Boolean))];
  if (ids.length === 0) return rows || [];
  const staffMap = await cachedStaffRows(ids);
  return (rows || []).map(r => {
    const s = staffMap[String(r.created_by)] || {};
    return {
      ...r,
      _creatorStaffId: r.created_by,
      _creatorUsername: s.staff_username || "",
      _creatorNickname: s.staff_nickname || "",
      _creatorAvatar: s.staff_avatar || "",
    };
  });
}

/** 任务附加所属合集名称 */
async function attachCollectionName(rows) {
  const ids = [...new Set((rows || []).map(r => r.collection_id).filter(v => v !== undefined && v !== null && v !== 0))];
  if (ids.length === 0) return rows || [];
  const colMap = await cachedCollectionNames(ids);
  return (rows || []).map(r => ({
    ...r,
    collection_name: (colMap[String(r.collection_id)] || {}).name || "",
  }));
}

/** 合集动态统计任务数量 */
async function attachCollectionCount(rows) {
  const ids = [...new Set((rows || []).map(r => r.collection_id).filter(v => v !== undefined && v !== null && v !== 0))];
  const list = rows || [];
  if (ids.length === 0) return list;
  const { data: tasks, error } = await db.from("tasks")
    .select("collection_id").in("collection_id", ids).limit(5000);
  const countMap = {};
  if (!error && Array.isArray(tasks)) tasks.forEach(t => {
    const k = String(t.collection_id);
    countMap[k] = (countMap[k] || 0) + 1;
  });
  return list.map(r => ({ ...r, task_count: countMap[String(r.collection_id)] || 0 }));
}

// ==================== 任务派发 ====================
/** 同步任务派发人员：全量替换 task_assignees。student/personal 固定派发本人；管理员按 assignee_ids */
async function syncTaskAssignees(staffId, role, taskId, assigneeIds) {
  const ids = (role === "student" || role === "personal")
    ? [String(staffId)]
    : (Array.isArray(assigneeIds) ? assigneeIds : []).map(x => String(x)).filter(Boolean);
  let validIds = [];
  try {
    const uniq = [...new Set(ids)];
    if (uniq.length > 0) {
      const { data: sts, error } = await db.from("staff")
        .select("staff_id").eq("staff_role", "student").in("staff_id", uniq).limit(uniq.length);
      if (!error && Array.isArray(sts)) validIds = sts.map(s => Number(s.staff_id));
    }
    await db.from("task_assignees").delete().eq("task_id", taskId);
    if (validIds.length > 0) {
      await db.from("task_assignees").insert(validIds.map(sid => ({ task_id: taskId, staff_id: sid, created_at: nowSql() })));
    }
  } catch (e) {
    console.error("[learningLib] syncTaskAssignees error", e);
    return [];
  }
  return validIds;
}

/** 任务是否已完成（done） */
async function isTaskDone(taskId) {
  try {
    const { data: rows } = await db.from("tasks")
      .select("task_status").eq("task_id", taskId).limit(1);
    return !!(rows && rows[0] && rows[0].task_status === "done");
  } catch (_) {
    return false;
  }
}

// ==================== 学习等级（无限成长模型） ====================
// 设计目标：等级永不封顶，让用户始终有「下一级」可追，持续获得升级正反馈；
// 越往后每一级所需经验越多，因此升级会自然放缓但永不终止（打卡 3 年、10 年也不会满级）。
//
// 曲线（与历史 1~10 级阈值精确衔接，向后兼容，老用户等级不降反升）：
//   升级所需经验（从 L 级升到 L+1 级）：
//     - 1~4 级：固定 100 / 150 / 200 / 250
//     - 5 级起：100 * (L - 2)（300 / 400 / 500 / …，逐级线性递增）
//   累计经验为二次函数，等级 ∝ √经验：早期升级快、后期稳步放缓但无限延伸。
//
// 经验来源：积分账本余额（打卡审核通过 +10、完成任务 +30，删除/回退/不打卡衰减自动扣分）。
const LEVEL_UP_BASE = [100, 150, 200, 250]; // 1→2 … 4→5 级升级所需经验
const LEVEL_SLOPE = 100;                    // 5 级起每级经验递增斜率
const LEVEL_THRESHOLD_SMALL = [0, 100, 250, 450, 700]; // 1~5 级累计经验

/** 从 level 级升到 level+1 级所需经验（level>=1） */
function xpToNextLevel(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  if (lv <= LEVEL_UP_BASE.length) return LEVEL_UP_BASE[lv - 1];
  return LEVEL_SLOPE * (lv - 2); // 5级:300 6级:400 … 10级:800 … 无限递增
}

/** 达到指定等级所需的累计经验（level>=1；level=1 为 0） */
function levelThreshold(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  if (lv <= LEVEL_THRESHOLD_SMALL.length) return LEVEL_THRESHOLD_SMALL[lv - 1];
  // lv>=5：T(L) = 400 + 50*(L-3)*(L-2)（由等差数列求和闭式化，O(1)）
  return 400 + 50 * (lv - 3) * (lv - 2);
}

// 段位称号：区间为 [from, 下一段 from)；超出最后一段后按「星」累加，
// 保证任意等级都有称号、永不出现「无称号/已满级」。
const LEVEL_TIERS = [
  { from: 1,   name: "启蒙学徒" },
  { from: 3,   name: "初学乍练" },
  { from: 5,   name: "勤学不辍" },
  { from: 8,   name: "渐入佳境" },
  { from: 12,  name: "小有所成" },
  { from: 17,  name: "学有所长" },
  { from: 23,  name: "游刃有余" },
  { from: 30,  name: "融会贯通" },
  { from: 38,  name: "博学多才" },
  { from: 47,  name: "学富五车" },
  { from: 57,  name: "才高八斗" },
  { from: 68,  name: "学贯中西" },
  { from: 80,  name: "出类拔萃" },
  { from: 93,  name: "卓尔不群" },
  { from: 107, name: "誉满杏坛" },
  { from: 122, name: "一代宗师" },
  { from: 138, name: "学界泰斗" },
  { from: 155, name: "传奇学者" },
  { from: 173, name: "星辰学神" },
  { from: 192, name: "神话学神" },
];

/** 等级对应段位称号（无限延伸：末段起按星数递增） */
function levelTitle(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  let band = LEVEL_TIERS[0];
  for (const t of LEVEL_TIERS) {
    if (lv >= t.from) band = t; else break;
  }
  const last = LEVEL_TIERS[LEVEL_TIERS.length - 1];
  if (lv >= last.from) return `${last.name}·${lv - last.from + 1}星`;
  return band.name;
}

/**
 * 由累计经验推导等级与升级进度（无限等级，永不封顶）。
 * 返回：level/title/nextLevel/nextTitle/xp/xpInLevel/xpToNext/progress，
 * maxLevel 恒为 false（保留字段以兼容旧前端）。
 */
function levelFromXp(xp) {
  const x = Math.max(0, Math.floor(Number(xp) || 0));
  let level;
  if (x < LEVEL_THRESHOLD_SMALL[LEVEL_THRESHOLD_SMALL.length - 1]) {
    level = 1;
    for (let i = LEVEL_THRESHOLD_SMALL.length - 1; i >= 0; i--) {
      if (x >= LEVEL_THRESHOLD_SMALL[i]) { level = i + 1; break; }
    }
  } else {
    // 解 50*a*(a+1) + 400 <= x（a = level-3），a = floor((-1+√(1+4K))/2)，K=(x-400)/50
    const K = (x - 400) / 50;
    let a = Math.floor((-1 + Math.sqrt(1 + 4 * K)) / 2);
    level = a + 3;
    // 浮点边界修正
    while (levelThreshold(level + 1) <= x) level++;
    while (level > 1 && levelThreshold(level) > x) level--;
  }
  const cur = levelThreshold(level);
  const next = levelThreshold(level + 1);
  const span = next - cur;
  const xpInLevel = x - cur;
  const progress = span > 0 ? Math.min(100, Math.floor((xpInLevel / span) * 100)) : 0;
  return {
    level,
    title: levelTitle(level),
    nextLevel: level + 1,
    nextTitle: levelTitle(level + 1),
    xp: x,
    xpInLevel,
    xpToNext: span - xpInLevel,
    progress,
    maxLevel: false,
  };
}

function streakEndingAt(dateSet, endDate) {
  let streak = 0;
  const cursor = new Date(endDate);
  while (dateSet.has(formatDate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function maxStreakOf(dateSet) {
  const dates = [...dateSet].sort();
  let max = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    const t = new Date(`${d}T00:00:00`).getTime();
    if (prev !== null && t - prev === 86400000) run += 1;
    else run = 1;
    if (run > max) max = run;
    prev = t;
  }
  return max;
}

// ==================== 积分账本（t_lp_point_logs） ====================
// 积分改为账本式：每次加分/减分写流水（reason 区分原因），余额 = 流水累加。
// 规则：打卡审核通过 +10；任务完成 +30（有派发人则每位派发人，否则创建人）；
//      删除已通过打卡 -10；已完成任务回退 -30；删除已完成任务 -30、其已通过打卡每人 -10。
const POINT_REASON_MAP = {
  checkin_approved: "打卡审核通过",
  task_done: "完成任务",
  checkin_deleted: "删除已通过打卡",
  task_undone: "任务状态回退",
  task_deleted: "删除任务回扣",
  inactive_decay: "连续未打卡衰减",
  admin_adjust: "管理员调整",
};

/** 写积分流水（幂等由调用方按业务语义保证；失败仅记日志不阻断主流程），并同步更新余额快照 */
async function logPoints({ staffId, points, reason, refType = "", refId = 0, note = "", createdBy = 0 }) {
  try {
    const logId = await nextSeq("point_log_id");
    const { error } = await db.from("point_logs").insert({
      log_id: logId,
      staff_id: Number(staffId) || 0,
      points: Number(points) || 0,
      reason: String(reason || "admin_adjust").slice(0, 32),
      ref_type: String(refType || "").slice(0, 32),
      ref_id: Number(refId) || 0,
      note: String(note || "").slice(0, 255),
      created_by: Number(createdBy) || 0,
      created_at: nowSql(),
    });
    if (error) throw error;
    await syncPointBalance(Number(staffId), Number(points));
    return logId;
  } catch (e) {
    console.error("[learningLib] logPoints error", e);
    return 0;
  }
}

/** 同步积分余额快照：读改写（进程内互斥，避免并发丢计数；余额表缺失时静默跳过，读侧回退流水求和） */
async function syncPointBalance(staffId, delta) {
  const sid = Number(staffId) || 0;
  const d = Number(delta) || 0;
  if (!sid || !d) return;
  try {
    await withLock(`point:bal:${sid}`, async () => {
      const { data } = await db.from("point_balances").select("balance").eq("staff_id", sid).limit(1);
      const cur = (data && data[0] && Number(data[0].balance)) || 0;
      const next = cur + d;
      if (data && data[0]) {
        await db.from("point_balances").update({ balance: next, updated_at: nowSql() }).eq("staff_id", sid);
      } else {
        await db.from("point_balances").insert({ staff_id: sid, balance: next, updated_at: nowSql() });
      }
    });
  } catch (e) {
    console.error("[learningLib] syncPointBalance error", e);
  }
}

/** 学生积分余额：优先读余额快照（单行）；余额表不可用/无记录时回退账本求和 */
async function staffPoints(staffId) {
  const sid = Number(staffId);
  if (!sid) return 0;
  try {
    const { data, error } = await db.from("point_balances").select("balance").eq("staff_id", sid).limit(1);
    if (!error && data && data[0] && Number(data[0].balance) !== 0) return Number(data[0].balance) || 0;
    if (!error) return 0;
    return await sumPointLogs(sid);
  } catch (_) {
    return 0;
  }
}

/** 账本求和回退（余额表缺失/未回填时用） */
async function sumPointLogs(staffId) {
  try {
    const { data, error } = await db.from("point_logs")
      .select("points").eq("staff_id", Number(staffId)).limit(10000);
    if (error) return 0;
    return (data || []).reduce((s, r) => s + (Number(r.points) || 0), 0);
  } catch (_) {
    return 0;
  }
}

/** 批量学生积分余额：{ staff_id(string) -> balance }（未命中的学生补 0；余额表缺失时回退账本求和） */
async function staffPointsMap(staffIds) {
  const ids = [...new Set((staffIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const map = {};
  if (ids.length === 0) return map;
  try {
    const { data, error } = await db.from("point_balances")
      .select("staff_id, balance").in("staff_id", ids).limit(ids.length);
    if (!error && Array.isArray(data)) {
      data.forEach(r => { map[String(r.staff_id)] = Number(r.balance) || 0; });
      ids.forEach(id => { if (map[String(id)] === undefined) map[String(id)] = 0; });
      return map;
    }
  } catch (_) { /* 余额表不可用，回退账本求和 */ }
  // 回退：账本聚合求和
  try {
    const { data, error } = await db.from("point_logs")
      .select("staff_id, points").in("staff_id", ids).limit(10000);
    if (!error && Array.isArray(data)) {
      data.forEach(r => {
        const k = String(r.staff_id);
        map[k] = (map[k] || 0) + (Number(r.points) || 0);
      });
    }
  } catch (_) { /* 部分失败按 0 计 */ }
  ids.forEach(id => { if (map[String(id)] === undefined) map[String(id)] = 0; });
  return map;
}

/** 最近积分流水（时间倒序，供仪表盘展示明细） */
async function recentPointLogs(staffId, limit = 10) {
  try {
    const { data, error } = await db.from("point_logs")
      .select().eq("staff_id", Number(staffId))
      .order("created_at", { ascending: false }).order("log_id", { ascending: false }).limit(limit);
    if (error) return [];
    return (data || []).map(l => ({
      log_id: String(l.log_id),
      points: Number(l.points) || 0,
      reason: l.reason,
      reason_label: POINT_REASON_MAP[l.reason] || l.reason || "调整",
      ref_type: l.ref_type,
      ref_id: l.ref_id,
      note: l.note,
      created_at: l.created_at,
    }));
  } catch (_) {
    return [];
  }
}

/** 任务完成分收款人：有派发人则每人（去重），否则创建人 */
async function taskDoneRecipients(task) {
  if (!task) return [];
  try {
    const { data, error } = await db.from("task_assignees")
      .select("staff_id").eq("task_id", task.task_id).limit(5000);
    if (!error && Array.isArray(data) && data.length > 0) {
      return [...new Set(data.map(a => Number(a.staff_id)).filter(Boolean))];
    }
  } catch (_) { /* 回退创建人 */ }
  return [Number(task.created_by)].filter(Boolean);
}

/**
 * 任务完成判定（按孩子独立完成）：所有参与人（有派发人则全部派发孩子，否则创建人）
 * 均已有 ≥1 条审核通过的打卡（排除内容安全违规）才算任务完成。
 * 用于：审核通过一条打卡时判断是否整任务可转 done，避免误把未完成孩子的打卡一并关闭。
 */
async function taskAllRecipientsDone(taskId) {
  try {
    const { data: tRows } = await db.from("tasks")
      .select("task_id, created_by").eq("task_id", Number(taskId)).limit(1);
    const task = tRows && tRows[0];
    if (!task) return false;
    const recipients = await taskDoneRecipients(task);
    if (recipients.length === 0) return false;
    const { data: cRows } = await db.from("task_checkins")
      .select("created_by")
      .eq("task_id", task.task_id)
      .eq("review_status", "approved")
      .in("risk_status", ["pass", "pending"])
      .limit(1000);
    const doneIds = new Set((cRows || []).map(c => Number(c.created_by)));
    return recipients.every(id => doneIds.has(Number(id)));
  } catch (_) {
    return false;
  }
}

/** 任务状态流转自动加减分：完成 +30 / 回退 -30（幂等：按 old→new 状态变迁判定，重复调用同变迁不重复计） */
async function applyTaskStatusPoints(task, oldStatus, newStatus, actorStaffId = 0) {
  if (!task) return;
  if (String(oldStatus) === String(newStatus)) return;
  const title = String(task.title || "").slice(0, 40);
  const recipients = await taskDoneRecipients(task);
  if (recipients.length === 0) return;
  if (newStatus === "done") {
    await Promise.all(recipients.map(sid => logPoints({ staffId: sid, points: 30, reason: "task_done", refType: "task", refId: task.task_id, note: `完成任务「${title}」`, createdBy: actorStaffId })));
  } else if (oldStatus === "done") {
    await Promise.all(recipients.map(sid => logPoints({ staffId: sid, points: -30, reason: "task_undone", refType: "task", refId: task.task_id, note: `任务「${title}」状态回退`, createdBy: actorStaffId })));
  }
}

/** 打卡审核通过 +10（调用方保证该打卡由 pending 首次转为 approved） */
async function awardCheckinApproved(checkin, actorStaffId = 0) {
  if (!checkin || !checkin.created_by) return;
  await logPoints({ staffId: checkin.created_by, points: 10, reason: "checkin_approved", refType: "task_checkin", refId: checkin.checkin_id, note: "打卡审核通过 +10", createdBy: actorStaffId });
}

/** 删除已通过打卡 -10（未通过的打卡本就无分，直接忽略） */
async function deductCheckinDeleted(checkin, actorStaffId = 0) {
  if (!checkin || !checkin.created_by) return;
  if (String(checkin.review_status) !== "approved") return;
  await logPoints({ staffId: checkin.created_by, points: -10, reason: "checkin_deleted", refType: "task_checkin", refId: checkin.checkin_id, note: "删除已通过打卡 -10", createdBy: actorStaffId });
}

// ==================== 成就徽章解锁记录（t_lp_badge_unlocks） ====================
// 徽章从「每次现算」升级为「解锁落库」：仪表盘计算时把新解锁徽章写入本表并记录解锁时间。
// 读取结果做进程内缓存（TTL 60s），写库后失效，避免高频 dashboard 重复查库。
const BADGE_UNLOCK_TTL = 60 * 1000;

/** 将新解锁徽章落库（幂等），返回该学生全量 { badge_key -> unlocked_at }，供响应附加解锁时间 */
async function syncBadgeUnlocks(staffId, unlockedKeys) {
  const keys = [...new Set((unlockedKeys || []).map(String).filter(Boolean))];
  const sid = Number(staffId);
  if (!sid || keys.length === 0) return {};
  const cacheKey = `badgeUnlocks:${sid}`;
  const load = async () => {
    const map = {};
    const { data, error } = await db.from("badge_unlocks")
      .select("badge_key, unlocked_at").eq("staff_id", sid).limit(500);
    if (!error && Array.isArray(data)) {
      data.forEach(r => { map[r.badge_key] = r.unlocked_at; });
    }
    return map;
  };
  try {
    let map = await cached(cacheKey, load, BADGE_UNLOCK_TTL);
    const missing = keys.filter(k => !map[k]);
    if (missing.length > 0) {
      const at = nowSql();
      try {
        // 一次性批量写入（幂等：主键 (staff_id,badge_key) 冲突时整批忽略，下次刷新缓存后不再补写）
        await db.from("badge_unlocks").insert(missing.map(k => ({ staff_id: sid, badge_key: k, unlocked_at: at })));
      } catch (_) { /* 并发重复插入忽略 */ }
      cache.delete(cacheKey);
      map = await cached(cacheKey, load, BADGE_UNLOCK_TTL);
    }
    return map;
  } catch (e) {
    console.error("[learningLib] syncBadgeUnlocks error", e);
    return {};
  }
}

/** 删除任务回扣：已完成 -30（收款人同加分方）+ 该任务已通过打卡每人 -10 */
async function deductTaskDeleted(task, actorStaffId = 0) {
  if (!task) return;
  const title = String(task.title || "").slice(0, 40);
  const recipients = await taskDoneRecipients(task);
  if (task.task_status === "done") {
    await Promise.all(recipients.map(sid => logPoints({ staffId: sid, points: -30, reason: "task_deleted", refType: "task", refId: task.task_id, note: `删除任务「${title}」回扣完成分`, createdBy: actorStaffId })));
  }
  try {
    const { data, error } = await db.from("task_checkins")
      .select("checkin_id, created_by, review_status").eq("task_id", task.task_id).limit(10000);
    if (!error && Array.isArray(data)) {
      const approved = data.filter(c => String(c.review_status) === "approved" && c.created_by);
      await Promise.all(approved.map(c => logPoints({ staffId: c.created_by, points: -10, reason: "checkin_deleted", refType: "task_checkin", refId: c.checkin_id, note: `删除任务回扣打卡分「${title}」`, createdBy: actorStaffId })));
    }
  } catch (e) {
    console.error("[learningLib] deductTaskDeleted checkins error", e);
  }
}

/** 打卡/进度提醒文案生成（分级） */
function buildLearningReminders({
  todayCheckedIn, todayCheckins, currentStreak,
  completionRate, doneCount, totalTasks, remainingCount, activeCount,
  overdueCount, dueSoonCount, nextBadge,
}) {
  const reminders = [];
  const hasTasks = totalTasks > 0;
  const severeCompletion = hasTasks && completionRate < 30;
  const lowCompletion = hasTasks && completionRate < 50;

  if (overdueCount > 0) {
    reminders.push({
      type: "banner", severity: "danger", priority: 0, icon: "overdue",
      title: `有 ${overdueCount} 个任务已逾期`,
      desc: overdueCount === 1 ? "有 1 个任务已错过截止日期，建议今天优先补齐，避免进度堆积。" : `有 ${overdueCount} 个任务已错过截止日期，建议先集中处理逾期任务，再推进新进度。`,
    });
  }

  if (!todayCheckedIn) {
    const sev = severeCompletion ? "danger" : "warning";
    reminders.push({
      type: "checkin", severity: sev, priority: severeCompletion ? 1 : 2,
      title: "今日还没打卡",
      desc: nextBadge ? `打卡可累积经验值，距离「${nextBadge.name}」成就更近一步` : "打卡累积经验值，坚持就是胜利",
      cards: [
        { key: "checkin", title: "今日打卡", desc: todayCheckins === 0 ? "今日还没打卡，完成任务后记得打卡，+10 经验" : `今日已打卡 ${todayCheckins} 次，再打卡还能继续累积经验` },
        { key: "streak", title: "保持连击", desc: currentStreak > 0 ? `已连续打卡 ${currentStreak} 天，今天打卡即可保持连击不断` : "从今天开始建立连击，打卡即可开启连击之旅" },
        { key: "task", title: "待办任务", desc: remainingCount === 0 ? "今日任务已全部完成，打个卡收个尾吧" : `还有 ${remainingCount} 个任务待完成${activeCount > 0 ? `，其中 ${activeCount} 个进行中` : ""}${overdueCount > 0 ? `，另有 ${overdueCount} 个已逾期` : ""}` },
      ],
    });
  }

  if (lowCompletion) {
    const sev = severeCompletion ? "danger" : "warning";
    reminders.push({
      type: "banner", severity: sev, priority: severeCompletion ? (todayCheckedIn ? 1 : 3) : 3,
      icon: "percent",
      title: severeCompletion ? "任务完成进度严重偏低" : "任务完成进度偏低",
      desc: `已完成 ${doneCount}/${totalTasks} 个任务，完成率 ${completionRate}%。${activeCount > 0 ? `还有 ${activeCount} 个任务正在推进，` : ""}继续加油！`,
    });
  }

  if (dueSoonCount > 0 && !(overdueCount > 0)) {
    reminders.push({
      type: "banner", severity: "info", priority: 4, icon: "deadline",
      title: `${dueSoonCount} 个任务即将到期`,
      desc: "未来 3 天内有任务将到截止日期，建议提前安排时间完成，避免逾期。",
    });
  }

  if (reminders.length === 0) {
    reminders.push({
      type: "allgood", severity: "success", priority: 9, icon: "success",
      title: "今日状态完美，太棒了！",
      desc: nextBadge ? `今日已打卡，连击保持中，距离解锁「${nextBadge.name}」越来越近啦！` : "今日已打卡，任务完成率亮眼，继续保持！",
    });
  }

  reminders.sort((a, b) => a.priority - b.priority);
  return reminders;
}

module.exports = {
  CHECKIN_TYPE_MAP,
  CHECKIN_TYPE_ALLOWED,
  normalizeCheckinType,
  TASK_SOURCE_ALLOWED,
  TASK_SOURCE_DEFAULT,
  normalizeTaskSource,
  parseImgList,
  attachAssignees,
  attachStaffInfo,
  attachCollectionName,
  attachCollectionCount,
  cachedStaffRows,
  cachedCollectionNames,
  cachedDictItems,
  invalidateStaffRows,
  invalidateCollectionRows,
  invalidateDictItems,
  syncTaskAssignees,
  isTaskDone,
  LEVEL_TIERS,
  xpToNextLevel,
  levelThreshold,
  levelTitle,
  levelFromXp,
  streakEndingAt,
  maxStreakOf,
  buildLearningReminders,
  POINT_REASON_MAP,
  logPoints,
  staffPoints,
  staffPointsMap,
  recentPointLogs,
  taskDoneRecipients,
  taskAllRecipientsDone,
  applyTaskStatusPoints,
  awardCheckinApproved,
  deductCheckinDeleted,
  deductTaskDeleted,
  syncBadgeUnlocks,
};
