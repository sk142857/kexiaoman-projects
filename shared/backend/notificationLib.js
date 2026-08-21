/**
 * 系统通知（站内信，轻量文本；与微信「订阅消息」完全隔离）
 *
 * 与订阅消息的区别：
 *  - 订阅消息：依赖用户订阅次数 + 微信模板，发送结果记录 t_lp_subscribe_sends（subscribeLib）。
 *  - 系统通知：站内文本消息，写入 t_lp_notifications，用户在「个人设置 → 系统通知」查看，
 *    查看即已读；不需要用户订阅、不消耗任何次数、不依赖微信接口。
 *
 * 模板：t_lp_notify_templates（后台「消息通知 → 通知模板」维护，管理员可改）。
 * 每种通知类型（code）× 目标角色（student/parent/family）各一行默认模板，
 * 正文支持占位符 {xxx}，发送时用业务变量替换：
 *   {taskTitle} 任务标题 / {childName} 孩子昵称 / {studentName} 学生昵称
 *   {score} 积分 / {note} 审核意见 / {checkinDate} 打卡日期
 *   {assignerName} 布置人昵称 / {bizName} 业务类型中文（任务/打卡）
 */
const { db } = require("./db");
const { nowSql } = require("./utils");
const { nextSeq } = require("./seq");
const { getAppConfig } = require("./apps");

/** 模板占位符渲染：{key} → vars[key]；缺失保留原占位符（便于后台预览时看到可用变量） */
function renderText(tmpl, vars = {}) {
  return String(tmpl || "").replace(/\{([^{}]+)\}/g, (m, key) => {
    const v = vars[key];
    return v === undefined || v === null || v === "" ? m : String(v);
  });
}

/** 读取员工昵称（优先昵称，回退用户名；用于占位符 childName / assignerName） */
async function staffNickname(staffId) {
  try {
    const { data } = await db.from("staff")
      .select("staff_nickname, staff_username").eq("staff_id", Number(staffId)).limit(1);
    const s = data && data[0];
    return (s && (s.staff_nickname || s.staff_username)) || "";
  } catch (_) {
    return "";
  }
}

/** 读取员工角色（student/parent/family/admin） */
async function staffRole(staffId) {
  try {
    const { data } = await db.from("staff")
      .select("staff_role").eq("staff_id", Number(staffId)).limit(1);
    return (data && data[0] && data[0].staff_role) || "";
  } catch (_) {
    return "";
  }
}

/** 某学生的主家长 + 家属 staff_id 列表（主家长由孩子档案归属，家属由主家长家庭关系扩展） */
async function recipientParentsOfStudent(appId, studentStaffId) {
  const ids = new Set();
  const app = appId || "miniprogram-kxm";
  try {
    const { data: children } = await db.from("lp_children")
      .select("parent_staff_id")
      .eq("app_id", app).eq("student_staff_id", Number(studentStaffId)).eq("child_status", 1)
      .limit(50);
    (children || []).forEach(c => { if (Number(c.parent_staff_id) > 0) ids.add(Number(c.parent_staff_id)); });
    const parentIds = [...ids];
    if (parentIds.length > 0) {
      const { data: fam } = await db.from("lp_family_members")
        .select("member_staff_id")
        .eq("app_id", app).eq("member_status", 1).in("owner_staff_id", parentIds)
        .limit(200);
      (fam || []).forEach(f => { if (Number(f.member_staff_id) > 0) ids.add(Number(f.member_staff_id)); });
    }
  } catch (e) {
    console.error("[notifyLib] recipientParentsOfStudent error", e.message);
  }
  return [...ids];
}

/**
 * 任务归属学生：任务创建人（学生角色）+ 全部派发学生（task_assignees）
 * 用于「任务完成」时定位应向哪些学生的家长/家属发送通知。
 */
async function taskOwnerStudents(task) {
  const ids = new Set();
  if (task && Number(task.created_by) > 0) ids.add(Number(task.created_by));
  try {
    const { data: asg } = await db.from("task_assignees")
      .select("staff_id").eq("task_id", task.task_id).limit(200);
    (asg || []).forEach(a => { if (Number(a.staff_id) > 0) ids.add(Number(a.staff_id)); });
  } catch (_) {}
  const idList = [...ids];
  if (idList.length === 0) return [];
  const { data: staffs } = await db.from("staff")
    .select("staff_id, staff_role").in("staff_id", idList).limit(idList.length);
  return (staffs || []).filter(s => s.staff_role === "student").map(s => s.staff_id);
}

/**
 * 内容安全开关（读 t_apps.content_security JSON；与 contentSecurity.readSecurityCfg 同源，
 * 直接走 getAppConfig 避免与 contentSecurity.js 循环依赖）
 */
async function contentSecurityEnabled(appId) {
  try {
    const cfg = await getAppConfig(appId || "miniprogram-kxm");
    const cs = JSON.parse((cfg && cfg.content_security) || "{}");
    return !!cs.enabled;
  } catch (_) {
    return false;
  }
}

/**
 * 业务记录是否可安全下发「内容引用类通知」（杜绝把未过审/违规内容通知给孩子、家长）：
 *  - reject：违规，永不发送
 *  - pass：安全，可发
 *  - pending / 空：内容安全开启时视为「检测中」→ 延后重试；关闭时 risk_status 无意义 → 照常发
 */
async function recordSendSafe(appId, record) {
  const rs = record ? String(record.risk_status || "") : "";
  if (rs === "reject") return { ok: false, reason: "reject" };
  if (rs === "pass") return { ok: true };
  const on = await contentSecurityEnabled(appId);
  if (!on) return { ok: true };
  return { ok: false, reason: "pending" };
}

/** 检测中延后重试（进程内 setTimeout，等检测通过后再发；每次重试重新读 risk_status，幂等） */
function deferRetry(fn, attempt = 0, maxAttempts = 12, delayMs = 15000) {
  if (attempt >= maxAttempts) return;
  setTimeout(() => { fn(attempt + 1).catch(() => {}); }, delayMs);
}

/**
 * 发送系统通知（低层函数）：
 * 按 (code × 接收人角色) 匹配模板渲染后逐人写入 t_lp_notifications；
 * 无匹配模板/模板禁用时静默跳过（fail-open，不影响业务主流程）。
 * @param {object} p
 * @param {string} p.appId 小程序 app_id
 * @param {string} p.type 通知类型 code（须与模板 code 一致）
 * @param {Array<number|string>} p.staffIds 接收人 staff_id（角色由 t_staff 实时解析）
 * @param {object} [p.vars] 占位符变量
 * @param {string} [p.bizType] 业务类型 task/checkin
 * @param {string|number} [p.bizId] 业务 ID
 * @param {string} [p.tplRole] 覆盖模板角色（默认按接收人实际角色匹配模板；
 *   如内容违规时非学生创建人复用 student 模板的「你」文案）
 * @returns {Promise<number>} 实际写入条数
 */
async function sendNotification({ appId, type, staffIds, vars = {}, bizType = "", bizId = "", tplRole = "" }) {
  const app = appId || "miniprogram-kxm";
  const ids = [...new Set((Array.isArray(staffIds) ? staffIds : []).map(Number).filter(v => v > 0))];
  if (ids.length === 0) return 0;
  const rows = [];
  try {
    const { data: staffs } = await db.from("staff")
      .select("staff_id, staff_role").in("staff_id", ids).limit(ids.length);
    const roleMap = {};
    (staffs || []).forEach(s => { roleMap[String(s.staff_id)] = s.staff_role || ""; });
    const roles = [...new Set(Object.values(roleMap).filter(Boolean))];
    if (roles.length === 0) return 0;
    // tplRole 覆盖（如内容违规非学生创建人复用 student 模板）时必须一并纳入查询，否则取不到模板
    const queryRoles = tplRole ? [...new Set([...roles, tplRole])] : roles;
    const { data: tpls } = await db.from("notify_templates")
      .select("target_role, title_tmpl, content_tmpl")
      .eq("app_id", app).eq("code", String(type).slice(0, 64)).eq("enabled", 1)
      .in("target_role", queryRoles).limit(queryRoles.length * 4);
    // 诊断：类型没有启用模板时记录告警（否则「检测到风险但没通知」无法排查）
    if (!tpls || tpls.length === 0) {
      console.warn(`[notifyLib] 系统通知未下发：type=${type} app=${app} roles=[${queryRoles.join(",")}] 无匹配的启用模板（请检查 t_lp_notify_templates 是否已初始化 / 模板是否被停用）`);
      return 0;
    }
    const tplByRole = {};
    (tpls || []).forEach(t => { if (!tplByRole[t.target_role]) tplByRole[t.target_role] = t; });
    for (const sid of ids) {
      const role = roleMap[String(sid)];
      // tplRole 覆盖时，所有接收人统一用该角色的模板（如内容违规：非学生创建人也用「你」文案）
      const tplRoleKey = tplRole || role;
      const tpl = tplRoleKey && tplByRole[tplRoleKey];
      if (!tpl) continue;
      rows.push({
        notify_id: await nextSeq("notify_id"),
        app_id: app,
        staff_id: sid,
        role,
        type: String(type).slice(0, 64),
        title: renderText(tpl.title_tmpl, vars).slice(0, 128),
        content: renderText(tpl.content_tmpl, vars).slice(0, 500),
        biz_type: String(bizType || "").slice(0, 24),
        biz_id: String(bizId == null ? "" : bizId).slice(0, 64),
        is_read: 0,
        read_at: null,
        created_at: nowSql(),
      });
    }
    if (rows.length > 0) {
      const { error } = await db.from("notifications").insert(rows);
      if (error) throw error;
    }
  } catch (e) {
    console.error("[notifyLib] sendNotification error", e.message);
  }
  return rows.length;
}

/**
 * 学生 + 其家长/家属一起通知（审核结果、内容违规等场景）：
 * 家长/家属与学生会各自匹配到角色专属模板（不同角色收到不同文案）。
 */
async function sendToStudentAndParents({ appId, studentStaffId, type, vars, bizType, bizId, excludeStaffId }) {
  const sid = Number(studentStaffId);
  if (!sid) return 0;
  let staffIds = [sid, ...(await recipientParentsOfStudent(appId, sid))];
  if (excludeStaffId) staffIds = staffIds.filter(x => Number(x) !== Number(excludeStaffId));
  return sendNotification({ appId, type, staffIds, vars, bizType, bizId });
}

/**
 * 打卡审核结果通知（通过/驳回）：提交学生 + 其家长/家属；审核人自己除外（家长审自家孩子不需自通知）
 */
async function notifyReviewResult({ appId, studentStaffId, taskTitle, score = 10, note = "", result, checkinId, actorStaffId }) {
  const childName = await staffNickname(studentStaffId);
  const vars = { taskTitle, childName, score, note };
  return sendToStudentAndParents({
    appId,
    studentStaffId,
    type: result === "approve" ? "checkin_approved" : "checkin_rejected",
    vars,
    bizType: "checkin",
    bizId: checkinId,
    excludeStaffId: actorStaffId,
  });
}

/** 学生提交打卡：提醒其家长/家属及时审核（学生本人不通知；门控：任务内容安全后才发） */
async function notifyCheckinSubmitted({ appId, studentStaffId, taskTitle, checkinDate, checkinId, taskId, _attempt = 0 }) {
  // 门控：任务违规不把标题透露给家长；检测中延后
  let task = null;
  try {
    const { data } = await db.from("tasks")
      .select("risk_status, title").eq("task_id", Number(taskId)).limit(1);
    task = data && data[0];
  } catch (_) { /* 读取失败 fail-open */ }
  const safe = await recordSendSafe(appId, task);
  if (!safe.ok) {
    if (safe.reason === "pending") {
      deferRetry((a) => notifyCheckinSubmitted({ appId, studentStaffId, taskTitle, checkinDate, checkinId, taskId, _attempt: a }), _attempt);
    }
    return 0;
  }
  const childName = await staffNickname(studentStaffId);
  const parents = await recipientParentsOfStudent(appId, studentStaffId);
  if (parents.length === 0) return 0;
  return sendNotification({
    appId,
    type: "checkin_submitted",
    staffIds: parents,
    vars: { taskTitle: (task && task.title) || taskTitle || "", childName, checkinDate },
    bizType: "checkin",
    bizId: checkinId,
  });
}

/** 内容违规：提交人 + 其家长/家属（bizName=业务类型中文，如 任务/打卡）
 *  - 学生提交的内容 → 学生（你）+ 家长/家属（孩子）
 *  - 家长/家属/管理员创建的任务内容被拦截 → 仅创建人本人（你，复用 student 模板文案） */
async function notifyContentViolation({ appId, studentStaffId, taskTitle, bizName = "内容", bizType = "", bizId = "" }) {
  const creatorId = Number(studentStaffId);
  if (!creatorId) return 0;
  const childName = await staffNickname(creatorId);
  if ((await staffRole(creatorId)) === "student") {
    return sendToStudentAndParents({
      appId,
      studentStaffId: creatorId,
      type: "content_violation",
      vars: { taskTitle, childName, bizName },
      bizType,
      bizId,
    });
  }
  return sendNotification({
    appId,
    type: "content_violation",
    staffIds: [creatorId],
    tplRole: "student",
    vars: { taskTitle, childName, bizName },
    bizType,
    bizId,
  });
}

/** 新任务派发：通知被派发的学生（门控：任务内容安全确认后才发，杜绝违规任务先通知给孩子） */
async function notifyTaskAssigned({ appId, taskId, taskTitle, assigneeIds, assignerStaffId, _attempt = 0 }) {
  const ids = [...new Set((Array.isArray(assigneeIds) ? assigneeIds : []).map(Number).filter(v => v > 0))];
  if (ids.length === 0) return 0;
  // 门控：reject 不发；pending（内容安全开启）延后重试，等检测通过后再发
  let task = null;
  try {
    const { data } = await db.from("tasks")
      .select("risk_status, title").eq("task_id", Number(taskId)).limit(1);
    task = data && data[0];
  } catch (_) { /* 读取失败 fail-open，不阻塞 */ }
  const safe = await recordSendSafe(appId, task);
  if (!safe.ok) {
    if (safe.reason === "pending") {
      deferRetry((a) => notifyTaskAssigned({ appId, taskId, taskTitle, assigneeIds, assignerStaffId, _attempt: a }), _attempt);
    }
    return 0;
  }
  const title = (task && task.title) || taskTitle || "";
  const assignerName = assignerStaffId ? await staffNickname(assignerStaffId) : "";
  return sendNotification({
    appId,
    type: "task_assigned",
    staffIds: ids,
    vars: { taskTitle: title, assignerName },
    bizType: "task",
    bizId: taskId,
  });
}

/** 任务完成：通知任务归属学生（你…）及家长/家属（孩子…），操作人自己除外（门控：任务违规不发送） */
async function notifyTaskDone({ appId, task, actorStaffId, _attempt = 0 }) {
  // 门控：任务违规不发送「已完成」通知；检测中延后
  const safe = await recordSendSafe(appId, task);
  if (!safe.ok) {
    if (safe.reason === "pending") {
      deferRetry((a) => notifyTaskDone({ appId, task, actorStaffId, _attempt: a }), _attempt);
    }
    return 0;
  }
  const students = await taskOwnerStudents(task);
  if (students.length === 0) return 0;
  const recipients = new Set();
  for (const sid of students) {
    // 学生本人（模板用「你」）；家长/家属（模板用「孩子」）
    recipients.add(Number(sid));
    (await recipientParentsOfStudent(appId, sid)).forEach(p => recipients.add(Number(p)));
  }
  if (actorStaffId) recipients.delete(Number(actorStaffId));
  if (recipients.size === 0) return 0;
  const childName = students.length === 1 ? (await staffNickname(students[0])) || "孩子" : "孩子";
  return sendNotification({
    appId,
    type: "task_done",
    staffIds: [...recipients],
    vars: { taskTitle: (task && task.title) || "", childName, score: Number((task && task.score) || 0) },
    bizType: "task",
    bizId: (task && task.task_id) || "",
  });
}

module.exports = {
  renderText,
  staffNickname,
  staffRole,
  recipientParentsOfStudent,
  sendNotification,
  sendToStudentAndParents,
  notifyReviewResult,
  notifyCheckinSubmitted,
  notifyContentViolation,
  notifyTaskAssigned,
  notifyTaskDone,
};
