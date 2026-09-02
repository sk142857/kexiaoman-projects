/**
 * 任务业务时间轴：任务/打卡全生命周期事件写入工具
 * 记录任务创建、更新、完成、删除以及任务打卡新增/修改/删除等事件，
 * 供后台「任务管理 / 打卡管理」操作列的时间轴抽屉展示与审计追溯。
 * fire-and-forget 写库，失败静默，不影响业务主流程。
 */
const { db } = require("./db");
const { nowSql } = require("./utils");
const { nextSeq } = require("./seq");

/**
 * 写入一条任务时间轴事件
 * @param {object} opts
 *  - taskId: 关联任务 ID
 *  - checkinId: 关联打卡 ID（0=任务级事件）
 *  - bizType: task / task_checkin
 *  - eventType: create/update/delete/done/checkin/checkin_update/checkin_delete
 *  - eventName: 事件中文名（如 创建任务 / 任务打卡）
 *  - summary: 事件摘要文案
 *  - payload: 事件详情对象（修改前后值、打卡图片等）
 *  - staffId: 操作人 staff_id
 */
async function logTaskEvent({ taskId, checkinId, bizType, eventType, eventName, summary, payload, staffId }) {
  try {
    const metric = {
      event_id: await nextSeq("task_timeline_event_id"),
      task_id: Number(taskId) || 0,
      checkin_id: Number(checkinId) || 0,
      biz_type: bizType || "task",
      event_type: String(eventType || "").slice(0, 24),
      event_name: String(eventName || "").slice(0, 64),
      summary: String(summary || "").slice(0, 255),
      payload: payload ? JSON.stringify(payload) : null,
      created_by: Number(staffId) || 0,
      created_at: nowSql(),
    };
    const { error } = await db.from("task_timeline").insert(metric);
    if (error) throw error;
  } catch (e) {
    console.error("[taskTimeline] 写入失败", e);
  }
}

module.exports = { logTaskEvent };
