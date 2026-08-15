/**
 * 打卡提醒定时任务（订阅消息业务事件：定时推送）
 *
 * 推送时机设计（合理、避免打扰）：
 *  - 每天在「提醒窗口」（默认 18:00-22:00，t_apps.reminder_window 可配）内定时运行；
 *    非窗口时间静默跳过，不产生任何发送。
 *  - 只提醒「当天需要处理」的任务：任务未完成，且截止日在
 *    [今天 - reminder_overdue_days(默认7) , 今天 + reminder_days(默认3)] 区间（含逾期未完成）。
 *  - 该任务今天该学生还没有打卡（无待审核/已通过的今日打卡）才提醒。
 *  - 同一学生同一任务每天最多提醒 1 次（按 t_lp_subscribe_sends 发送记录按天去重）。
 *  - 仅在有该模板订阅次数时发送；次数不足记录 skip，不打扰。
 *
 * 触发方式：server.js 启动时调用 startReminder()，每 30 分钟运行一次（进程内定时器，
 * 云托管实例常驻时生效；多实例时靠发送记录去重兜底）。
 */
const { db } = require("./db");
const { formatDate } = require("./utils");
const { getAppConfig } = require("./apps");
const { sendCheckinRemind } = require("./subscribeLib");

const APP_ID = "miniprogram-kxm";
const DEFAULT_WINDOW = "18:00-22:00";
const DEFAULT_REMIND_DAYS = 3;
const DEFAULT_OVERDUE_DAYS = 7;

let _running = false;

function pad(n) { return String(n).padStart(2, "0"); }
function todayStr() { return formatDate(new Date()); }
function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}
function parseWindow(w) {
  const m = String(w || "").match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return { start: DEFAULT_WINDOW.split("-")[0].trim(), end: DEFAULT_WINDOW.split("-")[1].trim() };
  return { start: `${pad(+m[1])}:${m[2]}`, end: `${pad(+m[3])}:${m[4]}` };
}

/** 执行一轮打卡提醒扫描 */
async function runOnce() {
  const cfg = await getAppConfig(APP_ID);
  if (!cfg || !cfg.wechat_appid) {
    console.log("[reminder] 课小满未配置，跳过打卡提醒");
    return;
  }
  const w = parseWindow(cfg.reminder_window);
  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (hhmm < w.start || hhmm > w.end) {
    // 非提醒窗口：静默跳过
    return;
  }

  const today = todayStr();
  const remindDays = Number(cfg.reminder_days) || DEFAULT_REMIND_DAYS;
  const overdueDays = Number(cfg.reminder_overdue_days) || DEFAULT_OVERDUE_DAYS;
  const startDate = shiftDate(today, -overdueDays);
  const endDate = shiftDate(today, remindDays);

  // 1. 已绑定学生（有 openid）
  const { data: binds } = await db.from("lp_students")
    .select("staff_id, openid").eq("app_id", APP_ID).eq("bound_status", 1).limit(5000);
  const openidMap = {};
  (binds || []).forEach(b => { openidMap[String(b.staff_id)] = b.openid || ""; });
  const staffIds = Object.keys(openidMap).map(Number).filter(Boolean);
  if (staffIds.length === 0) return;

  // 2. 学生昵称
  const { data: staffRows } = await db.from("staff")
    .select("staff_id, staff_nickname, staff_username").in("staff_id", staffIds).limit(staffIds.length);
  const nickMap = {};
  (staffRows || []).forEach(s => { nickMap[String(s.staff_id)] = s.staff_nickname || s.staff_username || ""; });

  // 3. 任务范围（派发给我 + 我创建）
  const [assignR, ownR] = await Promise.all([
    db.from("task_assignees").select("task_id, staff_id").in("staff_id", staffIds).limit(5000),
    db.from("tasks").select("task_id, task_status, created_by").in("created_by", staffIds).limit(5000),
  ]);
  const taskIds = new Set();
  const myTasks = {};
  const addTask = (sid, tid) => {
    if (!sid || !tid) return;
    taskIds.add(Number(tid));
    (myTasks[String(sid)] = myTasks[String(sid)] || new Set()).add(Number(tid));
  };
  (assignR.data || []).forEach(a => addTask(a.staff_id, a.task_id));
  (ownR.data || []).forEach(t => addTask(t.created_by, t.task_id));

  // 4. 任务信息
  const taskMap = {};
  if (taskIds.size > 0) {
    const { data: tRows } = await db.from("tasks")
      .select("task_id, title, task_status, deadline, checkin_count")
      .in("task_id", [...taskIds]).limit(taskIds.size);
    (tRows || []).forEach(t => { taskMap[Number(t.task_id)] = t; });
  }

  // 5. 今天已打卡（待审核/已通过）的任务集合
  const { data: todayChk } = await db.from("task_checkins")
    .select("task_id, created_by").eq("checkin_date", today)
    .in("created_by", staffIds).in("review_status", ["pending", "approved"]).limit(5000);
  const todayDone = new Set();
  (todayChk || []).forEach(c => todayDone.add(`${String(c.created_by)}:${Number(c.task_id)}`));

  // 6. 今天已发过提醒（按天去重）
  const { data: sentRows } = await db.from("subscribe_sends")
    .select("staff_id, biz_id").eq("event_type", "checkin_remind")
    .eq("app_id", APP_ID).gte("created_at", `${today} 00:00:00`).limit(5000);
  const sentToday = new Set();
  (sentRows || []).forEach(s => sentToday.add(`${String(s.staff_id)}:${String(s.biz_id)}`));

  // 7. 扫描候选并发提醒
  let candidates = 0, sent = 0, skipped = 0;
  for (const [sidStr, openid] of Object.entries(openidMap)) {
    const sid = Number(sidStr);
    const mySet = myTasks[sidStr] || new Set();
    for (const tid of mySet) {
      const t = taskMap[tid];
      if (!t || t.task_status === "done") continue;
      const dl = String(t.deadline || "").slice(0, 10);
      if (!dl || dl < startDate || dl > endDate) continue;
      if (todayDone.has(`${sidStr}:${tid}`) || sentToday.has(`${sidStr}:${tid}`)) continue;
      candidates += 1;
      const res = await sendCheckinRemind({
        appId: APP_ID,
        openid,
        staffId: sid,
        taskId: tid,
        taskTitle: t.title,
        deadline: dl,
        checkinCount: t.checkin_count || 0,
        nickname: nickMap[sidStr] || "",
      });
      if (res && res.skipped) skipped += 1; else sent += 1;
    }
  }
  console.log(`[reminder] ${today} ${hhmm} 窗口 ${w.start}-${w.end} | 候选 ${candidates} 已发送 ${sent} 跳过 ${skipped}`);
}

/** 定时入口（进程内互斥，防止重入） */
async function runReminder() {
  if (_running) return;
  _running = true;
  try {
    await runOnce();
  } catch (e) {
    console.error("[reminder] 任务异常", e);
  } finally {
    _running = false;
  }
}

/** 启动打卡提醒定时任务（默认每 30 分钟） */
function startReminder(intervalMs = 30 * 60 * 1000) {
  setTimeout(runReminder, 15 * 1000);
  setInterval(runReminder, intervalMs);
}

module.exports = { runReminder, startReminder };
