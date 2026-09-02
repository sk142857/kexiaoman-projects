/**
 * 积分服务模块
 * 积分账本式管理：每次变动写一条流水，余额从账本累加。
 */
const db = require('../db');

const LEVELS = [
  { level: 1, xp: 0 },
  { level: 2, xp: 50 },
  { level: 3, xp: 150 },
  { level: 4, xp: 300 },
  { level: 5, xp: 500 },
  { level: 6, xp: 800 },
  { level: 7, xp: 1200 },
  { level: 8, xp: 1800 },
  { level: 9, xp: 2500 },
  { level: 10, xp: 3200 }
];

function levelOf(xp) {
  let lv = LEVELS[0];
  for (const item of LEVELS) {
    if (xp >= item.xp) lv = item;
    else break;
  }
  return lv;
}

async function addLog(conn, studentId, delta, reason, remark) {
  await conn.execute(
    'INSERT INTO t_point_log (student_id, delta, reason, remark, created_at) VALUES (?, ?, ?, ?, NOW())',
    [studentId, delta, reason, remark || '']
  );
}

async function adjust(studentId, delta, reason, operatorId) {
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    await addLog(conn, studentId, delta, reason, `operator:${operatorId}`);
    await syncBalance(conn, studentId);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function syncBalance(conn, studentId) {
  const rows = await conn.execute(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM t_point_log WHERE student_id = ?',
    [studentId]
  );
  const total = rows[0][0].total;
  await conn.execute(
    `INSERT INTO t_student_profile (student_id, xp) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE xp = VALUES(xp)`,
    [studentId, total]
  );
}

async function grantForCheckin(conn, studentId, checkinId) {
  await addLog(conn, studentId, 10, 'checkin_approved', `checkin:${checkinId}`);
  await syncBalance(conn, studentId);
}

module.exports = { levelOf, adjust, addLog, grantForCheckin, syncBalance };
