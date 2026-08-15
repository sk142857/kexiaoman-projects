/**
 * 课小满业务路由（小程序端学习管理）
 *
 * 身份：lpAuth 中间件注入 req.lp = { staffId, openid, role }（student / admin）
 * 数据：t_lp_* 表（tasks / task_checkins / task_collections / task_assignees / task_timeline）
 * 权限：
 *   学生（student）：只能访问「派发给我 / 我创建」的任务，打卡/合集归属本人
 *   管理员（admin）：可切换查看任意学生（asStaffId）的任务与打卡，可派发/管理任意任务
 *   合集查询 GET /collections 为白名单接口（免登录只读）；合集创建/编辑/删除仅管理员
 */
const express = require("express");
const { db } = require("../db");
const { ok, fail } = require("../response");
const { nowSql, formatDate, genId } = require("../utils");
const { nextSeq } = require("../seq");
const { uploadImage, logUpload, bindBizId, removeFiles, dupSharedImages } = require("../storage");
const { logTaskEvent } = require("../taskTimeline");
const { logEvent } = require("../events");
const { getAppConfig } = require("../apps");
const { reportTrace } = require("../trace");
const { sendReviewNotification } = require("../subscribeLib");
const {
  parseImgList, attachAssignees, attachStaffInfo, attachCollectionName, attachCollectionCount,
  syncTaskAssignees, isTaskDone, levelFromXp, streakEndingAt, maxStreakOf, buildLearningReminders,
  invalidateCollectionRows, cachedDictItems, cachedStaffRows,
} = require("../learningLib");

const router = express.Router();

const me = (req) => String((req.lp && req.lp.staffId) || "");
const myOpenid = (req) => (req.lp && req.lp.openid) || "";
const isAdmin = (req) => (req.lp && req.lp.role) === "admin";
/** 可管理任务/可审核打卡的角色：平台管理员 / 主家长 / 家属（学生不可） */
const isManager = (req) => ["admin", "parent", "family"].includes(req.lp && req.lp.role);
/** 当前用户的家庭可见范围（孩子 student staff_id 数组；null=admin 全部） */
const myScope = (req) => (req.lp && req.lp.scope) || null;

/**
 * 当前业务视角的 staff_id：管理员/主家长/家属可带 asStaffId 切换查看孩子；学生固定本人。
 * - admin：任意学生；主家长/家属：仅限本家庭范围内孩子（scope 校验，越权回退本人）
 * - 未指定或指定非法时回退到本人。
 */
async function viewStaffId(req) {
  if (!isManager(req)) return me(req);
  const as = Number((req.query && req.query.asStaffId) || (req.body && req.body.asStaffId) || 0);
  const scope = myScope(req);
  if (as) {
    const inScope = scope === null || scope.includes(String(as));
    if (inScope) {
      try {
        const { data } = await db.from("staff")
          .select("staff_id").eq("staff_id", as).eq("staff_role", "student").limit(1);
        if (data && data[0]) return String(as);
      } catch (_) { /* 回退本人 */ }
    }
  }
  // 主家长/家属未指定或非法时，回退到本家庭第一个孩子（避免空视角）
  if (scope !== null && Array.isArray(scope) && scope.length > 0) return scope[0];
  return me(req);
}

/** 校验某任务是否在当前用户家庭范围内（admin=任意；parent/family=本家庭孩子创建或被派发） */
async function taskInScope(req, task) {
  const scope = myScope(req);
  if (scope === null) return true;
  if (!task) return false;
  if (scope.includes(String(task.created_by))) return true;
  // 空 scope（家长/家属名下无孩子）直接判定不在范围内，避免空数组 in() 报错
  if (scope.length === 0) return false;
  try {
    const { data } = await db.from("task_assignees")
      .select("task_id").eq("task_id", task.task_id).in("staff_id", scope).limit(1);
    if (data && data[0]) return true;
  } catch (_) {}
  return false;
}

// ==================== 会话心跳 ====================
// 轻量实时复核：后台解除绑定/作废邀请码后，前端轮询此接口立即收到 401 并清除登录态；
// 账号被后台锁定时收到 403（锁定态，需联系管理员）。
// 只读、无业务计算，仅依赖 lpAuth 中间件已完成的「绑定 + 员工在职」实时校验。
router.get("/session", async (req, res) => {
  res.json(ok({ role: req.lpRole, staffId: req.lp.staffId }));
});

// ==================== 我的资料 ====================
router.get("/profile", async (req, res) => {
  try {
    const { data: rows, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_role")
      .eq("staff_id", Number(me(req))).limit(1);
    if (error) throw error;
    const staff = rows && rows[0];
    if (!staff) return res.json(fail("账号不存在", 403));
    res.json(ok({
      app: req.appId || "learning-planet",
      staff: {
        staff_id: String(staff.staff_id),
        username: staff.staff_username,
        nickname: staff.staff_nickname || "学生",
      },
    }));
  } catch (e) {
    console.error("[lp] profile error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 更新我的昵称（同步 staff_nickname） */
router.post("/profile", async (req, res) => {
  try {
    const { nickname } = req.body || {};
    const n = String(nickname || "").trim().slice(0, 32);
    if (!n) return res.json(fail("昵称不能为空"));
    await db.from("staff").update({ staff_nickname: n, updated_at: nowSql() }).eq("staff_id", Number(me(req)));
    res.json(ok({ nickname: n }, "已更新"));
  } catch (e) {
    console.error("[lp] profile update error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 管理员/家长/家属：学生列表（用于切换查看学生任务） ====================
router.get("/admin/students", async (req, res) => {
  try {
    if (!isManager(req)) return res.json(fail("无权操作", 403));
    const scope = myScope(req);
    // 空 scope（家长/家属名下无孩子）：直接返回空列表，避免空数组 in() 报错
    if (scope !== null && scope.length === 0) return res.json(ok({ list: [] }));
    let q = db.from("staff").select("staff_id, staff_username, staff_nickname, staff_status")
      .eq("staff_role", "student");
    if (scope !== null) q = q.in("staff_id", scope);
    const { data: rows, error } = await q.order("staff_id", { ascending: true }).limit(2000);
    if (error) throw error;
    const students = rows || [];
    const staffIds = students.map(s => Number(s.staff_id)).filter(Boolean);

    // 每个学生的任务统计 + 待审核打卡数
    const statMap = {};
    staffIds.forEach(id => {
      statMap[String(id)] = { total: 0, todo: 0, doing: 0, done: 0, pendingReview: 0 };
    });
    if (staffIds.length > 0) {
      const [assignR, ownR, pendR] = await Promise.all([
        db.from("task_assignees").select("task_id, staff_id").in("staff_id", staffIds).limit(10000),
        db.from("tasks").select("task_id, task_status, created_by").in("created_by", staffIds).limit(10000),
        db.from("task_checkins").select("created_by").eq("review_status", "pending").in("created_by", staffIds).limit(10000),
      ]);
      const taskIds = new Set();
      const byStaff = {};
      const addTask = (sid, tid) => {
        if (!sid || !tid) return;
        (byStaff[String(sid)] = byStaff[String(sid)] || new Set()).add(Number(tid));
        taskIds.add(Number(tid));
      };
      (assignR.data || []).forEach(a => addTask(a.staff_id, a.task_id));
      (ownR.data || []).forEach(t => addTask(t.created_by, t.task_id));
      const statusMap = {};
      if (taskIds.size > 0) {
        const { data: tRows } = await db.from("tasks")
          .select("task_id, task_status").in("task_id", [...taskIds]).limit(taskIds.size);
        (tRows || []).forEach(t => { statusMap[Number(t.task_id)] = t.task_status; });
      }
      Object.entries(byStaff).forEach(([sid, tset]) => {
        const c = statMap[sid];
        if (!c) return;
        tset.forEach(tid => {
          c.total += 1;
          const st = statusMap[tid];
          if (st === "todo") c.todo += 1;
          else if (st === "doing") c.doing += 1;
          else if (st === "done") c.done += 1;
        });
      });
      (pendR.data || []).forEach(c => {
        const s = statMap[String(c.created_by)];
        if (s) s.pendingReview += 1;
      });
    }

    res.json(ok({
      list: students.map(s => ({
        staff_id: String(s.staff_id),
        username: s.staff_username,
        nickname: s.staff_nickname || s.staff_username || "学生",
        status: s.staff_status,
        stats: statMap[String(s.staff_id)] || { total: 0, todo: 0, doing: 0, done: 0, pendingReview: 0 },
      })),
    }));
  } catch (e) {
    console.error("[lp] admin students error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 我的任务范围 ====================
/** 学生可见任务 ID 集合：派发给我 + 我创建 */
async function myTaskIds(staffId) {
  const set = new Set();
  const [assignR, ownR] = await Promise.all([
    db.from("task_assignees").select("task_id").eq("staff_id", staffId).limit(5000),
    db.from("tasks").select("task_id").eq("created_by", staffId).limit(5000),
  ]);
  (assignR.data || []).forEach(a => set.add(String(a.task_id)));
  (ownR.data || []).forEach(t => set.add(String(t.task_id)));
  return [...set].map(x => Number(x));
}

// ==================== 任务列表（学生：派发给我+我创建；管理员：视角学生） ====================
router.get("/tasks", async (req, res) => {
  try {
    const { status, collectionId, keyword } = req.query;
    const staffId = Number(await viewStaffId(req));
    const ids = await myTaskIds(staffId);
    if (ids.length === 0) return res.json(ok({ list: [], total: 0 }));

    let q = db.from("tasks").select();
    // 学生可见：派发给我 + 我创建
    q = q.in("task_id", ids);
    if (status) q = q.eq("task_status", String(status).slice(0, 16));
    if (collectionId) q = q.eq("collection_id", Number(collectionId));
    if (keyword) q = q.or(`title.ilike.%${String(keyword).replace(/[(),]/g, "").slice(0, 100)}%`);

    const { data: rows, error } = await q.order("updated_at", { ascending: false }).limit(200);
    if (error) throw error;

    let list = rows || [];
    if (list.length > 0) {
      const [withCol, withAsg] = await Promise.all([attachCollectionName(list), attachAssignees(list)]);
      list = list.map((t, i) => ({ ...t, ...(withCol[i] || {}), ...(withAsg[i] || {}) }));
    }
    list = list.map(t => ({
      task_id: t.task_id,
      title: t.title,
      subject: t.subject,
      tags: safeJson(t.tags, []),
      description: t.description,
      task_link: t.task_link,
      images: parseImgList(t.images),
      task_status: t.task_status,
      score: t.score,
      deadline: t.deadline,
      start_date: t.start_date,
      collection_id: t.collection_id,
      collection_name: t.collection_name || "",
      checkin_count: t.checkin_count || 0,
      created_by: t.created_by,
      created_at: t.created_at,
    }));
    res.json(ok({ list, total: list.length }));
  } catch (e) {
    console.error("[lp] tasks list error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 任务详情（含视角学生本人的打卡） ====================
router.get("/tasks/detail", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json(fail("缺少任务 ID"));
    const staffId = Number(await viewStaffId(req));
    const ids = await myTaskIds(staffId);
    if (!ids.includes(Number(id))) return res.json(fail("无权访问该任务", 403));

    const [tRes, cRes] = await Promise.all([
      db.from("tasks").select().eq("task_id", Number(id)).limit(1),
      db.from("task_checkins").select().eq("task_id", Number(id)).eq("created_by", staffId).order("checkin_date", { ascending: false }).limit(200),
    ]);
    if (tRes.error) throw tRes.error;
    if (cRes.error) throw cRes.error;
    const task = tRes.data && tRes.data[0];
    if (!task) return res.json(fail("任务不存在"));
    const cRows = cRes.data || [];

    const [withCol, withAsg] = await Promise.all([attachCollectionName([task]), attachAssignees([task])]);
    const merged = { ...(withAsg[0] || {}), ...(withCol[0] || {}) };
    res.json(ok({
      task: {
        task_id: task.task_id,
        title: task.title,
        subject: task.subject,
        tags: safeJson(task.tags, []),
        description: task.description,
        task_link: task.task_link,
        images: parseImgList(task.images),
        task_status: task.task_status,
        score: task.score,
        deadline: task.deadline,
        start_date: task.start_date,
        collection_id: task.collection_id,
        collection_name: merged.collection_name || "",
        checkin_count: task.checkin_count || 0,
        assignee_ids: merged.assignee_ids || [],
        created_by: task.created_by,
        created_at: task.created_at,
      },
      checkins: (cRows || []).map(c => ({
        checkin_id: c.checkin_id,
        checkin_date: c.checkin_date,
        checkin_note: c.checkin_note,
        images: parseImgList(c.checkin_images),
        review_status: c.review_status || "approved",
        review_score: c.review_score || 0,
        review_note: c.review_note || "",
        created_at: c.created_at,
      })),
    }));
  } catch (e) {
    console.error("[lp] task detail error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 创建任务（学生自建，派发固定本人） ====================
router.post("/tasks/create", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const b = req.body || {};
    const title = String(b.title || "").trim().slice(0, 100);
    if (!title) return res.json(fail("任务标题不能为空"));

    const taskId = await nextSeq("task_id");
    const values = {
      task_id: taskId,
      title,
      subject: String(b.subject || "").slice(0, 32),
      description: String(b.description || "").slice(0, 500),
      task_link: String(b.task_link || "").slice(0, 500),
      tags: JSON.stringify(Array.isArray(b.tags) ? b.tags.slice(0, 20) : []),
      images: JSON.stringify(Array.isArray(b.images) ? b.images.slice(0, 9) : []),
      task_status: "todo",
      score: Number(b.score) || 0,
      deadline: String(b.deadline || "").slice(0, 10),
      start_date: String(b.start_date || "").slice(0, 10),
      collection_id: Number(b.collection_id) || 0,
      checkin_count: 0,
      created_by: staffId,
      created_at: nowSql(),
      updated_at: nowSql(),
    };
    const { error } = await db.from("tasks").insert(values);
    if (error) throw error;

    // 学生自建派发本人；家长/家属/管理员可指定派发给本家庭孩子（越权过滤）
    const manager = isManager(req);
    let assigneeIds = Array.isArray(b.assignee_ids) ? b.assignee_ids.map(x => String(x)).filter(Boolean) : [];
    const scope = myScope(req);
    if (manager && scope !== null) {
      assigneeIds = assigneeIds.filter(x => scope.includes(x));
    }
    await syncTaskAssignees(String(staffId), req.lp.role || "student", taskId, assigneeIds);
    // 图片完全复制：若提交的图片已被其他任务绑定（复制场景），物理复制新文件归本任务，避免原任务删除后图片失效
    let images = Array.isArray(b.images) ? b.images : [];
    if (images.length > 0) {
      const owned = await dupSharedImages({ openid: myOpenid(req), staffId: "", paths: images, targetBizId: taskId, biz: "tasks" });
      if (owned.join("|") !== images.join("|")) {
        await db.from("tasks").update({ images: JSON.stringify(owned), updated_at: nowSql() }).eq("task_id", taskId);
      }
      await bindBizId({ openid: myOpenid(req), paths: owned, bizId: taskId });
    }

    logTaskEvent({
      taskId, bizType: "task", eventType: "create", eventName: "创建任务",
      summary: `小程序端创建任务「${title}」`,
      payload: { title, subject: values.subject, task_status: "todo" },
      staffId,
    });
    logEvent({ appId: req.appId, openid: myOpenid(req), eventType: "create", eventName: "创建学习任务", pagePath: "/pages/task-edit/index", bizId: String(taskId) });
    res.json(ok({ task_id: taskId }, "创建成功"));
  } catch (e) {
    console.error("[lp] task create error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 复制任务（完全复制：图片物理复制新文件，新任务独立于原任务） ====================
router.post("/tasks/copy", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const manager = isManager(req);
    const b = req.body || {};
    const srcId = Number(b.id || b.taskId);
    if (!srcId) return res.json(fail("缺少任务 ID"));

    // 可见性校验：学生只能复制「派发给我/我创建」的任务；家长/家属/管理员复制本家庭范围内任务
    let src = null;
    if (manager) {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", srcId).limit(1);
      if (error) throw error;
      src = rows && rows[0];
      if (src && !await taskInScope(req, src)) return res.json(fail("无权复制该任务", 403));
    } else {
      const ids = await myTaskIds(String(staffId));
      if (!ids.includes(srcId)) return res.json(fail("无权复制该任务", 403));
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", srcId).limit(1);
      if (error) throw error;
      src = rows && rows[0];
    }
    if (!src) return res.json(fail("任务不存在"));

    // 完全复制：图片物理复制新文件（新路径、新任务当前日期目录），与源任务解耦
    const srcImages = parseImgList(src.images);
    const newTaskId = await nextSeq("task_id");
    const today = formatDate(new Date());
    const ownedImages = srcImages.length > 0
      ? await dupSharedImages({ openid: myOpenid(req), staffId: "", paths: srcImages, targetBizId: newTaskId, biz: "tasks", date: today })
      : [];

    await db.from("tasks").insert({
      task_id: newTaskId,
      title: src.title,
      subject: src.subject,
      description: src.description,
      task_link: src.task_link,
      tags: src.tags || "[]",
      images: JSON.stringify(ownedImages),
      task_status: "todo",
      score: 0,
      deadline: src.deadline || "",
      start_date: today,
      collection_id: src.collection_id || 0,
      checkin_count: 0,
      created_by: staffId,
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    // 派发：学生复制归本人；家长/家属/管理员复制沿用源任务派发（越权过滤）
    let assigneeIds = [];
    if (manager) {
      const { data: asg } = await db.from("task_assignees").select("staff_id").eq("task_id", srcId).limit(500);
      assigneeIds = (asg || []).map(a => a.staff_id);
      const scope = myScope(req);
      if (scope !== null) assigneeIds = assigneeIds.filter(x => scope.includes(String(x)));
    }
    await syncTaskAssignees(String(staffId), req.lp.role || "student", newTaskId, assigneeIds);

    logTaskEvent({
      taskId: newTaskId, bizType: "task", eventType: "create", eventName: "复制任务",
      summary: `小程序端复制任务「${src.title}」（源自任务 ${srcId}）`, payload: { title: src.title, from_task_id: srcId }, staffId,
    });
    logEvent({ appId: req.appId, openid: myOpenid(req), eventType: "create", eventName: "复制学习任务", pagePath: "/pages/task-detail/index", bizId: String(newTaskId), extra: { from_task_id: srcId } });
    res.json(ok({ task_id: newTaskId }, "复制成功，可开始新一轮打卡"));
  } catch (e) {
    console.error("[lp] task copy error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 编辑任务（仅本人创建） ====================
router.post("/tasks/update", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const manager = isManager(req);
    const b = req.body || {};
    const id = Number(b.id);
    if (!id) return res.json(fail("缺少任务 ID"));

    let old = null;
    if (manager) {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", id).limit(1);
      if (error) throw error;
      old = rows && rows[0];
      if (old && !await taskInScope(req, old)) return res.json(fail("无权编辑该任务", 403));
    } else {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", id).eq("created_by", staffId).limit(1);
      if (error) throw error;
      old = rows && rows[0];
    }
    if (!old) return res.json(fail("无权编辑该任务", 403));
    // 兜底风控：已完成任务仅可查看，学生禁止修改（家长/家属/管理员不受限）
    if (!manager && old.task_status === "done") return res.json(fail("任务已完成，仅可查看，禁止修改"));

    const values = { updated_at: nowSql() };
    if (b.title !== undefined) values.title = String(b.title).trim().slice(0, 100);
    if (b.subject !== undefined) values.subject = String(b.subject).slice(0, 32);
    if (b.description !== undefined) values.description = String(b.description).slice(0, 500);
    if (b.task_link !== undefined) values.task_link = String(b.task_link).slice(0, 500);
    if (b.tags !== undefined) values.tags = JSON.stringify(Array.isArray(b.tags) ? b.tags.slice(0, 20) : []);
    if (b.images !== undefined) values.images = JSON.stringify(Array.isArray(b.images) ? b.images.slice(0, 9) : []);
    if (b.deadline !== undefined) values.deadline = String(b.deadline).slice(0, 10);
    if (b.start_date !== undefined) values.start_date = String(b.start_date).slice(0, 10);
    if (b.collection_id !== undefined) values.collection_id = Number(b.collection_id) || 0;

    if (manager) {
      await db.from("tasks").update(values).eq("task_id", id);
    } else {
      await db.from("tasks").update(values).eq("task_id", id).eq("created_by", staffId);
    }

    // 家长/家属/管理员可重新指定派发人员（越权过滤）
    if (manager && Array.isArray(b.assignee_ids)) {
      let assigneeIds = b.assignee_ids.map(x => String(x)).filter(Boolean);
      const scope = myScope(req);
      if (scope !== null) assigneeIds = assigneeIds.filter(x => scope.includes(x));
      await syncTaskAssignees(String(staffId), "admin", id, assigneeIds);
    }

    // 图片差异清理：移除已删除图片（物理删 COS + 登记）
    if (b.images !== undefined) {
      const newPaths = parseImgList(b.images);
      const oldPaths = parseImgList(old.images);
      const removed = oldPaths.filter(p => !newPaths.includes(p));
      if (removed.length > 0) {
        try {
          const { deleted } = await removeFiles(removed);
          if (deleted.length > 0) await db.from("file_uploads").delete().in("file_path", deleted);
        } catch (_) {}
      }
      if (newPaths.length > 0) await bindBizId({ openid: myOpenid(req), paths: newPaths, bizId: id });
    }

    logTaskEvent({
      taskId: id, bizType: "task", eventType: "update", eventName: "更新任务",
      summary: `小程序端更新任务「${values.title || old.title}」`, payload: { changed: true }, staffId,
    });
    res.json(ok(null, "更新成功"));
  } catch (e) {
    console.error("[lp] task update error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 任务状态流转（未开始→进行中→已完成） ====================
router.post("/tasks/status", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { id, status, score } = req.body || {};
    const tid = Number(id);
    if (!tid) return res.json(fail("缺少任务 ID"));
    const st = String(status || "");
    if (!["todo", "doing", "done"].includes(st)) return res.json(fail("无效的任务状态"));

    let old = null;
    if (isManager(req)) {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", tid).limit(1);
      if (error) throw error;
      old = rows && rows[0];
      if (old && !await taskInScope(req, old)) return res.json(fail("无权操作该任务", 403));
    } else {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", tid).eq("created_by", staffId).limit(1);
      if (error) throw error;
      old = rows && rows[0];
    }
    if (!old) return res.json(fail("无权操作该任务", 403));
    // 兜底风控：已完成任务仅可查看，学生禁止改状态（家长/家属/管理员不受限）
    if (!isManager(req) && old.task_status === "done") return res.json(fail("任务已完成，仅可查看，禁止修改"));

    const values = { task_status: st, updated_at: nowSql() };
    if (st === "done") {
      // 完成任务：评分固定取当前或前端提交（0-10），打卡次数 ≥1 才允许完成
      if ((old.checkin_count || 0) < 1) return res.json(fail("至少打卡一次后才能完成任务"));
      const s = Number(score);
      values.score = Number.isFinite(s) && s >= 0 && s <= 10 ? s : (old.score || 0);
    }
    if (isManager(req)) {
      await db.from("tasks").update(values).eq("task_id", tid);
    } else {
      await db.from("tasks").update(values).eq("task_id", tid).eq("created_by", staffId);
    }

    logTaskEvent({
      taskId: tid, bizType: "task", eventType: st === "done" ? "done" : "update",
      eventName: st === "done" ? "完成任务" : `任务状态：${st}`,
      summary: st === "done" ? `小程序端完成任务「${old.title}」` : `小程序端更新任务「${old.title}」状态`,
      payload: { task_status: st, score: values.score || 0 }, staffId,
    });
    res.json(ok(null, "已更新"));
  } catch (e) {
    console.error("[lp] task status error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 删除任务（仅本人创建，级联清理） ====================
router.post("/tasks/delete", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { id } = req.body || {};
    const tid = Number(id);
    if (!tid) return res.json(fail("缺少任务 ID"));

    let record = null;
    if (isManager(req)) {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", tid).limit(1);
      if (error) throw error;
      record = rows && rows[0];
      if (record && !await taskInScope(req, record)) return res.json(fail("无权删除该任务", 403));
    } else {
      const { data: rows, error } = await db.from("tasks").select().eq("task_id", tid).eq("created_by", staffId).limit(1);
      if (error) throw error;
      record = rows && rows[0];
    }
    if (!record) return res.json(fail("无权删除该任务", 403));
    // 兜底风控：已完成任务仅可查看，学生禁止删除（家长/家属/管理员不受限）
    if (!isManager(req) && record.task_status === "done") return res.json(fail("任务已完成，仅可查看，禁止删除"));

    // 级联清理：任务附件图 + 打卡图 + 打卡记录 + 派发关联
    try {
      const { data: checkins } = await db.from("task_checkins")
        .select("checkin_id, checkin_images").eq("task_id", tid).limit(10000);
      const checkinList = checkins || [];
      const paths = [...parseImgList(record.images)];
      checkinList.forEach(c => paths.push(...parseImgList(c.checkin_images)));
      const { deleted } = await removeFiles(paths);
      if (deleted.length > 0) {
        try { await db.from("file_uploads").delete().in("file_path", deleted); } catch (_) {}
      }
      if (checkinList.length > 0) await db.from("task_checkins").delete().eq("task_id", tid);
      try { await db.from("task_assignees").delete().eq("task_id", tid); } catch (_) {}
    } catch (e2) {
      console.error("[lp] task cascade delete error", e2);
    }

    if (isManager(req)) {
      await db.from("tasks").delete().eq("task_id", tid);
    } else {
      await db.from("tasks").delete().eq("task_id", tid).eq("created_by", staffId);
    }
    logTaskEvent({
      taskId: tid, bizType: "task", eventType: "delete", eventName: "删除任务",
      summary: `小程序端删除任务「${record.title}」`, payload: { title: record.title }, staffId,
    });
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[lp] task delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 打卡记录（视角学生本人） ====================
router.get("/checkins", async (req, res) => {
  try {
    const staffId = Number(await viewStaffId(req));
    const { taskId, date } = req.query;
    let q = db.from("task_checkins").select().eq("created_by", staffId);
    if (taskId) q = q.eq("task_id", Number(taskId));
    if (date) q = q.eq("checkin_date", String(date).slice(0, 10));
    const { data: rows, error } = await q.order("checkin_date", { ascending: false }).limit(200);
    if (error) throw error;

    const taskIds = [...new Set((rows || []).map(r => r.task_id).filter(Boolean))];
    const taskMap = {};
    if (taskIds.length > 0) {
      const { data: tasks } = await db.from("tasks")
        .select("task_id, title, task_status").in("task_id", taskIds).limit(taskIds.length);
      (tasks || []).forEach(t => { taskMap[t.task_id] = t; });
    }
    res.json(ok({
      list: (rows || []).map(c => ({
        checkin_id: c.checkin_id,
        task_id: c.task_id,
        task_title: (taskMap[c.task_id] || {}).title || "(任务已删除)",
        checkin_date: c.checkin_date,
        checkin_note: c.checkin_note,
        images: parseImgList(c.checkin_images),
        created_at: c.created_at,
      })),
    }));
  } catch (e) {
    console.error("[lp] checkins list error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 打卡（任务必须可见，created_by=本人） ====================
router.post("/checkins/create", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { taskId, date, note, images } = req.body || {};
    const tid = Number(taskId);
    if (!tid) return res.json(fail("缺少任务 ID"));

    const ids = await myTaskIds(String(staffId));
    if (!ids.includes(tid)) return res.json(fail("无权操作该任务", 403));

    const { data: rows, error } = await db.from("tasks")
      .select("task_id, title, task_status, checkin_count").eq("task_id", tid).limit(1);
    if (error) throw error;
    const task = rows && rows[0];
    if (!task) return res.json(fail("任务不存在"));
    // 兜底风控：已完成任务仅可查看，学生禁止打卡（管理员不受限）
    if (!isAdmin(req) && task.task_status === "done") return res.json(fail("任务已完成，不能打卡"));

    const checkinDate = date || formatDate(new Date());
    const imgList = (Array.isArray(images) ? images : []).slice(0, 9);
    const checkinId = await nextSeq("task_checkin_id");
    const { error: insErr } = await db.from("task_checkins").insert({
      checkin_id: checkinId,
      task_id: tid,
      checkin_date: String(checkinDate).slice(0, 10),
      checkin_note: String(note || "").slice(0, 500),
      checkin_images: JSON.stringify(imgList),
      created_by: staffId,
      review_status: "pending",
      created_at: nowSql(),
    });
    if (insErr) throw insErr;

    if (imgList.length > 0) await bindBizId({ openid: myOpenid(req), paths: imgList, bizId: tid });

    const taskValues = { checkin_count: (task.checkin_count || 0) + 1, updated_at: nowSql() };
    if (task.task_status === "todo") taskValues.task_status = "doing";
    await db.from("tasks").update(taskValues).eq("task_id", tid);

    logTaskEvent({
      taskId: tid, checkinId, bizType: "task_checkin", eventType: "checkin", eventName: "任务打卡",
      summary: `小程序端对任务「${task.title}」打卡（第 ${(task.checkin_count || 0) + 1} 次，待审核）`,
      payload: { task_title: task.title, checkin_date: checkinDate, note: note || "", images: imgList, review_status: "pending" },
      staffId,
    });
    logEvent({ appId: req.appId, openid: myOpenid(req), eventType: "create", eventName: "学习打卡", pagePath: "/pages/task-detail/index", bizId: String(tid) });
    res.json(ok({ checkin_id: checkinId }, "打卡成功，等待老师审核"));
  } catch (e) {
    console.error("[lp] checkin create error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 删除打卡（本人；任务已完成禁止删） ====================
router.post("/checkins/delete", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { id } = req.body || {};
    const cid = Number(id);
    if (!cid) return res.json(fail("缺少打卡 ID"));

    const { data: rows, error } = await db.from("task_checkins")
      .select().eq("checkin_id", cid).eq("created_by", staffId).limit(1);
    if (error) throw error;
    const rec = rows && rows[0];
    if (!rec) return res.json(fail("打卡记录不存在"));
    if (!isAdmin(req) && await isTaskDone(rec.task_id)) return res.json(fail("任务已完成，仅可查看，禁止删除打卡"));

    await db.from("task_checkins").delete().eq("checkin_id", cid).eq("created_by", staffId);
    const { data: tRows } = await db.from("tasks")
      .select("checkin_count").eq("task_id", rec.task_id).limit(1);
    if (tRows && tRows[0]) {
      const cnt = Math.max(0, (tRows[0].checkin_count || 0) - 1);
      await db.from("tasks").update({ checkin_count: cnt, updated_at: nowSql() }).eq("task_id", rec.task_id);
    }
    logTaskEvent({
      taskId: rec.task_id, checkinId: cid, bizType: "task_checkin", eventType: "checkin_delete",
      eventName: "删除打卡", summary: `小程序端删除打卡记录（${rec.checkin_date || ""}）`,
      payload: { checkin_date: rec.checkin_date }, staffId,
    });
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[lp] checkin delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 待办（角色差异化：信息筛选 + 快速处理） ====================
// Student：只展示「还没打卡处理」的任务（无待审核/已通过打卡）
// Parent/Family/Admin：本家庭范围内待审核打卡列表（学生提交打卡后进入）
router.get("/todos", async (req, res) => {
  try {
    if (isManager(req)) return await managerTodos(req, res);
    return await studentTodos(req, res);
  } catch (e) {
    console.error("[lp] todos error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 学生待办：派发给我/我创建，未完成且该学生无待审核/已通过打卡的任务 */
async function studentTodos(req, res) {
  const staffId = Number(me(req));
  const ids = await myTaskIds(String(staffId));
  let list = [];
  if (ids.length > 0) {
    const { data: rows, error } = await db.from("tasks")
      .select().in("task_id", ids).order("updated_at", { ascending: false }).limit(200);
    if (error) throw error;
    let all = rows || [];
    // 已提交过（待审核或已通过）的任务视为已处理，不再出现在待办
    const taskIds = all.map(t => t.task_id);
    if (taskIds.length > 0) {
      const { data: mine } = await db.from("task_checkins")
        .select("task_id")
        .eq("created_by", staffId)
        .in("task_id", taskIds)
        .in("review_status", ["pending", "approved"])
        .limit(5000);
      const handled = new Set((mine || []).map(c => String(c.task_id)));
      all = all.filter(t => t.task_status !== "done" && !handled.has(String(t.task_id)));
    }
    if (all.length > 0) {
      const [withCol, withAsg] = await Promise.all([attachCollectionName(all), attachAssignees(all)]);
      list = all.map((t, i) => ({ ...t, ...(withCol[i] || {}), ...(withAsg[i] || {}) }));
    }
  }
  res.json(ok({
    type: "student",
    count: list.length,
    list: list.map(t => ({
      task_id: t.task_id,
      title: t.title,
      subject: t.subject,
      task_status: t.task_status,
      deadline: t.deadline,
      checkin_count: t.checkin_count || 0,
      collection_name: t.collection_name || "",
      created_at: t.created_at,
    })),
  }));
}

/** 家长/家属/管理员待办：本家庭范围内待审核打卡（含学生/任务/提交内容） */
async function managerTodos(req, res) {
  const scope = myScope(req);
  // 空 scope（家长/家属名下无孩子）：直接返回空列表，避免空数组 in() 报错
  if (scope !== null && scope.length === 0) return res.json(ok({ type: "admin", count: 0, list: [] }));
  let q = db.from("task_checkins").select().eq("review_status", "pending");
  if (scope !== null) q = q.in("created_by", scope);
  const { data: rows, error } = await q.order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  const list0 = rows || [];
  const taskIds = [...new Set(list0.map(c => Number(c.task_id)).filter(Boolean))];
  const staffIds = [...new Set(list0.map(c => Number(c.created_by)).filter(Boolean))];
  const [tasksR, staffMap] = await Promise.all([
    taskIds.length > 0
      ? db.from("tasks").select("task_id, title, task_status").in("task_id", taskIds).limit(taskIds.length)
      : Promise.resolve({ data: [], error: null }),
    cachedStaffRows(staffIds),
  ]);
  const taskMap = {};
  (tasksR.data || []).forEach(t => { taskMap[Number(t.task_id)] = t; });
  const list = list0
    .filter(c => taskMap[Number(c.task_id)]) // 任务已删除的打卡不展示
    .map(c => {
      const s = staffMap[String(c.created_by)] || {};
      return {
        checkin_id: c.checkin_id,
        task_id: c.task_id,
        task_title: (taskMap[Number(c.task_id)] || {}).title || "(任务已删除)",
        task_status: (taskMap[Number(c.task_id)] || {}).task_status || "",
        student: {
          staff_id: String(c.created_by),
          nickname: s.staff_nickname || s.staff_username || "学生",
          username: s.staff_username || "",
        },
        checkin_date: c.checkin_date,
        checkin_note: c.checkin_note,
        images: parseImgList(c.checkin_images),
        created_at: c.created_at,
      };
    });
  res.json(ok({ type: "admin", count: list.length, list }));
}

// ==================== 管理员审核打卡 ====================
// approve：审核通过 = 任务完成 + 评分 10 分；同任务其余待审核打卡自动关闭（任务从待办移除）
// reject：可填评分与审核说明，任务退回学生继续处理
// 审核完成后通过订阅消息给打卡提交人发送「审核结果通知」（失败不影响审核主流程）
async function notifyReviewResult(req, checkin, task, result, note) {
  try {
    const { data: stuRows } = await db.from("lp_students")
      .select("openid")
      .eq("staff_id", checkin.created_by)
      .eq("app_id", req.appId || "learning-planet")
      .limit(1);
    await sendReviewNotification({
      appId: req.appId || "learning-planet",
      openid: (stuRows && stuRows[0] && stuRows[0].openid) || "",
      staffId: checkin.created_by,
      checkinId: checkin.checkin_id,
      taskId: checkin.task_id,
      taskTitle: (task && task.title) || "",
      result,
      note,
    });
  } catch (e) {
    console.error("[lp] notify review error", e);
  }
}

router.post("/todos/review", async (req, res) => {
  try {
    if (!isManager(req)) return res.json(fail("无权操作", 403));
    const staffId = Number(me(req));
    const { checkinId, action, score, note } = req.body || {};
    const cid = Number(checkinId);
    if (!cid) return res.json(fail("缺少打卡 ID"));
    const act = String(action || "");
    if (!["approve", "reject"].includes(act)) return res.json(fail("无效的审核操作"));

    const { data: rows, error } = await db.from("task_checkins")
      .select().eq("checkin_id", cid).limit(1);
    if (error) throw error;
    const checkin = rows && rows[0];
    if (!checkin) return res.json(fail("打卡记录不存在"));
    // 家长/家属仅可审核本家庭孩子的打卡（admin 不受限）
    const scope = myScope(req);
    if (scope !== null && !scope.includes(String(checkin.created_by))) {
      return res.json(fail("无权审核该打卡", 403));
    }
    if (checkin.review_status === "approved") return res.json(fail("该打卡已审核通过"));
    if (checkin.review_status === "rejected") return res.json(fail("该打卡已审核驳回"));

    const { data: tRows } = await db.from("tasks")
      .select("task_id, title, task_status").eq("task_id", checkin.task_id).limit(1);
    const task = tRows && tRows[0];

    if (act === "approve") {
      // 审核通过 = 任务完成 + 自动获得 10 分
      await db.from("task_checkins").update({
        review_status: "approved",
        review_score: 10,
        review_note: "",
        reviewer: staffId,
        reviewed_at: nowSql(),
      }).eq("checkin_id", cid);
      if (task) {
        await db.from("tasks").update({ task_status: "done", score: 10, updated_at: nowSql() })
          .eq("task_id", task.task_id);
      }
      // 同任务其余待审核打卡自动关闭（该任务已从待办列表移除）
      const { data: pendRows } = await db.from("task_checkins")
        .select("checkin_id").eq("task_id", checkin.task_id).eq("review_status", "pending").limit(200);
      const pendIds = (pendRows || []).map(p => p.checkin_id).filter(id => Number(id) !== Number(cid));
      if (pendIds.length > 0) {
        await db.from("task_checkins").update({
          review_status: "rejected",
          review_note: "该任务已审核通过，本条打卡不再处理",
          reviewer: staffId,
          reviewed_at: nowSql(),
        }).in("checkin_id", pendIds);
      }
      logTaskEvent({
        taskId: checkin.task_id, checkinId: cid, bizType: "task_checkin", eventType: "review_approve",
        eventName: "审核通过",
        summary: `管理员审核通过打卡，任务「${task ? task.title : ""}」完成并得 10 分`,
        payload: { checkin_id: cid, task_status: "done", score: 10, closed_pending: pendIds.length },
        staffId,
      });
      notifyReviewResult(req, checkin, task, "approve", "").catch(() => {});
      res.json(ok(null, "已通过，任务完成 +10 分"));
    } else {
      let s = Number(score);
      if (!Number.isFinite(s)) s = 0;
      s = Math.max(0, Math.min(10, Math.floor(s)));
      await db.from("task_checkins").update({
        review_status: "rejected",
        review_score: s,
        review_note: String(note || "").slice(0, 500),
        reviewer: staffId,
        reviewed_at: nowSql(),
      }).eq("checkin_id", cid);
      if (task && task.task_status === "done") {
        // 兜底：已完成任务若仍有待审核打卡，驳回时回退为进行中
        await db.from("tasks").update({ task_status: "doing", updated_at: nowSql() })
          .eq("task_id", task.task_id);
      }
      logTaskEvent({
        taskId: checkin.task_id, checkinId: cid, bizType: "task_checkin", eventType: "review_reject",
        eventName: "审核驳回",
        summary: `管理员驳回打卡「${task ? task.title : ""}」`,
        payload: { checkin_id: cid, score: s, note: String(note || "") },
        staffId,
      });
      notifyReviewResult(req, checkin, task, "reject", note).catch(() => {});
      res.json(ok(null, "已驳回"));
    }
  } catch (e) {
    console.error("[lp] todos review error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 订阅消息（第一阶段：用户主动订阅 + 次数/状态管理） ====================
// 数据表：t_lp_subscribe_grants；模板ID配置：t_apps.subscribe_tmpl_ids（后台「小程序配置」维护）
// 数据流：用户点「增加订阅次数」→ wx.requestSubscribeMessage 授权 → 前端上报 grant →
//         记录授权次数 → 后续发送消息时逐次消耗（第二阶段）
router.get("/subscribe/status", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const cfg = await getAppConfig(req.appId || "learning-planet");
    const tmplIds = String((cfg && cfg.subscribe_tmpl_ids) || "")
      .split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
    const tmplNames = {
      "91HSfOQSSVKHPwT2oNM4NdGuKe9Gw1uY0VkLf_nyJ9I": "审核结果通知",
      "aIReeE_R92te__wWL7EKRknaZ0pXhSJ2Kcct_rNWzVg": "打卡提醒",
    };
    const tmplList = tmplIds.map(id => ({ id, name: tmplNames[id] || "订阅消息" }));
    const { data: rows } = await db.from("subscribe_grants")
      .select().eq("staff_id", staffId).order("created_at", { ascending: false }).limit(500);
    const grants = rows || [];
    let total = 0, used = 0;
    grants.forEach(g => { total += Number(g.grant_count) || 0; used += Number(g.used_count) || 0; });
    res.json(ok({
      total,
      used,
      available: Math.max(0, total - used),
      has_tmpl: tmplIds.length > 0,
      tmpl_ids: tmplIds,
      tmpl_count: tmplIds.length,
      tmpl_list: tmplList,
      grants: grants.slice(0, 20).map(g => ({
        grant_id: g.grant_id,
        tmpl_id: g.tmpl_id,
        tmpl_name: (g.tmpl_id && tmplNames[g.tmpl_id]) || "",
        grant_count: g.grant_count,
        used_count: g.used_count,
        grant_status: g.grant_status,
        source: g.source,
        created_at: g.created_at,
      })),
    }));
  } catch (e) {
    console.error("[lp] subscribe status error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 授权限流：同一用户 60s 内最多记录 5 次（防刷） */
const GRANT_WINDOW = new Map();
function grantAllowed(openid, max = 5, windowMs = 60 * 1000) {
  const now = Date.now();
  const rec = GRANT_WINDOW.get(openid);
  if (!rec || now - rec.start >= windowMs) return true;
  return rec.count < max;
}
function recordGrant(openid) {
  const now = Date.now();
  const rec = GRANT_WINDOW.get(openid);
  if (!rec || now - rec.start >= 60 * 1000) GRANT_WINDOW.set(openid, { start: now, count: 1 });
  else rec.count += 1;
}

router.post("/subscribe/grant", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const openid = myOpenid(req);
    const b = req.body || {};
    const tmplIds = (Array.isArray(b.tmplIds) ? b.tmplIds : [])
      .map(s => String(s).trim().slice(0, 64)).filter(Boolean).slice(0, 20);
    const grantCount = Number(b.grantCount);
    if (!Number.isFinite(grantCount) || grantCount < 1 || grantCount > 10) {
      return res.json(fail("无效的授权次数"));
    }
    if (!grantAllowed(openid)) return res.json(fail("操作过于频繁，请稍后再试", 429));
    recordGrant(openid);

    const list = tmplIds.length > 0 ? tmplIds : [""];
    const inserted = [];
    for (const tmpl of list) {
      const gid = await nextSeq("subscribe_grant_id");
      await db.from("subscribe_grants").insert({
        grant_id: gid,
        staff_id: staffId,
        openid,
        app_id: req.appId || "learning-planet",
        tmpl_id: tmpl,
        grant_count: grantCount,
        used_count: 0,
        grant_status: "active",
        source: "mini",
        remark: String(b.remark || "").slice(0, 255),
        created_at: nowSql(),
        updated_at: nowSql(),
      });
      inserted.push(gid);
    }
    logEvent({
      appId: req.appId, openid, eventType: "subscribe", eventName: "订阅消息授权",
      pagePath: "/pages/subscribe/subscribe", bizId: String(inserted[0] || 0),
      extra: { tmpl_count: tmplIds.length, grant_count: grantCount },
    });
    res.json(ok({ grant_ids: inserted }, "订阅成功"));
  } catch (e) {
    console.error("[lp] subscribe grant error", e);
    res.json(fail("服务异常", 500));
  }
});


// ==================== 合集（查询任意登录用户；创建/编辑/删除仅管理员） ====================
router.get("/collections", async (req, res) => {
  try {
    const { data: rows, error } = await db.from("task_collections")
      .select().eq("collection_status", 1).order("collection_id", { ascending: true }).limit(200);
    if (error) throw error;
    const list0 = rows || [];
    if (list0.length === 0) return res.json(ok({ list: [] }));
    const [withStaff, withCnt] = await Promise.all([attachStaffInfo(list0), attachCollectionCount(list0)]);
    const list = list0.map((c, i) => ({ ...c, ...(withStaff[i] || {}), ...(withCnt[i] || {}) }));
    res.json(ok({
      list: list.map(c => ({
        collection_id: c.collection_id,
        name: c.name,
        description: c.description,
        cover_images: parseImgList(c.cover_images),
        task_count: c.task_count || 0,
        created_by: c.created_by,
        _creatorNickname: c._creatorNickname || "",
      })),
    }));
  } catch (e) {
    console.error("[lp] collections list error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collections/create", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.json(fail("无权操作", 403));
    const staffId = Number(me(req));
    const { name, description, cover_images } = req.body || {};
    const n = String(name || "").trim().slice(0, 100);
    if (!n) return res.json(fail("合集名称不能为空"));
    const collectionId = await nextSeq("collection_id");
    await db.from("task_collections").insert({
      collection_id: collectionId,
      name: n,
      description: String(description || "").slice(0, 500),
      cover_images: JSON.stringify(Array.isArray(cover_images) ? cover_images.slice(0, 1) : []),
      task_count: 0,
      created_by: staffId,
      collection_status: 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    invalidateCollectionRows([collectionId]);
    res.json(ok({ collection_id: collectionId }, "创建成功"));
  } catch (e) {
    console.error("[lp] collection create error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collections/update", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.json(fail("无权操作", 403));
    const staffId = Number(me(req));
    const b = req.body || {};
    const id = Number(b.id);
    if (!id) return res.json(fail("缺少合集 ID"));
    const { data: rows } = await db.from("task_collections")
      .select().eq("collection_id", id).eq("created_by", staffId).limit(1);
    if (!(rows && rows[0])) return res.json(fail("无权编辑该合集", 403));
    const values = { updated_at: nowSql() };
    if (b.name !== undefined) values.name = String(b.name).trim().slice(0, 100);
    if (b.description !== undefined) values.description = String(b.description).slice(0, 500);
    if (b.cover_images !== undefined) values.cover_images = JSON.stringify(Array.isArray(b.cover_images) ? b.cover_images.slice(0, 1) : []);
    await db.from("task_collections").update(values).eq("collection_id", id).eq("created_by", staffId);
    invalidateCollectionRows([id]);
    res.json(ok(null, "更新成功"));
  } catch (e) {
    console.error("[lp] collection update error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collections/delete", async (req, res) => {
  try {
    if (!isAdmin(req)) return res.json(fail("无权操作", 403));
    const staffId = Number(me(req));
    const { id } = req.body || {};
    const cid = Number(id);
    if (!cid) return res.json(fail("缺少合集 ID"));
    const { data: rows } = await db.from("task_collections")
      .select().eq("collection_id", cid).eq("created_by", staffId).limit(1);
    if (!(rows && rows[0])) return res.json(fail("无权删除该合集", 403));
    await db.from("tasks").update({ collection_id: 0, updated_at: nowSql() }).eq("collection_id", cid);
    await db.from("task_collections").delete().eq("collection_id", cid).eq("created_by", staffId);
    invalidateCollectionRows([cid]);
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[lp] collection delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 批量图片上传（base64 JSON，无云存储的小程序） ====================
// 受限并发上传：容器仅 0.25核/512MB，逐张串行延迟大，全并发又易 OOM，取折中并发上限 3
router.post("/upload", async (req, res) => {
  try {
    const { biz, files } = req.body || {};
    const bizName = String(biz || "tasks").slice(0, 32);
    if (!Array.isArray(files) || files.length === 0) return res.json(fail("缺少图片文件"));
    if (files.length > 9) return res.json(fail("单次最多上传 9 张"));

    const pool = async (items, worker, limit) => {
      const out = new Array(items.length);
      let idx = 0;
      const run = async () => {
        while (idx < items.length) {
          const i = idx++;
          out[i] = await worker(items[i]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
      return out;
    };

    const uploaded = await pool(files.slice(0, 9), async (f) => {
      let b64 = String(f.data || "");
      let contentType = String(f.contentType || "image/jpeg");
      const mimeMatch = b64.match(/^data:([^;]+);base64,(.*)$/s);
      if (mimeMatch) {
        contentType = mimeMatch[1] || contentType;
        b64 = mimeMatch[2];
      }
      if (/image\/png/i.test(contentType)) contentType = "image/png";
      else if (/image\/webp/i.test(contentType)) contentType = "image/webp";
      else contentType = "image/jpeg";

      const buffer = Buffer.from(b64, "base64");
      const fileObj = await uploadImage({ biz: bizName, buffer, contentType, fileName: String(f.fileName || "") });
      await logUpload({ openid: myOpenid(req), biz: bizName, file: fileObj, staffId: "" });
      return { path: fileObj.path, url: fileObj.url };
    }, 3);

    const results = uploaded.filter(Boolean);
    res.json(ok({ files: results }, `已上传 ${results.length} 张`));
  } catch (e) {
    console.error("[lp] upload error", e);
    res.json(fail(e.message || "上传失败", 500));
  }
});

// ==================== 学习仪表盘（小程序端；管理员=视角学生） ====================
router.get("/dashboard", async (req, res) => {
  try {
    const staffId = Number(await viewStaffId(req));
    const ids = await myTaskIds(String(staffId));

    const taskQ = ids.length > 0 ? db.from("tasks").select().in("task_id", ids).limit(2000) : Promise.resolve({ data: [], error: null });
    const checkinQ = ids.length > 0 ? db.from("task_checkins").select().in("task_id", ids).limit(2000) : Promise.resolve({ data: [], error: null });
    const recentQ = ids.length > 0 ? db.from("task_checkins").select().order("created_at", { ascending: false }).in("task_id", ids).limit(100) : Promise.resolve({ data: [], error: null });
    const subjectItemsQ = cachedDictItems("subject");

    const [tasksR, checkinsR, recentR, subjectItems] = await Promise.all([taskQ, checkinQ, recentQ, subjectItemsQ]);
    if (tasksR.error) throw tasksR.error;
    if (checkinsR.error) throw checkinsR.error;
    if (recentR.error) throw recentR.error;

    const tasks = tasksR.data || [];
    const allCheckins = checkinsR.data || [];
    const recentCheckins = recentR.data || [];
    const liveTaskIds = new Set(tasks.map(t => String(t.task_id)));
    const checkins = allCheckins.filter(c => liveTaskIds.has(String(c.task_id)));

    // 基础统计
    const totalTasks = tasks.length;
    const todoCount = tasks.filter(t => t.task_status === "todo").length;
    const doingCount = tasks.filter(t => t.task_status === "doing").length;
    const doneCount = tasks.filter(t => t.task_status === "done").length;
    const totalCheckins = checkins.length;
    const today = formatDate(new Date());
    const todayCheckins = checkins.filter(c => String(c.checkin_date || "").slice(0, 10) === today).length;
    const todayCheckedIn = todayCheckins > 0;
    const completionRate = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

    // 游戏化
    const xp = totalCheckins * 10 + doneCount * 30;
    const level = levelFromXp(xp);
    const checkinDates = new Set(checkins.map(c => String(c.checkin_date || "").slice(0, 10)).filter(Boolean));
    const todayStreak = streakEndingAt(checkinDates, new Date());
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStreak = streakEndingAt(checkinDates, yesterday);
    const currentStreak = Math.max(todayStreak, yesterdayStreak);
    const maxStreak = maxStreakOf(checkinDates);

    // 近 7 天趋势
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const day = formatDate(d);
      days.push({ date: day.slice(5), value: checkins.filter(c => String(c.checkin_date || "").slice(0, 10) === day).length });
    }

    // 科目分布 / 状态分布 / 排行
    const subjectMap = {};
    tasks.forEach(t => { const s = String(t.subject || "").trim() || "未分类"; subjectMap[s] = (subjectMap[s] || 0) + 1; });
    const subjectDist = Object.entries(subjectMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);
    const statusDist = [
      { name: "未开始", value: todoCount, color: "#bfbfbf" },
      { name: "进行中", value: doingCount, color: "#1677ff" },
      { name: "已完成", value: doneCount, color: "#52c41a" },
    ].filter(x => x.value > 0);
    const taskRank = [...tasks].map(t => ({ title: t.title, value: t.checkin_count || 0 })).sort((a, b) => b.value - a.value).slice(0, 8);

    // 逾期 / 临期
    const todayMs = new Date(`${today}T00:00:00`).getTime();
    const soonMs = todayMs + 3 * 86400000;
    let overdueCount = 0, dueSoonCount = 0;
    tasks.forEach(t => {
      if (t.task_status === "done") return;
      const dl = String(t.deadline || "").slice(0, 10);
      if (!dl) return;
      const dlMs = new Date(`${dl}T00:00:00`).getTime();
      if (!Number.isFinite(dlMs)) return;
      if (dlMs < todayMs) overdueCount += 1;
      else if (dlMs <= soonMs) dueSoonCount += 1;
    });

    // 徽章
    const distinctActiveDays = checkinDates.size;
    const dailyCountMap = {};
    checkins.forEach(c => { const day = String(c.checkin_date || "").slice(0, 10); if (day) dailyCountMap[day] = (dailyCountMap[day] || 0) + 1; });
    const maxDailyCheckins = Math.max(0, ...Object.values(dailyCountMap));
    const collectionCount = new Set(tasks.map(t => t.collection_id).filter(v => v && Number(v) !== 0)).size;
    const subjectTotal = (subjectItems && subjectItems.length) || Math.max(subjectDist.length, 1);

    const badges = [
      { key: "first_checkin", name: "初来乍到", desc: "完成首次打卡", icon: "🎯", unlocked: totalCheckins >= 1, progress: Math.min(1, totalCheckins) },
      { key: "checkin_10", name: "打卡十杰", desc: "累计打卡 10 次", icon: "⭐", unlocked: totalCheckins >= 10, progress: Math.min(1, totalCheckins / 10) },
      { key: "checkin_50", name: "打卡达人", desc: "累计打卡 50 次", icon: "💯", unlocked: totalCheckins >= 50, progress: Math.min(1, totalCheckins / 50) },
      { key: "checkin_100", name: "打卡之王", desc: "累计打卡 100 次", icon: "👑", unlocked: totalCheckins >= 100, progress: Math.min(1, totalCheckins / 100) },
      { key: "streak_3", name: "持之以恒", desc: "连续打卡 3 天", icon: "🔥", unlocked: maxStreak >= 3, progress: Math.min(1, maxStreak / 3) },
      { key: "streak_7", name: "一周热力", desc: "连续打卡 7 天", icon: "💪", unlocked: maxStreak >= 7, progress: Math.min(1, maxStreak / 7) },
      { key: "streak_14", name: "双周坚持", desc: "连续打卡 14 天", icon: "🏆", unlocked: maxStreak >= 14, progress: Math.min(1, maxStreak / 14) },
      { key: "task_done_1", name: "旗开得胜", desc: "完成第 1 个任务", icon: "✅", unlocked: doneCount >= 1, progress: Math.min(1, doneCount) },
      { key: "task_done_5", name: "任务能手", desc: "完成 5 个任务", icon: "🚀", unlocked: doneCount >= 5, progress: Math.min(1, doneCount / 5) },
      { key: "task_done_10", name: "任务大师", desc: "完成 10 个任务", icon: "🎓", unlocked: doneCount >= 10, progress: Math.min(1, doneCount / 10) },
      { key: "task_create_5", name: "筑梦起航", desc: "创建 5 个任务", icon: "🏗️", unlocked: totalTasks >= 5, progress: Math.min(1, totalTasks / 5) },
      { key: "all_task_done", name: "全任务达成", desc: "所有任务全部完成", icon: "🏁", unlocked: totalTasks > 0 && doneCount >= totalTasks, progress: totalTasks > 0 ? Math.min(1, doneCount / totalTasks) : 0 },
      { key: "level_3", name: "初露锋芒", desc: "达到 Lv.3", icon: "🌱", unlocked: level.level >= 3, progress: Math.min(1, level.level / 3) },
      { key: "level_5", name: "小有名气", desc: "达到 Lv.5", icon: "🌟", unlocked: level.level >= 5, progress: Math.min(1, level.level / 5) },
      { key: "level_10", name: "巅峰学霸", desc: "达成满级 Lv.10", icon: "🏆", unlocked: level.level >= 10, progress: Math.min(1, level.level / 10) },
      { key: "subject_3", name: "博学多闻", desc: "涉猎 3 个科目", icon: "📚", unlocked: subjectDist.length >= 3, progress: Math.min(1, subjectDist.length / 3) },
      { key: "active_30", name: "学习满月", desc: "累计活跃打卡 30 天", icon: "📅", unlocked: distinctActiveDays >= 30, progress: Math.min(1, distinctActiveDays / 30) },
      { key: "day_multi_3", name: "一鸣惊人", desc: "单日打卡 3 次以上", icon: "🎇", unlocked: maxDailyCheckins >= 3, progress: Math.min(1, maxDailyCheckins / 3) },
      { key: "perfect_week", name: "全勤之星", desc: "近 7 天每天打卡", icon: "🌟", unlocked: days.length > 0 && days.every(d => d.value > 0), progress: days.length ? days.filter(d => d.value > 0).length / days.length : 0 },
      { key: "collection_3", name: "合集达人", desc: "使用 3 个任务合集", icon: "🗂️", unlocked: collectionCount >= 3, progress: Math.min(1, collectionCount / 3) },
    ];

    const reminders = buildLearningReminders({
      todayCheckedIn, todayCheckins, currentStreak, completionRate,
      doneCount, totalTasks, remainingCount: totalTasks - doneCount,
      activeCount: doingCount, overdueCount, dueSoonCount,
      nextBadge: badges.find(b => !b.unlocked) || null,
    });

    // 最近打卡（含任务标题）
    const taskTitleMap = {};
    tasks.forEach(t => { taskTitleMap[t.task_id] = t.title; });
    const recentCheckinList = recentCheckins.filter(c => liveTaskIds.has(String(c.task_id))).slice(0, 8).map(c => ({
      checkin_id: String(c.checkin_id),
      task_id: c.task_id,
      task_title: taskTitleMap[c.task_id] || "(任务已删除)",
      checkin_date: c.checkin_date,
      note: c.checkin_note,
      has_images: parseImgList(c.checkin_images).length > 0,
      created_at: c.created_at,
    }));

    res.json(ok({
      stats: { totalTasks, todoCount, doingCount, doneCount, totalCheckins, todayCheckins, todayCheckedIn, completionRate },
      level,
      streak: { current: currentStreak, max: maxStreak, todayCheckedIn },
      badges,
      days,
      subjectDist,
      statusDist,
      taskRank,
      reminders,
      recentCheckinList,
    }));
  } catch (e) {
    console.error("[lp] dashboard error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 接口链路：前端上报补全耗时 ====================
router.post("/reportTrace", async (req, res) => {
  try {
    const { requestId, clientCostMs } = req.body || {};
    if (!requestId || clientCostMs == null) return res.json(fail("缺少参数"));
    await reportTrace(requestId, clientCostMs);
    res.json(ok(null, "已记录"));
  } catch (e) {
    console.error("[lp] reportTrace error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 数据上报（session / 事件，写入共享 user_sessions / user_events） ====================
// 课小满无云服务，session/事件经 /api/lp/* 上报；身份取 LP JWT（req.lp.openid），app_id=learning-planet
router.post("/collectSession", async (req, res) => {
  try {
    const s = req.body.session || {};
    await db.from("user_sessions").insert({
      session_id: s.session_id || genId(),
      openid: myOpenid(req),
      app_id: req.appId || "learning-planet",
      brand: s.brand || "",
      model: s.model || "",
      platform: s.platform || "",
      os_version: s.system || "",
      cpu_type: s.cpu_type || "",
      wechat_version: s.wechat_version || "",
      sdk_version: s.sdk_version || "",
      renderer: s.renderer || "",
      network_type: s.network_type || "",
      env_version: s.env_version || "",
      app_version: s.app_version || "",
      launch_scene: s.launch_scene || 0,
      model_level: s.model_level || "",
      referrer_info: s.referrer_info || "",
      auth_notification: s.auth_notification ? 1 : 0,
      auth_album: s.auth_album ? 1 : 0,
      auth_camera: s.auth_camera ? 1 : 0,
      auth_location: s.auth_location ? 1 : 0,
      auth_mic: s.auth_mic ? 1 : 0,
      dark_mode: s.dark_mode ? 1 : 0,
      screen_w: s.screen_w || 0,
      screen_h: s.screen_h || 0,
      battery_level: s.battery_level != null ? Number(s.battery_level) : -1,
      is_charging: s.is_charging ? 1 : 0,
      payload: JSON.stringify(s),
    });
    res.json(ok(null, "已上报"));
  } catch (e) {
    console.error("[lp] collectSession error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collectEvent", async (req, res) => {
  try {
    const { eventType, eventName, pagePath, bizId, extra } = req.body || {};
    if (!eventType || !eventName) return res.json(fail("缺少事件参数"));
    await db.from("user_events").insert({
      event_id: genId(),
      openid: myOpenid(req),
      app_id: req.appId || "learning-planet",
      event_type: String(eventType).slice(0, 24),
      event_name: String(eventName).slice(0, 64),
      page_path: String(pagePath || "").slice(0, 128),
      biz_id: String(bizId || "").slice(0, 64),
      extra: extra ? JSON.stringify(extra) : null,
      client_at: nowSql(),
    });
    res.json(ok(null, "已记录"));
  } catch (e) {
    console.error("[lp] collectEvent error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 工具 ====================
function safeJson(str, fallback) {
  try {
    const v = JSON.parse(str || "[]");
    return Array.isArray(v) ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = router;
