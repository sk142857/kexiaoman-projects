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
const { db, countRows } = require("../db");
const { cached } = require("../cache");
const { ok, fail } = require("../response");
const { nowSql, formatDate, genId, withLock } = require("../utils");
const { nextSeq } = require("../seq");
const { uploadImage, logUpload, bindBizId, removeFiles, dupSharedImages, compressVideo, compressImageAsync, storageFileExists, VIDEO_MAX_SIZE } = require("../storage");
const { submitForAudit, mergeAudit, syncRecordRisk, rebindAudit, textCheckNow, imageCheckNow } = require("../contentSecurity");
const { logTaskEvent } = require("../taskTimeline");
const { logEvent, logSession } = require("../events");
const { getAppConfig } = require("../apps");
const { reportTrace } = require("../trace");
const { sendReviewNotification } = require("../subscribeLib");
const { notifyCheckinSubmitted, notifyReviewResult, notifyTaskAssigned, notifyTaskDone } = require("../notificationLib");
const { ensureUser } = require("../appAuth");
const { listBoundStaffs } = require("./lpAuth");
const { getParamsMap } = require("../params");
const { roleCanCancel, requestCancellation, cancelPendingCancellation, getPendingCancellation } = require("../accountLib");
const {
  parseImgList, attachAssignees, attachStaffInfo, attachCollectionName, attachCollectionCount,
  syncTaskAssignees, isTaskDone, levelFromXp, streakEndingAt, maxStreakOf, buildLearningReminders,
  invalidateCollectionRows, invalidateStaffRows, cachedDictItems, cachedStaffRows,
  CHECKIN_TYPE_ALLOWED, normalizeCheckinType,
  TASK_SOURCE_ALLOWED, TASK_SOURCE_DEFAULT, normalizeTaskSource,
  staffPoints, applyTaskStatusPoints, awardCheckinApproved, deductCheckinDeleted, deductTaskDeleted,
  taskAllRecipientsDone,
  syncBadgeUnlocks,
} = require("../learningLib");

const router = express.Router();

const me = (req) => String((req.lp && req.lp.staffId) || "");
const myOpenid = (req) => (req.lp && req.lp.openid) || "";
const isAdmin = (req) => (req.lp && req.lp.role) === "admin";
/** 可管理任务/可审核打卡的角色：平台管理员 / 主家长 / 家属（学生/个人不可） */
const isManager = (req) => ["admin", "parent", "family"].includes(req.lp && req.lp.role);
/** 个人角色：无家庭、无切换，自己发布任务自己打卡 */
const isPersonal = (req) => (req.lp && req.lp.role) === "personal";
/** 当前用户的家庭可见范围（孩子 student staff_id 数组；null=admin 全部） */
const myScope = (req) => (req.lp && req.lp.scope) || null;

/**
 * 当前用户的「家庭归属 staff_id」：合集/科目按主家长归属（staff_id）查询与管理。
 * - admin → null（全部，不过滤）
 * - parent / personal → 本人 staff_id
 * - family → 邀请他的主家长（lp_family_members.owner_staff_id）
 * - student → 其主家长（lp_children.parent_staff_id）
 * 查不到归属关系时回退本人，保证查询不空转。
 */
async function familyOwnerStaffId(req) {
  const role = (req.lp && req.lp.role) || "";
  const staffId = me(req);
  if (role === "admin") return null;
  if (role === "parent" || role === "personal") return staffId;
  if (role === "family") {
    try {
      const { data } = await db.from("lp_family_members")
        .select("owner_staff_id").eq("member_staff_id", Number(staffId)).eq("member_status", 1).limit(1);
      if (data && data[0] && data[0].owner_staff_id) return String(data[0].owner_staff_id);
    } catch (_) { /* 回退本人 */ }
    return staffId;
  }
  if (role === "student") {
    try {
      const { data } = await db.from("lp_children")
        .select("parent_staff_id").eq("student_staff_id", Number(staffId)).eq("child_status", 1).limit(1);
      if (data && data[0] && data[0].parent_staff_id) return String(data[0].parent_staff_id);
    } catch (_) { /* 回退本人 */ }
    return staffId;
  }
  return staffId;
}

/** 业务表 staff_id 归属过滤（同步构建，避免 async 吞掉 thenable 查询链）；admin owner=null 不过滤 */
function ownerStaffEq(owner, q) {
  if (owner === null) return q;
  const oid = Number(owner);
  if (!oid) return q.eq("staff_id", -1);
  return q.eq("staff_id", oid);
}

/** 可管理学习资源（合集/科目）的角色：主家长 / 家属 / 管理员 / 个人；学生仅可查看使用 */
const canManageLearning = (req) => isManager(req) || isPersonal(req);

/** 列表分页参数：page（1 起）/ pageSize（默认 20，上限 200），非法值回退默认 */
function pageInfo(req) {
  const page = Math.max(1, Number((req.query && req.query.page) || 1) || 1);
  const pageSize = Math.min(Math.max(Number((req.query && req.query.pageSize) || 20) || 20, 1), 200);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 批量后台压缩图片（fire-and-forget，失败降级保留原图）：
 * 逐张 compressImageAsync，压缩完成后把最终路径回写业务表（onDone(finalPaths)）。
 * 调用方需保证原路径已先 bindBizId 关联业务，压缩时 file_uploads 登记自动迁移到压缩版。
 */
function scheduleImagesCompress(paths, onDone) {
  const list = (paths || []).filter(Boolean);
  if (list.length === 0) return;
  setTimeout(async () => {
    const finalPaths = [];
    for (const p of list) {
      try {
        const r = await compressImageAsync({ path: p });
        finalPaths.push((r && r.path) || p);
      } catch (e) {
        console.error("[lp] 图片后台压缩失败", p, e);
        finalPaths.push(p);
      }
    }
    try {
      await onDone(finalPaths);
    } catch (e) {
      console.error("[lp] 图片后台压缩回写失败", e);
    }
  }, 0);
}

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
      .select("task_id").eq("task_id", task.task_id).in("staff_id", scope.map(Number).filter(n => Number.isInteger(n) && n > 0)).limit(1);
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

// ==================== 账号注销（家长/个人） ====================
// 仅 parent / personal 可注销；其余角色无此功能。
// mode=immediate 立即注销 / grace 7天冷静期（默认）；status 查询待生效申请；revoke 撤销。
router.get("/account/cancel/status", async (req, res) => {
  try {
    const pending = await getPendingCancellation(req.appId, myOpenid(req));
    res.json(ok(pending ? {
      cancel_id: String(pending.cancel_id),
      mode: pending.mode,
      status: pending.status,
      requested_at: pending.requested_at,
      effective_at: pending.effective_at || "",
    } : null));
  } catch (e) {
    console.error("[lp] account cancel status error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/account/cancel", async (req, res) => {
  try {
    if (!roleCanCancel(req.lp && req.lp.role)) return res.json(fail("当前身份不支持注销账号", 403));
    const { mode } = req.body || {};
    const r = await requestCancellation({
      appId: req.appId,
      staffId: me(req),
      openid: myOpenid(req),
      role: req.lp.role,
      mode: String(mode || "grace"),
    });
    res.json(ok({ mode: r.mode, status: r.status, effective_at: r.effective_at }, r.msg));
  } catch (e) {
    console.error("[lp] account cancel error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/account/cancel/revoke", async (req, res) => {
  try {
    if (!roleCanCancel(req.lp && req.lp.role)) return res.json(fail("当前身份不支持注销账号", 403));
    const okRevoked = await cancelPendingCancellation(req.appId, myOpenid(req));
    res.json(ok(null, okRevoked ? "已撤销注销申请" : "没有待撤销的注销申请"));
  } catch (e) {
    console.error("[lp] account cancel revoke error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 数据字典 ====================
// 前端标签统一取色：任务状态（task_status）/ 打卡方式（checkin_type）等字典项，
// 返回 item_value/item_label/color，后台「数据字典」调整 color 后全局同步。
router.get("/dicts", async (req, res) => {
  try {
    const codes = String((req.query && req.query.codes) || "task_status,checkin_type")
      .split(",").map(s => String(s || "").trim().slice(0, 32)).filter(Boolean);
    const uniq = [...new Set(codes)];
    const rows = await Promise.all(uniq.map(async code => ({
      code,
      items: (await cachedDictItems(code)).map(it => ({
        value: it.item_value,
        label: it.item_label,
        color: it.color || "",
      })),
    })));
    const map = {};
    rows.forEach(r => { map[r.code] = r.items; });
    res.json(ok(map));
  } catch (e) {
    console.error("[lp] dicts error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 系统参数（前端文案/常量，后端维护） ====================
// keys 逗号分隔或数组；返回 { key: value }，param_type=json 的参数返回解析后的对象。
router.get("/params", async (req, res) => {
  try {
    const keys = (Array.isArray((req.query && req.query.keys)) ? (req.query.keys) : String((req.query && req.query.keys) || "").split(","))
      .map(s => String(s || "").trim().slice(0, 64)).filter(Boolean);
    if (keys.length === 0) return res.json(ok({}));
    const map = await getParamsMap(req.appId || "miniprogram-kxm", keys);
    res.json(ok(map));
  } catch (e) {
    console.error("[lp] params error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 我的资料 ====================
router.get("/profile", async (req, res) => {
  try {
    const { data: rows, error } = await db.from("staff")
      .select("staff_id, staff_username, staff_nickname, staff_avatar, staff_role")
      .eq("staff_id", Number(me(req))).limit(1);
    if (error) throw error;
    const staff = rows && rows[0];
    if (!staff) return res.json(fail("账号不存在", 403));
    // t_users 用户画像（user_uid = 小程序端展示的「用户ID」；区别于 staff_id）
    let userId = "";
    try {
      const u = await ensureUser(req.app, myOpenid(req));
      userId = (u && u.user_uid) || "";
    } catch (_) { /* 静默注册失败不阻断资料查询 */ }
    // 多身份（共用微信）：返回该 openid 全部有效身份 + PIN 状态，供前端切换
    const identities = await listBoundStaffs(myOpenid(req));
    res.json(ok({
      app: req.appId || "miniprogram-kxm",
      userId,
      staff: {
        staff_id: String(staff.staff_id),
        username: staff.staff_username,
        nickname: staff.staff_nickname || (staff.staff_role === "personal" ? "个人" : "学生"),
        avatar: staff.staff_avatar || "",
      },
      identities,
    }));
  } catch (e) {
    console.error("[lp] profile error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 更新我的资料（同步 staff_nickname / staff_avatar；昵称/头像写时内容安全校验） */
router.post("/profile", async (req, res) => {
  try {
    const { nickname, avatar } = req.body || {};
    const n = String(nickname || "").trim().slice(0, 32);
    if (!n) return res.json(fail("昵称不能为空"));
    const avatarPath = avatar !== undefined ? String(avatar).trim().slice(0, 500) : "";
    const myStaffId = me(req);
    const myOpenidVal = myOpenid(req);

    // 内容安全：昵称/头像写时同步校验（命中违规直接拒绝修改；检测失败/关闭则放行）
    let nickCheck = null;
    let avatarCheck = null;
    try {
      nickCheck = await textCheckNow({ appId: req.appId, content: n, openid: myOpenidVal });
      if (avatarPath) avatarCheck = await imageCheckNow({ appId: req.appId, path: avatarPath });
    } catch (e) {
      console.error("[lp] 资料写时内容安全校验失败（放行）", e);
    }
    if (nickCheck && nickCheck.status === "reject") return res.json(fail("昵称包含违规内容，请修改后重试"));
    if (avatarCheck && avatarCheck.status === "reject") return res.json(fail("头像包含违规内容，请更换后重试"));
    // 审计留痕：昵称预检结果落库（安全关闭/检测失败时不落库）
    if (nickCheck && !nickCheck.skipped) {
      submitForAudit({
        appId: req.appId,
        bizType: "profile",
        bizId: myStaffId,
        field: "nickname",
        mediaType: 1,
        content: n,
        openid: myOpenidVal,
        status: nickCheck.status,
        detail: String((nickCheck.data && nickCheck.data.result && nickCheck.data.result.label) || ""),
        wx_raw: nickCheck.data,
      }).catch(() => {});
    }
    if (avatarCheck && !avatarCheck.skipped && avatarPath) {
      submitForAudit({
        appId: req.appId,
        bizType: "profile",
        bizId: myStaffId,
        field: "avatar",
        mediaType: 2,
        content: avatarPath,
        openid: myOpenidVal,
        status: avatarCheck.status,
        detail: String((avatarCheck.data && avatarCheck.data.result && avatarCheck.data.result.label) || ""),
        wx_raw: avatarCheck.data,
      }).catch(() => {});
    }

    const values = { staff_nickname: n, updated_at: nowSql() };
    if (avatar !== undefined) values.staff_avatar = avatarPath;
    await db.from("staff").update(values).eq("staff_id", Number(myStaffId));
    // 失效 staff 行缓存（昵称/头像变更立即生效，避免 60s 内读到旧值）
    invalidateStaffRows([Number(myStaffId)]);
    // 后台压缩头像（异步，压缩完成后回写 staff_avatar）
    if (avatar !== undefined && avatarPath) {
      setTimeout(async () => {
        try {
          const r = await compressImageAsync({ path: avatarPath });
          if (r && r.path && r.path !== avatarPath) {
            await db.from("staff").update({ staff_avatar: r.path, updated_at: nowSql() }).eq("staff_id", Number(myStaffId));
          }
        } catch (e) {
          console.error("[lp] 头像后台压缩失败", e);
        }
      }, 0);
    }
    res.json(ok({ nickname: n, avatar: avatarPath }, "已更新"));
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
    if (scope !== null) q = q.in("staff_id", scope.map(Number).filter(n => Number.isInteger(n) && n > 0));
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
      const [assignR, ownR] = await Promise.all([
        db.from("task_assignees").select("task_id, staff_id").in("staff_id", staffIds).limit(10000),
        db.from("tasks").select("task_id, created_by").in("created_by", staffIds).limit(10000),
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
      // 待审核打卡数：按学生精确 count（学生数少，并行执行；避免拉全量打卡行再 JS 计数）
      const pendCounts = await Promise.all(staffIds.map(async (sid) => {
        try {
          const count = await countRows("task_checkins", "checkin_id", (q) => q.eq("review_status", "pending").eq("created_by", sid));
          return { sid, count };
        } catch (_) { return { sid, count: 0 }; }
      }));
      pendCounts.forEach(({ sid, count }) => {
        const s = statMap[String(sid)];
        if (s) s.pendingReview = count;
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

/** 判断 staffId 是否有权访问 taskId（派发给我 or 我创建）：单行直查，避免拉全量 id 列表再 includes */
async function canAccessTask(staffId, taskId) {
  const sid = Number(staffId);
  const tid = Number(taskId);
  if (!sid || !tid) return false;
  const [aRes, oRes] = await Promise.all([
    db.from("task_assignees").select("task_id").eq("task_id", tid).eq("staff_id", sid).limit(1),
    db.from("tasks").select("task_id").eq("task_id", tid).eq("created_by", sid).limit(1),
  ]);
  return !!((aRes.data && aRes.data[0]) || (oRes.data && oRes.data[0]));
}

// ==================== 任务列表（学生：派发给我+我创建；管理员：视角学生） ====================
router.get("/tasks", async (req, res) => {
  try {
    const { status, collectionId, keyword } = req.query;
    const { page, pageSize, offset } = pageInfo(req);
    const staffId = Number(await viewStaffId(req));
    const ids = await myTaskIds(staffId);
    if (ids.length === 0) return res.json(ok({ list: [], total: 0, page, pageSize, hasMore: false }));

    // 学生可见：派发给我 + 我创建；内容安全：仅排除 risk_status=reject（违规禁止展示，pending 脱敏展示）
    const applyFilters = (q) => {
      q = q.in("task_id", ids);
      q = q.in("risk_status", ["pass", "pending"]);
      if (status) q = q.eq("task_status", String(status).slice(0, 16));
      if (collectionId) q = q.eq("collection_id", Number(collectionId));
      if (keyword) q = q.or(`title.like.%${String(keyword).replace(/[(),]/g, "").slice(0, 100)}%`);
      return q;
    };
    const [total, listRes] = await Promise.all([
      countRows("tasks", "task_id", applyFilters),
      applyFilters(db.from("tasks").select())
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1),
    ]);
    const { data: rows, error } = listRes;
    if (error) throw error;

    let list = rows || [];
    if (list.length > 0) {
      // 从用户角度排序：待完成/进行中（未完成）在前，已完成在后；组内最新创建在前
      const prio = { todo: 0, doing: 1, done: 2 };
      list.sort((a, b) => (prio[a.task_status] ?? 9) - (prio[b.task_status] ?? 9) || String(b.created_at).localeCompare(String(a.created_at)));
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
      risk_status: t.risk_status || "pending",
      progress: Number(t.progress) >= 0 ? Number(t.progress) : (t.task_status === "done" ? 100 : t.task_status === "doing" ? 50 : 1),
      checkin_type: normalizeCheckinType(t.checkin_type),
      source: normalizeTaskSource(t.source),
      score: t.score,
      deadline: t.deadline,
      start_date: t.start_date,
      collection_id: t.collection_id,
      collection_name: t.collection_name || "",
      checkin_count: t.checkin_count || 0,
      created_by: t.created_by,
      created_at: t.created_at,
    }));
    // 内容安全：读时派生展示级别（关闭/失败=透传，前端零感知）
    list = await mergeAudit(list, {
      appId: req.appId,
      bizType: "task",
      bizId: (t) => t.task_id,
      texts: [
        { field: "title", get: (t) => t.title },
        { field: "description", get: (t) => t.description },
      ],
      media: [{ field: "images", get: (t) => t.images }],
    });
    res.json(ok({ list, total, page, pageSize, hasMore: offset + (list || []).length < total }));
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
    if (!(await canAccessTask(staffId, Number(id)))) return res.json(fail("无权访问该任务", 403));

    const [tRes, cRes] = await Promise.all([
      db.from("tasks").select().eq("task_id", Number(id)).limit(1),
      db.from("task_checkins").select().eq("task_id", Number(id)).eq("created_by", staffId).in("risk_status", ["pass", "pending"]).order("checkin_date", { ascending: false }).limit(200),
    ]);
    if (tRes.error) throw tRes.error;
    if (cRes.error) throw cRes.error;
    const task = tRes.data && tRes.data[0];
    // 内容安全：risk_status=reject 的任务禁止展示（含本人）
    if (!task || task.risk_status === "reject") return res.json(fail("任务不存在或无权访问", 403));
    const cRows = cRes.data || [];
    // 打卡人信息：checkin.created_by → 昵称/用户名（同一 staffId 查询，全部归属当前查看学生）
    const cWithStaff = await attachStaffInfo(cRows);

    const [withCol, withAsg, withStaff] = await Promise.all([
      attachCollectionName([task]),
      attachAssignees([task]),
      attachStaffInfo([task]),
    ]);
    const merged = { ...(withAsg[0] || {}), ...(withCol[0] || {}), ...(withStaff[0] || {}) };
    const taskOut = {
      task_id: task.task_id,
      title: task.title,
      subject: task.subject,
      tags: safeJson(task.tags, []),
      description: task.description,
      task_link: task.task_link,
      images: parseImgList(task.images),
      task_status: task.task_status,
      risk_status: task.risk_status || "pending",
      progress: Number(task.progress) >= 0 ? Number(task.progress) : (task.task_status === "done" ? 100 : task.task_status === "doing" ? 50 : 1),
      checkin_type: normalizeCheckinType(task.checkin_type),
      source: normalizeTaskSource(task.source),
      score: task.score,
      deadline: task.deadline,
      start_date: task.start_date,
      collection_id: task.collection_id,
      collection_name: merged.collection_name || "",
      checkin_count: task.checkin_count || 0,
      assignee_ids: merged.assignee_ids || [],
      created_by: task.created_by,
      created_at: task.created_at,
      creator_name: merged._creatorNickname || merged._creatorUsername || "",
      creator_avatar: merged._creatorAvatar || "",
    };
    let checkinsOut = (cWithStaff || []).map(c => ({
      checkin_id: c.checkin_id,
      checkin_date: c.checkin_date,
      checkin_note: c.checkin_note,
      images: parseImgList(c.checkin_images),
      checkin_type: normalizeCheckinType(c.checkin_type),
      source: normalizeTaskSource(c.source, "miniprogram"),
      submitter_name: c._creatorNickname || c._creatorUsername || "学生",
      submitter_avatar: c._creatorAvatar || "",
      voice_url: c.voice_url || "",
      voice_duration: Number(c.voice_duration) || 0,
      video_url: c.video_url || "",
      video_duration: Number(c.video_duration) || 0,
      video_size: Number(c.video_size) || 0,
      video_cover: c.video_cover || "",
      review_status: c.review_status || "approved",
      risk_status: c.risk_status || "pending",
      review_score: c.review_score || 0,
      review_note: c.review_note || "",
      created_at: c.created_at,
    }));
    // 内容安全：读时派生展示级别（关闭/失败=透传，前端零感知）
    checkinsOut = await mergeAudit(checkinsOut, {
      appId: req.appId,
      bizType: "checkin",
      bizId: (c) => c.checkin_id,
      texts: [{ field: "checkin_note", get: (c) => c.checkin_note }],
      media: [
        { field: "images", get: (c) => c.images },
        { field: "voice_url", get: (c) => c.voice_url },
        { field: "video_url", get: (c) => c.video_url },
        { field: "video_cover", get: (c) => c.video_cover },
      ],
    });
    const taskMerged = await mergeAudit([taskOut], {
      appId: req.appId,
      bizType: "task",
      bizId: (t) => t.task_id,
      texts: [
        { field: "title", get: (t) => t.title },
        { field: "description", get: (t) => t.description },
      ],
      media: [{ field: "images", get: (t) => t.images }],
    });
    res.json(ok({ task: taskMerged[0], checkins: checkinsOut }));
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
    // 打卡方式：非法值回退图文
    const ctype = String(b.checkin_type || "image").trim();
    const checkinType = normalizeCheckinType(ctype);

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
      progress: 1,
      checkin_type: checkinType,
      source: "miniprogram",
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
    // 系统通知：新任务派发 → 通知被派发学生（家长/家属布置时 assignerName=布置人昵称）
    notifyTaskAssigned({
      appId: req.appId,
      taskId,
      taskTitle: title,
      assigneeIds,
      assignerStaffId: isManager(req) ? staffId : 0,
    }).catch(() => {});
    // 图片完全复制：若提交的图片已被其他任务绑定（复制场景），物理复制新文件归本任务，避免原任务删除后图片失效
    let images = Array.isArray(b.images) ? b.images : [];
    let owned = images;
    if (images.length > 0) {
      owned = await dupSharedImages({ openid: myOpenid(req), staffId: "", paths: images, targetBizId: taskId, biz: "tasks" });
      if (owned.join("|") !== images.join("|")) {
        await db.from("tasks").update({ images: JSON.stringify(owned), updated_at: nowSql() }).eq("task_id", taskId);
      }
      await bindBizId({ openid: myOpenid(req), paths: owned, bizId: taskId });
      // 内容安全：把任务图片审核行归属到任务记录并聚合 risk_status
      rebindAudit({ bizType: "task", bizId: taskId, paths: owned })
        .then(() => syncRecordRisk({ bizType: "task", bizId: taskId }))
        .catch(() => {});
    }
    // 后台压缩任务图片（异步，压缩完成后回写 tasks.images）
    if (owned.length > 0) {
      scheduleImagesCompress(owned, async (finalPaths) => {
        await db.from("tasks").update({ images: JSON.stringify(finalPaths), updated_at: nowSql() }).eq("task_id", taskId);
      });
    }

    // 内容安全：任务文本旁路入队检测（fire-and-forget，关闭/失败不影响业务）
    submitForAudit({ appId: req.appId, bizType: "task", bizId: taskId, field: "title", mediaType: 1, content: title, openid: myOpenid(req) }).catch(() => {});
    submitForAudit({ appId: req.appId, bizType: "task", bizId: taskId, field: "description", mediaType: 1, content: values.description, openid: myOpenid(req) }).catch(() => {});

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
      progress: 1,
      checkin_type: normalizeCheckinType(src.checkin_type),
      source: "miniprogram",
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
    // 系统通知：复制任务沿用派发 → 通知被派发学生
    notifyTaskAssigned({
      appId: req.appId,
      taskId: newTaskId,
      taskTitle: src.title,
      assigneeIds,
      assignerStaffId: isManager(req) ? staffId : 0,
    }).catch(() => {});

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
    if (b.checkin_type !== undefined) {
      const ctype = String(b.checkin_type || "image").trim();
      values.checkin_type = normalizeCheckinType(ctype);
    }
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
        // 删除违规图片后重新聚合任务 risk_status（避免残留 reject 拦截）
        syncRecordRisk({ bizType: "task", bizId: id }).catch(() => {});
      }
      if (newPaths.length > 0) await bindBizId({ openid: myOpenid(req), paths: newPaths, bizId: id });
      // 内容安全：新增任务图片归属到任务记录并聚合 risk_status
      if (newPaths.length > 0) {
        rebindAudit({ bizType: "task", bizId: id, paths: newPaths })
          .then(() => syncRecordRisk({ bizType: "task", bizId: id }))
          .catch(() => {});
      }
      // 后台压缩新增任务图片（异步，压缩完成后回写 tasks.images）
      if (newPaths.length > 0) {
        scheduleImagesCompress(newPaths, async (finalPaths) => {
          await db.from("tasks").update({ images: JSON.stringify(finalPaths), updated_at: nowSql() }).eq("task_id", id);
        });
      }
    }

    // 内容安全：仅对本次有变更的文本字段旁路重检（未变更不重检，省额度）
    if (b.title !== undefined) {
      submitForAudit({ appId: req.appId, bizType: "task", bizId: id, field: "title", mediaType: 1, content: values.title || "", openid: myOpenid(req) }).catch(() => {});
    }
    if (b.description !== undefined) {
      submitForAudit({ appId: req.appId, bizType: "task", bizId: id, field: "description", mediaType: 1, content: values.description || "", openid: myOpenid(req) }).catch(() => {});
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

// ==================== 任务状态流转（待完成→进行中→已完成） ====================
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
      values.progress = 100;
    }
    if (isManager(req)) {
      await db.from("tasks").update(values).eq("task_id", tid);
    } else {
      await db.from("tasks").update(values).eq("task_id", tid).eq("created_by", staffId);
    }
    // 积分账本：任务完成 +30 / 回退 -30（幂等：按 old→new 状态变迁判定）
    if (old.task_status !== st) applyTaskStatusPoints(old, old.task_status, st, staffId).catch(() => {});
    // 系统通知：任务完成 → 通知任务归属学生的家长/家属（操作人自己除外）
    if (st === "done" && old.task_status !== "done") {
      notifyTaskDone({ appId: req.appId, task: old, actorStaffId: staffId }).catch(() => {});
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

    // 积分账本：删除任务回扣（已完成 -30、已通过打卡每人 -10），须在派发人关联删除前调用
    deductTaskDeleted(record, staffId).catch(() => {});

    // 级联清理：任务附件图 + 打卡图 + 打卡语音 + 打卡记录 + 派发关联
    try {
      const { data: checkins } = await db.from("task_checkins")
        .select("checkin_id, checkin_images, voice_url, video_url").eq("task_id", tid).limit(10000);
      const checkinList = checkins || [];
      const paths = [...parseImgList(record.images)];
      checkinList.forEach(c => {
        paths.push(...parseImgList(c.checkin_images));
        if (c.voice_url) paths.push(c.voice_url);
        if (c.video_url) paths.push(c.video_url);
      });
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
    const { page, pageSize, offset } = pageInfo(req);
    const applyFilters = (q) => {
      q = q.eq("created_by", staffId);
      // 内容安全：排除 risk_status=reject（违规禁止展示）
      q = q.in("risk_status", ["pass", "pending"]);
      if (taskId) q = q.eq("task_id", Number(taskId));
      if (date) q = q.eq("checkin_date", String(date).slice(0, 10));
      return q;
    };
    const [total, listRes] = await Promise.all([
      countRows("task_checkins", "checkin_id", applyFilters),
      applyFilters(db.from("task_checkins").select())
        .order("checkin_date", { ascending: false })
        .range(offset, offset + pageSize - 1),
    ]);
    const { data: rows, error } = listRes;
    if (error) throw error;

    const taskIds = [...new Set((rows || []).map(r => r.task_id).filter(Boolean))];
    const taskMap = {};
    if (taskIds.length > 0) {
      const { data: tasks } = await db.from("tasks")
        .select("task_id, title, task_status").in("task_id", taskIds).limit(taskIds.length);
      (tasks || []).forEach(t => { taskMap[t.task_id] = t; });
    }
    let list = (rows || []).map(c => ({
      checkin_id: c.checkin_id,
      task_id: c.task_id,
      task_title: (taskMap[c.task_id] || {}).title || "(任务已删除)",
      checkin_date: c.checkin_date,
      checkin_note: c.checkin_note,
      images: parseImgList(c.checkin_images),
      checkin_type: normalizeCheckinType(c.checkin_type),
      source: normalizeTaskSource(c.source, "miniprogram"),
      voice_url: c.voice_url || "",
      voice_duration: Number(c.voice_duration) || 0,
      video_url: c.video_url || "",
      video_duration: Number(c.video_duration) || 0,
      video_size: Number(c.video_size) || 0,
      video_cover: c.video_cover || "",
      risk_status: c.risk_status || "pending",
      created_at: c.created_at,
    }));
    // 内容安全：读时派生展示级别（关闭/失败=透传，前端零感知）
    list = await mergeAudit(list, {
      appId: req.appId,
      bizType: "checkin",
      bizId: (c) => c.checkin_id,
      texts: [{ field: "checkin_note", get: (c) => c.checkin_note }],
      media: [
        { field: "images", get: (c) => c.images },
        { field: "voice_url", get: (c) => c.voice_url },
        { field: "video_url", get: (c) => c.video_url },
        { field: "video_cover", get: (c) => c.video_cover },
      ],
    });
    res.json(ok({ list, total, page, pageSize, hasMore: offset + (list || []).length < total }));
  } catch (e) {
    console.error("[lp] checkins list error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 打卡（任务必须可见，created_by=本人） ====================
router.post("/checkins/create", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { taskId, date, note, images, voiceUrl, voiceDuration, videoUrl, videoDuration } = req.body || {};
    const tid = Number(taskId);
    if (!tid) return res.json(fail("缺少任务 ID"));

    if (!(await canAccessTask(staffId, tid))) return res.json(fail("无权操作该任务", 403));

    const { data: rows, error } = await db.from("tasks")
      .select("task_id, title, task_status, checkin_count, checkin_type").eq("task_id", tid).limit(1);
    if (error) throw error;
    const task = rows && rows[0];
    if (!task) return res.json(fail("任务不存在"));
    // 兜底风控：已完成任务仅可查看，学生禁止打卡（管理员不受限）
    if (!isAdmin(req) && task.task_status === "done") return res.json(fail("任务已完成，不能打卡"));

    // 打卡方式强约束：以任务发布的 checkin_type 为准
    const checkinType = normalizeCheckinType(task.checkin_type);
    const vUrl = String(voiceUrl || "").trim().slice(0, 500);
    const vDur = Math.floor(Number(voiceDuration) || 0);
    const vUrl2 = String(videoUrl || "").trim().slice(0, 500);
    const vDur2 = Math.floor(Number(videoDuration) || 0);

    let imgList = [];
    if (checkinType === "voice") {
      // 语音打卡：必须携带已上传的语音文件，禁止图片
      if (!vUrl || !vUrl.startsWith("kxm/voice/")) return res.json(fail("请先录制语音再打卡"));
      if (vDur < 1 || vDur > 60) return res.json(fail("语音时长不合法"));
      if (Array.isArray(images) && images.length > 0) return res.json(fail("语音打卡不支持图片"));
      // 完整性校验：语音文件必须已登记上传（归属本人，active）且真实存在于云存储
      const { data: vRows } = await db.from("file_uploads").select("file_id").eq("file_path", vUrl).eq("openid", myOpenid(req)).eq("file_status", "active").limit(1);
      const vRec = vRows && vRows[0];
      if (!vRec) return res.json(fail("请先录制语音再打卡"));
      if ((await storageFileExists(vUrl)) === false) return res.json(fail("语音文件不存在，请重新录制"));
    } else if (checkinType === "video") {
      // 视频打卡：必须携带已上传的视频文件（限 1GB），禁止图片
      if (!vUrl2 || !vUrl2.startsWith("kxm/videos/")) return res.json(fail("请先上传视频再打卡"));
      if (vDur2 < 1 || vDur2 > 3600) return res.json(fail("视频时长不合法"));
      if (Array.isArray(images) && images.length > 0) return res.json(fail("视频打卡不支持图片"));
      // 完整性校验：视频必须已登记上传（归属本人，active）且真实存在于云存储
      const { data: vRows } = await db.from("file_uploads").select("file_id").eq("file_path", vUrl2).eq("openid", myOpenid(req)).eq("file_status", "active").limit(1);
      const vRec = vRows && vRows[0];
      if (!vRec) return res.json(fail("请先上传视频再打卡"));
      if ((await storageFileExists(vUrl2)) === false) return res.json(fail("视频文件不存在，请重新上传"));
    } else {
      imgList = (Array.isArray(images) ? images : []).slice(0, 9);
      // 图文打卡强约束：必须输入文字 + 至少上传一张图片（与任务发布的打卡方式一致）
      const noteText = String(note || "").trim();
      if (!noteText) return res.json(fail("图文打卡需输入打卡文字"));
      if (imgList.length < 1) return res.json(fail("图文打卡需至少上传一张图片"));
      // 完整性校验：每张图片必须已登记上传（归属本人，active）
      const { data: imgRows } = await db.from("file_uploads").select("file_path").eq("openid", myOpenid(req)).eq("file_status", "active").in("file_path", imgList).limit(imgList.length);
      const registered = new Set((imgRows || []).map(r => r.file_path));
      const missing = imgList.filter(p => !registered.has(p));
      if (missing.length > 0) return res.json(fail("图片未上传成功，请重新上传"));
    }
    // 视频大小后端复核（登记记录里取；无登记记录时以路径前缀校验兜底）
    let videoSize = 0;
    if (checkinType === "video") {
      const { data: vRows } = await db.from("file_uploads").select("file_size").eq("file_path", vUrl2).limit(1);
      const vRec = vRows && vRows[0];
      if (vRec && Number(vRec.file_size) > VIDEO_MAX_SIZE) return res.json(fail("视频不能超过 1GB"));
      videoSize = Number((vRec && vRec.file_size) || 0);
    }

    const checkinDate = date || formatDate(new Date());
    const checkinId = await nextSeq("task_checkin_id");
    // 个人身份：自己打卡，无审核方 → 直接置为已通过（自服务，最简单）
    const autoApproved = isPersonal(req);
    const { error: insErr } = await db.from("task_checkins").insert({
      checkin_id: checkinId,
      task_id: tid,
      checkin_date: String(checkinDate).slice(0, 10),
      checkin_note: String(note || "").slice(0, 500),
      checkin_images: JSON.stringify(imgList),
      checkin_type: checkinType,
      source: "miniprogram",
      voice_url: checkinType === "voice" ? vUrl : "",
      voice_duration: checkinType === "voice" ? vDur : 0,
      video_url: checkinType === "video" ? vUrl2 : "",
      video_duration: checkinType === "video" ? vDur2 : 0,
      video_size: checkinType === "video" ? videoSize : 0,
      created_by: staffId,
      review_status: autoApproved ? "approved" : "pending",
      review_score: autoApproved ? 10 : 0,
      reviewer: 0,
      reviewed_at: autoApproved ? nowSql() : null,
      created_at: nowSql(),
    });
    if (insErr) throw insErr;

    // 内容安全：打卡正文旁路入队检测（fire-and-forget；媒体已在 logUpload 登记时入队）
    submitForAudit({ appId: req.appId, bizType: "checkin", bizId: checkinId, field: "checkin_note", mediaType: 1, content: String(note || ""), openid: myOpenid(req) }).catch(() => {});

    // 视频打卡：后端后台压缩视频节省云存储空间（异步，压缩/抽帧完成后回写 video_url/video_size/video_cover）
    if (checkinType === "video" && vUrl2) {
      setTimeout(async () => {
        try {
          const r = await compressVideo({ path: vUrl2, duration: vDur2 });
          const upd = { video_size: Number((r && r.size) || 0) };
          if (r && r.path && r.path !== vUrl2) upd.video_url = r.path;
          if (r && r.cover) upd.video_cover = r.cover;
          if (Object.keys(upd).length > 0) {
            await db.from("task_checkins").update(upd).eq("checkin_id", checkinId);
          }
        } catch (e) {
          console.error("[lp] 视频后台压缩失败", vUrl2, e);
        }
      }, 0);
    }

    if (imgList.length > 0) await bindBizId({ openid: myOpenid(req), paths: imgList, bizId: tid });
    // 图片打卡：后端后台压缩图片（异步，压缩完成后回写 checkin_images，前端展示无感）
    if (imgList.length > 0) {
      scheduleImagesCompress(imgList, async (finalPaths) => {
        await db.from("task_checkins").update({ checkin_images: JSON.stringify(finalPaths) }).eq("checkin_id", checkinId);
      });
    }

    // 内容安全：把本打卡的媒体审核行归属到打卡记录（biz_type=checkin，biz_id=checkinId），并立即聚合 risk_status
    const checkinMedia = checkinType === "voice" ? [vUrl] : (checkinType === "video" ? [vUrl2] : imgList);
    if (checkinMedia.length > 0) {
      rebindAudit({ bizType: "checkin", bizId: checkinId, paths: checkinMedia })
        .then(() => syncRecordRisk({ bizType: "checkin", bizId: checkinId }))
        .catch(() => {});
    }

    // 更新任务打卡次数与状态（加锁串行化读改写，防并发丢计数）
    await withLock(`task:count:${tid}`, async () => {
      const { data: curRows } = await db.from("tasks").select("checkin_count, task_status").eq("task_id", tid).limit(1);
      const cur = (curRows && curRows[0]) || task;
      const taskValues = { checkin_count: (Number(cur.checkin_count) || 0) + 1, progress: 50, updated_at: nowSql() };
      if (cur.task_status === "todo") taskValues.task_status = "doing";
      await db.from("tasks").update(taskValues).eq("task_id", tid);
    });

    // 个人身份：打卡即通过 → +10 分；任务全部通过则任务完成 +30（与审核通过同规则）
    if (autoApproved) {
      awardCheckinApproved({ checkin_id: checkinId, created_by: staffId }, staffId).catch(() => {});
      const allDone = await taskAllRecipientsDone(tid);
      if (allDone) {
        await db.from("tasks").update({ task_status: "done", score: 10, progress: 100, updated_at: nowSql() }).eq("task_id", tid);
        if (task && task.task_status !== "done") applyTaskStatusPoints(task, task.task_status, "done", staffId).catch(() => {});
      }
    }

    logTaskEvent({
      taskId: tid, checkinId, bizType: "task_checkin", eventType: "checkin", eventName: "任务打卡",
      summary: autoApproved
        ? `个人用户对任务「${task.title}」打卡（第 ${(task.checkin_count || 0) + 1} 次，自动通过）`
        : `小程序端对任务「${task.title}」打卡（第 ${(task.checkin_count || 0) + 1} 次，待审核）`,
      payload: { task_title: task.title, checkin_date: checkinDate, note: note || "", images: imgList, checkin_type: checkinType, voice_url: vUrl, voice_duration: vDur, review_status: autoApproved ? "approved" : "pending" },
      staffId,
    });
    logEvent({ appId: req.appId, openid: myOpenid(req), eventType: "create", eventName: "学习打卡", pagePath: "/pages/task-detail/index", bizId: String(tid) });
    // 系统通知：学生提交打卡 → 提醒家长/家属及时审核（个人无审核方，不通知）
    if (!autoApproved) {
      notifyCheckinSubmitted({
        appId: req.appId,
        studentStaffId: staffId,
        taskTitle: task.title,
        taskId: tid,
        checkinDate: String(checkinDate).slice(0, 10),
        checkinId,
      }).catch(() => {});
    }
    res.json(ok({ checkin_id: checkinId }, autoApproved ? "打卡成功" : "打卡成功，等待老师审核"));
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
    // 积分账本：删除已通过打卡 -10（未通过本就无分，直接忽略）
    deductCheckinDeleted(rec, staffId).catch(() => {});
    // 级联清理媒体文件（语音/视频/封面：物理删 COS + 登记记录）
    const mediaPaths = [];
    if (rec.voice_url) mediaPaths.push(rec.voice_url);
    if (rec.video_url) mediaPaths.push(rec.video_url);
    if (rec.video_cover) mediaPaths.push(rec.video_cover);
    if (mediaPaths.length > 0) {
      try {
        const { deleted } = await removeFiles(mediaPaths);
        if (deleted.length > 0) {
          await db.from("file_uploads").delete().in("file_path", deleted);
        }
      } catch (_) {}
    }
    // 任务打卡次数回退（加锁串行化，防并发读写竞态）
    await withLock(`task:count:${rec.task_id}`, async () => {
      const { data: tRows } = await db.from("tasks")
        .select("checkin_count").eq("task_id", rec.task_id).limit(1);
      if (tRows && tRows[0]) {
        const cnt = Math.max(0, (tRows[0].checkin_count || 0) - 1);
        await db.from("tasks").update({ checkin_count: cnt, updated_at: nowSql() }).eq("task_id", rec.task_id);
      }
    });
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
// Student：展示所有未完成任务（待完成 todo + 进行中 doing）
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

/** 学生待办：派发给我/我创建，且未完成（待完成 todo / 进行中 doing）的任务 */
async function studentTodos(req, res) {
  const staffId = Number(me(req));
  const ids = await myTaskIds(String(staffId));
  const { page, pageSize, offset } = pageInfo(req);
  let list = [];
  let total = 0;
  if (ids.length > 0) {
    const applyFilters = (q) => q.in("task_id", ids).in("task_status", ["todo", "doing"]).in("risk_status", ["pass", "pending"]);
    const [totalCount, listRes] = await Promise.all([
      countRows("tasks", "task_id", applyFilters),
      applyFilters(db.from("tasks").select())
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1),
    ]);
    total = totalCount;
    const { data: rows, error } = listRes;
    if (error) throw error;
    // 待办 = 未完成的任务（待完成 + 进行中），已完成的不展示
    const all = (rows || []).filter(t => t.task_status === "todo" || t.task_status === "doing");
    if (all.length > 0) {
      const [withCol, withAsg] = await Promise.all([attachCollectionName(all), attachAssignees(all)]);
      list = all.map((t, i) => ({ ...t, ...(withCol[i] || {}), ...(withAsg[i] || {}) }));
    }
  }
  list = list.map(t => ({
    task_id: t.task_id,
    title: t.title,
    subject: t.subject,
    task_status: t.task_status,
    risk_status: t.risk_status || "pending",
    checkin_type: normalizeCheckinType(t.checkin_type),
    source: normalizeTaskSource(t.source),
    deadline: t.deadline,
    checkin_count: t.checkin_count || 0,
    collection_name: t.collection_name || "",
    created_at: t.created_at,
  }));
  // 内容安全：读时派生展示级别（关闭/失败=透传，前端零感知）
  list = await mergeAudit(list, {
    appId: req.appId,
    bizType: "task",
    bizId: (t) => t.task_id,
    texts: [{ field: "title", get: (t) => t.title }],
    media: [{ field: "images", get: (t) => t.images }],
  });
  // 今日概览：今天完成多少次打卡（学生待办卡片丰富展示用）
  const today0 = `${formatDate(new Date())} 00:00:00`;
  const { data: todayRows } = await db.from("task_checkins")
    .select("checkin_id").eq("created_by", staffId).gte("created_at", today0).limit(1000);
  res.json(ok({
    type: "student",
    count: total,
    total,
    page,
    pageSize,
    hasMore: offset + list.length < total,
    todayStats: {
      todayCheckins: (todayRows || []).length,
      todayTasksDone: list.filter(t => String(t.created_at || "").slice(0, 10) === formatDate(new Date()) && t.task_status === "done").length,
    },
    list,
  }));
}

/** 家长/家属/管理员待办：本家庭范围内待审核打卡（含学生/任务/提交内容） */
async function managerTodos(req, res) {
  const scope = myScope(req);
  const { page, pageSize, offset } = pageInfo(req);
  // 空 scope（家长/家属名下无孩子）：直接返回空列表，避免空数组 in() 报错
  if (scope !== null && scope.length === 0) return res.json(ok({ type: "admin", count: 0, total: 0, page, pageSize, hasMore: false, list: [] }));
  // 内容安全拦截的记录不进待审核队列（无法审核通过，避免误操作）
  const applyFilters = (q) => {
    q = q.eq("review_status", "pending").neq("risk_status", "reject");
    if (scope !== null) q = q.in("created_by", scope.map(Number).filter(n => Number.isInteger(n) && n > 0));
    return q;
  };
  const [total, listRes] = await Promise.all([
    countRows("task_checkins", "checkin_id", applyFilters),
    applyFilters(db.from("task_checkins").select())
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1),
  ]);
  const { data: rows, error } = listRes;
  if (error) throw error;
  const list0 = (rows || []).filter(c => c.risk_status !== "reject");
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
  let list = list0
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
        checkin_type: normalizeCheckinType(c.checkin_type),
        source: normalizeTaskSource(c.source, "miniprogram"),
        voice_url: c.voice_url || "",
        voice_duration: Number(c.voice_duration) || 0,
        video_url: c.video_url || "",
        video_duration: Number(c.video_duration) || 0,
        video_size: Number(c.video_size) || 0,
        video_cover: c.video_cover || "",
        risk_status: c.risk_status || "pending",
        created_at: c.created_at,
      };
    });
  // 内容安全：读时派生展示级别（关闭/失败=透传，前端零感知）
  list = await mergeAudit(list, {
    appId: req.appId,
    bizType: "checkin",
    bizId: (c) => c.checkin_id,
    texts: [{ field: "checkin_note", get: (c) => c.checkin_note }],
    media: [
      { field: "images", get: (c) => c.images },
      { field: "voice_url", get: (c) => c.voice_url },
      { field: "video_url", get: (c) => c.video_url },
      { field: "video_cover", get: (c) => c.video_cover },
    ],
  });
  // 今日概览：今天审核了多少条打卡（家长/家属/管理员待办卡片丰富展示用）
  const today0 = `${formatDate(new Date())} 00:00:00`;
  const todayReviewedQ = () => {
    const q = db.from("task_checkins").select("checkin_id").gte("reviewed_at", today0);
    if (scope !== null) return q.in("created_by", scope.map(Number).filter(n => Number.isInteger(n) && n > 0));
    return q;
  };
  const { data: todayRows } = await todayReviewedQ().limit(1000);
  res.json(ok({ type: "admin", count: list.length, total, page, pageSize, hasMore: offset + list.length < total, todayStats: { todayReviewed: (todayRows || []).length }, list }));
}

// ==================== 管理员审核打卡 ====================
// approve：审核通过 = 任务完成 + 评分 10 分；同任务其余待审核打卡自动关闭（任务从待办移除）
// reject：可填评分与审核说明，任务退回学生继续处理
// 审核完成后通过订阅消息给打卡提交人发送「审核结果通知」（失败不影响审核主流程）
// 注：本文件已有 notificationLib.notifyReviewResult（对象入参）导入，此处旧位置参数版本改名避免重名（并发编辑遗留，待外部 WIP 收敛）
async function notifyReviewResultLegacy(req, checkin, task, result, note) {
  try {
    // 多身份（共用微信）：该学生所有有效绑定 openid（家长手机 + 孩子手机）都通知
    const { data: stuRows } = await db.from("lp_students")
      .select("openid")
      .eq("staff_id", checkin.created_by)
      .eq("app_id", req.appId || "miniprogram-kxm")
      .eq("bound_status", 1)
      .limit(50);
    const openids = [...new Set((stuRows || []).map(r => r.openid).filter(Boolean))];
    for (const openid of openids) {
      await sendReviewNotification({
        appId: req.appId || "miniprogram-kxm",
        openid,
        staffId: checkin.created_by,
        checkinId: checkin.checkin_id,
        taskId: checkin.task_id,
        taskTitle: (task && task.title) || "",
        result,
        note,
      });
    }
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
    // 内容安全拦截：违规内容禁止审核通过（可驳回）
    if (act === "approve" && checkin.risk_status === "reject") {
      return res.json(fail("该打卡内容未通过安全检测，禁止审核通过"));
    }

    const { data: tRows } = await db.from("tasks")
      .select("task_id, title, task_status").eq("task_id", checkin.task_id).limit(1);
    const task = tRows && tRows[0];

    if (act === "approve") {
      // 审核通过 = 该学生打卡通过 +10 分；任务是否完成由「全部参与人是否都已通过」判定（按孩子独立完成）
      await db.from("task_checkins").update({
        review_status: "approved",
        review_score: 10,
        review_note: "",
        reviewer: staffId,
        reviewed_at: nowSql(),
      }).eq("checkin_id", cid);
      // 同任务同学生的其余待审核打卡自动关闭（该学生任务已完成，重复提交不再处理）；
      // 其他孩子的打卡保留待审，各自独立审核，不再一并关闭
      const { data: pendRows } = await db.from("task_checkins")
        .select("checkin_id").eq("task_id", checkin.task_id).eq("created_by", checkin.created_by).eq("review_status", "pending").limit(200);
      const pendIds = (pendRows || []).map(p => p.checkin_id).filter(id => Number(id) !== Number(cid));
      if (pendIds.length > 0) {
        await db.from("task_checkins").update({
          review_status: "rejected",
          review_note: "该学生本任务已审核通过，本条重复打卡不再处理",
          reviewer: staffId,
          reviewed_at: nowSql(),
        }).in("checkin_id", pendIds);
      }
      // 任务完成态：全部参与人（派发孩子/创建人）都已通过 → 任务完成；否则保持进行中
      const allDone = await taskAllRecipientsDone(checkin.task_id);
      const oldStatus = task ? task.task_status : "";
      let finalStatus = oldStatus;
      if (allDone) {
        if (oldStatus !== "done") {
          await db.from("tasks").update({ task_status: "done", score: 10, progress: 100, updated_at: nowSql() })
            .eq("task_id", checkin.task_id);
          finalStatus = "done";
        }
        // 积分账本：打卡审核通过 +10；任务全部完成 +30（幂等：按状态变迁判定）
        awardCheckinApproved(checkin, staffId).catch(() => {});
        if (task) applyTaskStatusPoints(task, oldStatus, "done", staffId).catch(() => {});
      } else {
        if (oldStatus === "todo") {
          await db.from("tasks").update({ task_status: "doing", progress: 50, updated_at: nowSql() })
            .eq("task_id", checkin.task_id);
          finalStatus = "doing";
        }
        // 打卡审核通过 +10（任务未完成，暂不加任务完成分）
        awardCheckinApproved(checkin, staffId).catch(() => {});
      }
      logTaskEvent({
        taskId: checkin.task_id, checkinId: cid, bizType: "task_checkin", eventType: "review_approve",
        eventName: "审核通过",
        summary: allDone
          ? `管理员审核通过打卡，任务「${task ? task.title : ""}」全部完成并得 10 分`
          : `管理员审核通过打卡「${task ? task.title : ""}」+10 分，等待其他孩子完成`,
        payload: { checkin_id: cid, task_status: finalStatus, score: 10, closed_pending: pendIds.length },
        staffId,
      });
      notifyReviewResultLegacy(req, checkin, task, "approve", "").catch(() => {});
      // 系统通知：审核通过 → 提交学生 + 家长/家属（审核人自己除外）
      notifyReviewResult({
        appId: req.appId,
        studentStaffId: checkin.created_by,
        taskTitle: (task && task.title) || "",
        score: 10,
        note: "",
        result: "approve",
        checkinId: checkin.checkin_id,
        actorStaffId: staffId,
      }).catch(() => {});
      res.json(ok(null, allDone ? "已通过，任务完成 +10 分" : "已通过 +10 分"));
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
      // 兜底：若任务显示已完成但实际仍有未完成孩子（旧数据/异常态），驳回后回退为进行中
      if (task && task.task_status === "done") {
        const stillDone = await taskAllRecipientsDone(checkin.task_id);
        if (!stillDone) {
          await db.from("tasks").update({ task_status: "doing", progress: 50, updated_at: nowSql() })
            .eq("task_id", task.task_id);
          // 积分账本：已完成任务回退 -30
          applyTaskStatusPoints(task, "done", "doing", staffId).catch(() => {});
        }
      }
      logTaskEvent({
        taskId: checkin.task_id, checkinId: cid, bizType: "task_checkin", eventType: "review_reject",
        eventName: "审核驳回",
        summary: `管理员驳回打卡「${task ? task.title : ""}」`,
        payload: { checkin_id: cid, score: s, note: String(note || "") },
        staffId,
      });
      notifyReviewResultLegacy(req, checkin, task, "reject", note).catch(() => {});
      // 系统通知：审核驳回 → 提交学生 + 家长/家属（审核人自己除外）
      notifyReviewResult({
        appId: req.appId,
        studentStaffId: checkin.created_by,
        taskTitle: (task && task.title) || "",
        score: s,
        note: String(note || ""),
        result: "reject",
        checkinId: checkin.checkin_id,
        actorStaffId: staffId,
      }).catch(() => {});
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
    const cfg = await getAppConfig(req.appId || "miniprogram-kxm");
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
        app_id: req.appId || "miniprogram-kxm",
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

// ==================== 系统通知（站内信，与订阅消息隔离） ====================
// 数据表：t_lp_notifications；模板：t_lp_notify_templates（后台「消息通知 → 通知模板」维护）。
// 按当前活动身份（staff_id）读取：共用微信多身份时，通知跟随当前切换的身份。
// 查看即已读：列表接口拉取「当前页」数据后静默标记该页已读（不整表全读），未读数随之减少。

/** 系统通知列表（分页）+ 未读数（拉取当前页后静默标记该页已读） */
router.get("/notifications", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const page = Math.max(1, Number((req.query && req.query.page) || 1));
    const pageSize = Math.min(Number((req.query && req.query.pageSize) || 20) || 20, 50);
    const offset = (page - 1) * pageSize;
    const scope = { staff_id: staffId, app_id: req.appId || "miniprogram-kxm" };

    // 分页列表
    let list = [];
    const base = () => db.from("notifications").select().eq("staff_id", staffId).eq("app_id", scope.app_id);
    const rangeRes = await base()
      .order("created_at", { ascending: false }).order("notify_id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (!rangeRes.error) {
      list = rangeRes.data || [];
    } else {
      const fetchLimit = Math.min(offset + pageSize, 2000);
      const { data: rows, error } = await base()
        .order("created_at", { ascending: false }).order("notify_id", { ascending: false })
        .limit(fetchLimit);
      if (error) throw error;
      list = (rows || []).slice(offset, offset + pageSize);
    }

    // 静默已读：仅把当前页的未读记录标记为已读（失败不阻塞列表返回）
    const unreadIds = (list || []).filter(n => Number(n.is_read) !== 1).map(n => n.notify_id);
    if (unreadIds.length > 0) {
      try {
        const { error } = await db.from("notifications")
          .update({ is_read: 1, read_at: nowSql() })
          .eq("staff_id", staffId)
          .in("notify_id", unreadIds);
        if (error) console.error("[lp] notifications silent read error", error);
      } catch (e) {
        console.error("[lp] notifications silent read error", e);
      }
    }

    // 未读数（在当前页静默已读之后统计，未读数不包含已读的当前页）
    let unread = 0;
    try {
      const { count, error } = await db.from("notifications")
        .select("notify_id", { count: "exact" })
        .eq("staff_id", staffId).eq("is_read", 0).limit(1);
      if (!error && typeof count === "number" && count >= 0) unread = count;
      else {
        const { data: urRows } = await db.from("notifications")
          .select("notify_id").eq("staff_id", staffId).eq("is_read", 0).limit(500);
        unread = (urRows || []).length;
      }
    } catch (_) { /* 未读数失败不回退整个列表 */ }

    res.json(ok({
      // 阅读状态返回「查看前」的原始值：本次进入后被静默标记已读，前端据此渲染未读高亮与已读态
      list: (list || []).map(n => ({
        notify_id: n.notify_id,
        type: n.type,
        title: n.title,
        content: n.content,
        biz_type: n.biz_type || "",
        biz_id: n.biz_id || "",
        is_read: Number(n.is_read) === 1 ? 1 : 0,
        read_at: n.read_at || "",
        created_at: n.created_at,
      })),
      unread,
      page,
      pageSize,
    }));
  } catch (e) {
    console.error("[lp] notifications list error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 未读数（轻量，供设置页角标轮询） */
router.get("/notifications/unread", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { count, error } = await db.from("notifications")
      .select("notify_id", { count: "exact" })
      .eq("staff_id", staffId).eq("is_read", 0).limit(1);
    if (!error && typeof count === "number" && count >= 0) {
      return res.json(ok({ count }));
    }
    const { data, error: e2 } = await db.from("notifications")
      .select("notify_id").eq("staff_id", staffId).eq("is_read", 0).limit(500);
    if (e2) throw e2;
    res.json(ok({ count: (data || []).length }));
  } catch (e) {
    console.error("[lp] notifications unread error", e);
    res.json(fail("服务异常", 500));
  }
});

/** 标记已读：body { id } 单条 / body { all:true } 全部已读 */
router.post("/notifications/read", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const { id, all } = req.body || {};
    const values = { is_read: 1, read_at: nowSql() };
    if (all) {
      const { error } = await db.from("notifications")
        .update(values).eq("staff_id", staffId).eq("is_read", 0);
      if (error) throw error;
      return res.json(ok(null, "已全部标记为已读"));
    }
    const nid = Number(id);
    if (!nid) return res.json(fail("缺少通知 ID"));
    const { error } = await db.from("notifications")
      .update(values).eq("notify_id", nid).eq("staff_id", staffId);
    if (error) throw error;
    res.json(ok(null, "已读"));
  } catch (e) {
    console.error("[lp] notifications read error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== TabBar 角标聚合 ====================
// 一次请求返回底部主菜单各 tab 的角标数，供 custom-tab-bar 渲染 Badge：
//   notifications：系统通知未读数（「我的」tab）
//   todos：待办数（「待办」tab）——学生=未完成任务；家长/家属/管理员=本家庭待审核打卡
// 每项单独容错：单项统计失败置 0，不影响其余角标与主流程。
// 高频轮询（custom-tab-bar 30s 一次 + 每次切页），结果做短 TTL（5s）缓存削峰，
// 并将 notifications/todos 两路统计并行执行，减少串行 RDB 往返延迟。
const BADGE_CACHE_TTL = 5000;

async function unreadNotifications(staffId) {
  try {
    const { count, error } = await db.from("notifications")
      .select("notify_id", { count: "exact" })
      .eq("staff_id", staffId).eq("is_read", 0).limit(1);
    return (!error && typeof count === "number" && count >= 0) ? count : 0;
  } catch (_) { return 0; }
}

async function pendingTodos(req, staffId, scope) {
  try {
    if (isManager(req)) {
      // 空 scope（家长/家属名下无孩子）直接为 0，避免空数组 in() 报错
      if (scope !== null && scope.length === 0) return 0;
      return await countRows("task_checkins", "checkin_id", (q) => {
        q = q.eq("review_status", "pending").neq("risk_status", "reject");
        if (scope !== null) q = q.in("created_by", scope.map(Number).filter(n => Number.isInteger(n) && n > 0));
        return q;
      });
    }
    const ids = await myTaskIds(staffId);
    if (ids.length === 0) return 0;
    return await countRows("tasks", "task_id", (q) =>
      q.in("task_id", ids).in("task_status", ["todo", "doing"]).in("risk_status", ["pass", "pending"]));
  } catch (_) { return 0; }
}

router.get("/badges", async (req, res) => {
  try {
    const staffId = Number(me(req));
    const role = (req.lp && req.lp.role) || "";
    const scope = myScope(req);
    const cacheKey = `badge:${staffId}:${role}:${scope === null ? "all" : (scope || []).join(",")}`;
    const result = await cached(cacheKey, async () => {
      const [notifications, todos] = await Promise.all([
        unreadNotifications(staffId),
        pendingTodos(req, staffId, scope),
      ]);
      return { notifications, todos };
    }, BADGE_CACHE_TTL);
    res.json(ok(result));
  } catch (e) {
    console.error("[lp] badges error", e);
    res.json(fail("服务异常", 500));
  }
});


// ==================== 合集（按 staff_id 归属，主家长/个人管理；家庭内共享） ====================
// 归属模型：合集由主家长（或独立个人）创建，staff_id=归属主；全家（主家长/家属/孩子）共享查看。
// 查询按 staff_id 过滤（admin 全部）；创建/编辑/删除仅归属主可操作。
router.get("/collections", async (req, res) => {
  try {
    const { page, pageSize, offset } = pageInfo(req);
    const owner = await familyOwnerStaffId(req);
    const applyFilters = (q) => ownerStaffEq(owner, q.eq("collection_status", 1));
    const [total, listRes] = await Promise.all([
      countRows("task_collections", "collection_id", applyFilters),
      applyFilters(db.from("task_collections").select())
        .order("collection_id", { ascending: true })
        .range(offset, offset + pageSize - 1),
    ]);
    const { data: rows, error } = listRes;
    if (error) throw error;
    const list0 = rows || [];
    if (list0.length === 0) return res.json(ok({ list: [], total, page, pageSize, hasMore: false }));
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
        staff_id: c.staff_id,
        _creatorNickname: c._creatorNickname || "",
      })),
      total,
      page,
      pageSize,
      hasMore: offset + list.length < total,
    }));
  } catch (e) {
    console.error("[lp] collections list error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collections/create", async (req, res) => {
  try {
    if (!canManageLearning(req)) return res.json(fail("仅主家长/家属/个人可管理合集", 403));
    const staffId = Number(me(req));
    if (!staffId) return res.json(fail("未登录", 401));
    const { name, description, cover_images } = req.body || {};
    const n = String(name || "").trim().slice(0, 100);
    if (!n) return res.json(fail("合集名称不能为空"));
    const ownerId = Number(await familyOwnerStaffId(req)) || staffId;
    const collectionId = await nextSeq("collection_id");
    await db.from("task_collections").insert({
      collection_id: collectionId,
      name: n,
      description: String(description || "").slice(0, 500),
      cover_images: JSON.stringify(Array.isArray(cover_images) ? cover_images.slice(0, 1) : []),
      task_count: 0,
      created_by: staffId,
      staff_id: ownerId,
      collection_status: 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    invalidateCollectionRows([collectionId]);
    logEvent({ appId: req.appId, openid: myOpenid(req), eventType: "create", eventName: "创建合集", pagePath: "/pkg-mine/learning-manage/learning-manage", bizId: String(collectionId) });
    res.json(ok({ collection_id: collectionId }, "创建成功"));
  } catch (e) {
    console.error("[lp] collection create error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collections/update", async (req, res) => {
  try {
    if (!canManageLearning(req)) return res.json(fail("仅主家长/家属/个人可管理合集", 403));
    const b = req.body || {};
    const id = Number(b.id);
    if (!id) return res.json(fail("缺少合集 ID"));
    const owner = await familyOwnerStaffId(req);
    const { data: rows } = await ownerStaffEq(owner, db.from("task_collections").select().eq("collection_id", id)).limit(1);
    if (!(rows && rows[0])) return res.json(fail("无权编辑该合集", 403));
    const values = { updated_at: nowSql() };
    if (b.name !== undefined) values.name = String(b.name).trim().slice(0, 100);
    if (b.description !== undefined) values.description = String(b.description).slice(0, 500);
    if (b.cover_images !== undefined) values.cover_images = JSON.stringify(Array.isArray(b.cover_images) ? b.cover_images.slice(0, 1) : []);
    await ownerStaffEq(owner, db.from("task_collections").update(values).eq("collection_id", id));
    invalidateCollectionRows([id]);
    res.json(ok(null, "更新成功"));
  } catch (e) {
    console.error("[lp] collection update error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/collections/delete", async (req, res) => {
  try {
    if (!canManageLearning(req)) return res.json(fail("仅主家长/家属/个人可管理合集", 403));
    const { id } = req.body || {};
    const cid = Number(id);
    if (!cid) return res.json(fail("缺少合集 ID"));
    const owner = await familyOwnerStaffId(req);
    const { data: rows } = await ownerStaffEq(owner, db.from("task_collections").select().eq("collection_id", cid)).limit(1);
    if (!(rows && rows[0])) return res.json(fail("无权删除该合集", 403));
    await db.from("tasks").update({ collection_id: 0, updated_at: nowSql() }).eq("collection_id", cid);
    await ownerStaffEq(owner, db.from("task_collections").delete().eq("collection_id", cid));
    invalidateCollectionRows([cid]);
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[lp] collection delete error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 科目（独立表 t_lp_subjects，按 staff_id 归属，主家长/个人管理） ====================
// 预置科目（subject_presets 系统参数，JSON 数组）供用户选择创建，不自动初始化。
const SUBJECT_PRESETS_DEFAULT = ["语文", "数学", "英语", "科学", "阅读", "写作", "作业", "运动", "音乐", "美术", "编程", "书法", "口语"];

/** 预置科目列表：优先读系统参数 subject_presets（JSON 数组），缺省回退内置默认 */
async function subjectPresets(req) {
  try {
    const map = await getParamsMap(req.appId || "miniprogram-kxm", ["subject_presets"]);
    const raw = map && map.subject_presets;
    if (raw) {
      const arr = Array.isArray(raw) ? raw : (() => {
        try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch (_) { return null; }
      })();
      if (Array.isArray(arr)) return arr.map(s => String(s).trim()).filter(Boolean).slice(0, 100);
    }
  } catch (_) { /* 读参数失败回退默认 */ }
  return SUBJECT_PRESETS_DEFAULT;
}

router.get("/subjects", async (req, res) => {
  try {
    const owner = await familyOwnerStaffId(req);
    const { data: rows, error } = await ownerStaffEq(owner, db.from("subjects").select())
      .order("sort", { ascending: true }).order("subject_id", { ascending: true }).limit(200);
    if (error) throw error;
    res.json(ok({
      list: (rows || []).map(s => ({
        subject_id: s.subject_id,
        name: s.name,
        color: s.color || "",
        sort: Number(s.sort) || 0,
        subject_status: s.subject_status,
        staff_id: s.staff_id,
      })),
    }));
  } catch (e) {
    console.error("[lp] subjects list error", e);
    res.json(fail("服务异常", 500));
  }
});

router.get("/subjects/presets", async (req, res) => {
  try {
    res.json(ok({ list: await subjectPresets(req) }));
  } catch (e) {
    console.error("[lp] subjects presets error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/subjects/create", async (req, res) => {
  try {
    if (!canManageLearning(req)) return res.json(fail("仅主家长/家属/个人可管理科目", 403));
    const staffId = Number(me(req));
    if (!staffId) return res.json(fail("未登录", 401));
    const b = req.body || {};
    const name = String(b.name || "").trim().slice(0, 32);
    if (!name) return res.json(fail("科目名称不能为空"));
    const ownerId = Number(await familyOwnerStaffId(req)) || staffId;
    // 同归属下科目名唯一（防重复创建/并发冲突）
    const { data: dup } = await db.from("subjects")
      .select("subject_id").eq("staff_id", ownerId).eq("name", name).limit(1);
    if (dup && dup[0]) return res.json(fail("该科目已存在，请勿重复创建"));
    const subjectId = await nextSeq("subject_id");
    const color = String(b.color || "").slice(0, 16);
    const sort = Math.max(0, Number(b.sort) || 0);
    await db.from("subjects").insert({
      subject_id: subjectId,
      staff_id: ownerId,
      name,
      color,
      sort,
      subject_status: b.subject_status === 0 ? 0 : 1,
      created_at: nowSql(),
      updated_at: nowSql(),
    });
    logEvent({ appId: req.appId, openid: myOpenid(req), eventType: "create", eventName: "创建科目", pagePath: "/pkg-mine/subjects/subjects", bizId: String(subjectId) });
    res.json(ok({ subject_id: subjectId }, "创建成功"));
  } catch (e) {
    console.error("[lp] subject create error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/subjects/update", async (req, res) => {
  try {
    if (!canManageLearning(req)) return res.json(fail("仅主家长/家属/个人可管理科目", 403));
    const b = req.body || {};
    const id = Number(b.id || b.subject_id);
    if (!id) return res.json(fail("缺少科目 ID"));
    const owner = await familyOwnerStaffId(req);
    const { data: rows } = await ownerStaffEq(owner, db.from("subjects").select().eq("subject_id", id)).limit(1);
    if (!(rows && rows[0])) return res.json(fail("无权编辑该科目", 403));
    const values = { updated_at: nowSql() };
    if (b.name !== undefined) values.name = String(b.name).trim().slice(0, 32);
    if (b.color !== undefined) values.color = String(b.color).slice(0, 16);
    if (b.sort !== undefined) values.sort = Math.max(0, Number(b.sort) || 0);
    if (b.subject_status !== undefined) values.subject_status = b.subject_status === 0 ? 0 : 1;
    if (!values.name) return res.json(fail("科目名称不能为空"));
    // 改名冲突校验：同归属下其它科目已占用该名称
    if (b.name !== undefined) {
      const { data: dup } = await db.from("subjects")
        .select("subject_id").eq("staff_id", rows[0].staff_id).eq("name", values.name)
        .neq("subject_id", id).limit(1);
      if (dup && dup[0]) return res.json(fail("该科目已存在，请勿重复创建"));
    }
    await ownerStaffEq(owner, db.from("subjects").update(values).eq("subject_id", id));
    res.json(ok(null, "更新成功"));
  } catch (e) {
    console.error("[lp] subject update error", e);
    res.json(fail("服务异常", 500));
  }
});

router.post("/subjects/delete", async (req, res) => {
  try {
    if (!canManageLearning(req)) return res.json(fail("仅主家长/家属/个人可管理科目", 403));
    const { id } = req.body || {};
    const sid = Number(id);
    if (!sid) return res.json(fail("缺少科目 ID"));
    const owner = await familyOwnerStaffId(req);
    const { data: rows } = await ownerStaffEq(owner, db.from("subjects").select().eq("subject_id", sid)).limit(1);
    if (!(rows && rows[0])) return res.json(fail("无权删除该科目", 403));
    await ownerStaffEq(owner, db.from("subjects").delete().eq("subject_id", sid));
    res.json(ok(null, "已删除"));
  } catch (e) {
    console.error("[lp] subject delete error", e);
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
    // 视频体积大走 wx.cloud.uploadFile 直传 + /api/storage/upload 登记，不接 base64
    if (bizName === "videos") return res.json(fail("视频请通过直传上传"));

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
      const isVoice = String(bizName) === "voice";
      if (isVoice) {
        // 语音打卡：接受音频 contentType，未知一律 audio/mpeg
        if (!/^audio\//i.test(contentType)) contentType = "audio/mpeg";
      } else if (/image\/png/i.test(contentType)) contentType = "image/png";
      else if (/image\/webp/i.test(contentType)) contentType = "image/webp";
      else contentType = "image/jpeg";

      const buffer = Buffer.from(b64, "base64");
      const fileObj = await uploadImage({ biz: bizName, buffer, contentType, fileName: String(f.fileName || ""), compress: !isVoice });
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
// 高频入口（首页每次 onShow/下拉刷新），结果做短 TTL（10s）缓存削峰；
// 徽章解锁/积分余额均已快照化，缓存期间短暂延迟对用户无感。
const DASH_CACHE_TTL = 10000;

async function buildDashboard(req, staffId) {
  // 当前视角学员信息（管理员/家长/家属查看孩子时，卡片抬头展示被查看的孩子本人）
  let viewed = null;
  try {
    const { data: vRows } = await db.from("staff")
      .select("staff_id, staff_nickname, staff_username")
      .eq("staff_id", staffId).limit(1);
    const v = vRows && vRows[0];
    if (v) viewed = { staff_id: String(v.staff_id), nickname: v.staff_nickname || v.staff_username || "同学" };
  } catch (_) { /* 取不到名字时回退默认文案 */ }
  const ids = await myTaskIds(String(staffId));

    const taskQ = ids.length > 0 ? db.from("tasks").select().in("task_id", ids).in("risk_status", ["pass", "pending"]).limit(2000) : Promise.resolve({ data: [], error: null });
    const checkinQ = ids.length > 0 ? db.from("task_checkins").select().in("task_id", ids).limit(2000) : Promise.resolve({ data: [], error: null });
    const recentQ = ids.length > 0 ? db.from("task_checkins").select().order("created_at", { ascending: false }).in("task_id", ids).in("risk_status", ["pass", "pending"]).limit(100) : Promise.resolve({ data: [], error: null });
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

    // 游戏化：经验值来自积分账本（审核通过+10/完成任务+30，删除与回退自动扣分）
    const xp = await staffPoints(staffId);
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
      { name: "待完成", value: todoCount, color: "#f5222d" },
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

    // 成就徽章解锁落库：新解锁徽章记录解锁时间（可审计、奖章墙展示）
    const badgeUnlockMap = await syncBadgeUnlocks(
      staffId,
      badges.filter(b => b.unlocked).map(b => b.key)
    );
    const badgesWithTime = badges.map(b => (b.unlocked ? { ...b, unlocked_at: badgeUnlockMap[b.key] || "" } : b));

    const reminders = buildLearningReminders({
      todayCheckedIn, todayCheckins, currentStreak, completionRate,
      doneCount, totalTasks, remainingCount: totalTasks - doneCount,
      activeCount: doingCount, overdueCount, dueSoonCount,
      nextBadge: badgesWithTime.find(b => !b.unlocked) || null,
    });

    // 最近打卡（含任务标题）
    const taskTitleMap = {};
    tasks.forEach(t => { taskTitleMap[t.task_id] = t.title; });
    let recentCheckinList = recentCheckins.filter(c => liveTaskIds.has(String(c.task_id))).slice(0, 15).map(c => ({
      checkin_id: String(c.checkin_id),
      task_id: c.task_id,
      task_title: taskTitleMap[c.task_id] || "(任务已删除)",
      checkin_date: c.checkin_date,
      note: c.checkin_note,
      has_images: parseImgList(c.checkin_images).length > 0,
      checkin_type: normalizeCheckinType(c.checkin_type),
      source: normalizeTaskSource(c.source, "miniprogram"),
      voice_url: c.voice_url || "",
      voice_duration: Number(c.voice_duration) || 0,
      video_url: c.video_url || "",
      video_duration: Number(c.video_duration) || 0,
      video_size: Number(c.video_size) || 0,
      video_cover: c.video_cover || "",
      risk_status: c.risk_status || "pending",
      created_at: c.created_at,
    }));
    // 内容安全：读时派生展示级别（关闭/失败=透传，前端零感知）
    recentCheckinList = await mergeAudit(recentCheckinList, {
      appId: req.appId,
      bizType: "checkin",
      bizId: (c) => c.checkin_id,
      texts: [{ field: "checkin_note", get: (c) => c.note }],
      media: [
        { field: "voice_url", get: (c) => c.voice_url },
        { field: "video_url", get: (c) => c.video_url },
        { field: "video_cover", get: (c) => c.video_cover },
      ],
    });

  return {
    staff: viewed || { staff_id: String(staffId), nickname: "同学" },
    stats: { totalTasks, todoCount, doingCount, doneCount, totalCheckins, todayCheckins, todayCheckedIn, completionRate },
    level,
    streak: { current: currentStreak, max: maxStreak, todayCheckedIn },
    badges: badgesWithTime,
    days,
    subjectDist,
    statusDist,
    taskRank,
    reminders,
    recentCheckinList,
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    const staffId = Number(await viewStaffId(req));
    const result = await cached(`dash:${staffId}`, () => buildDashboard(req, staffId), DASH_CACHE_TTL);
    res.json(ok(result));
  } catch (e) {
    console.error("[lp] dashboard error", e);
    res.json(fail("服务异常", 500));
  }
});

// ==================== 接口链路：前端上报补全耗时 ====================
router.post("/reportTrace", (req, res) => {
  const { requestId, clientCostMs } = req.body || {};
  if (!requestId || clientCostMs == null) return res.json(fail("缺少参数"));
  reportTrace(requestId, clientCostMs);
  res.json(ok(null, "已记录"));
});

// ==================== 数据上报（session / 事件，写入共享 user_sessions / user_events） ====================
// 课小满无云服务，session/事件经 /api/lp/* 上报；身份取 LP JWT（req.lp.openid），app_id=miniprogram-kxm
router.post("/collectSession", (req, res) => {
  logSession({ appId: req.appId, openid: myOpenid(req), session: req.body.session || {} });
  res.json(ok(null, "已上报"));
});

router.post("/collectEvent", (req, res) => {
  const { eventType, eventName, pagePath, bizId, extra } = req.body || {};
  if (!eventType || !eventName) return res.json(fail("缺少事件参数"));
  logEvent({
    appId: req.appId,
    openid: myOpenid(req),
    eventType,
    eventName,
    pagePath,
    bizId,
    extra,
  });
  res.json(ok(null, "已记录"));
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
