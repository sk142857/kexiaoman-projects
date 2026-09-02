/**
 * 打卡服务模块
 * 封装打卡提交与自动加分逻辑。
 */
const db = require('../db');
const { transaction } = require('../db');
const pointService = require('./pointService');

async function createCheckin(body, user) {
  const { taskId, checkinDate, note, images, voiceUrl } = body;
  return transaction(async (conn) => {
    const result = await conn.execute(
      `INSERT INTO t_checkin (task_id, student_id, checkin_date, note, images, voice_url, audit_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [taskId, user.id, checkinDate, note || '', JSON.stringify(images || []), voiceUrl || null]
    );
    const checkinId = result[0].insertId;

    // 任务首次打卡后自动流转为进行中
    await conn.execute(
      "UPDATE t_task SET status = 'doing', updated_at = NOW() WHERE id = ? AND status = 'todo'",
      [taskId]
    );

    // 家长/管理员提交的打卡自动审核通过
    if (['parent', 'admin'].includes(user.role)) {
      await conn.execute(
        "UPDATE t_checkin SET audit_status = 'approved', auditor_id = ?, audited_at = NOW() WHERE id = ?",
        [user.id, checkinId]
      );
      await pointService.grantForCheckin(conn, user.id, checkinId);
    }
    return checkinId;
  });
}

async function approveCheckin(conn, checkinId, auditorId) {
  await conn.execute(
    "UPDATE t_checkin SET audit_status = 'approved', auditor_id = ?, audited_at = NOW() WHERE id = ?",
    [auditorId, checkinId]
  );
}

async function getByTaskAndDate(taskId, studentId, date) {
  const rows = await db.query(
    'SELECT * FROM t_checkin WHERE task_id = ? AND student_id = ? AND checkin_date = ?',
    [taskId, studentId, date]
  );
  return rows[0] || null;
}

module.exports = { createCheckin, approveCheckin, getByTaskAndDate };
