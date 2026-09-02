/**
 * 连续打卡服务模块
 * 计算学生连续打卡天数，并在达标时触发徽章解锁。
 */
const db = require('../db');
const { transaction } = require('../db');

/**
 * 计算连续打卡天数（按打卡记录倒序扫描）
 */
async function calcStreak(studentId) {
  const rows = await db.query(
    `SELECT DISTINCT checkin_date FROM t_checkin
      WHERE student_id = ? AND audit_status = 'approved'
      ORDER BY checkin_date DESC`,
    [studentId]
  );
  const dates = rows.map((r) => r.checkin_date);
  if (dates.length === 0) return 0;

  let streak = 1;
  const today = new Date();
  const todayKey = dateKey(today);
  let prev = dates[0];
  if (prev !== todayKey) {
    const yesterdayKey = dateKey(new Date(today.getTime() - 86400000));
    if (prev !== yesterdayKey) return 0;
  }
  for (let i = 1; i < dates.length; i++) {
    const diff = dayDiff(dates[i - 1], dates[i]);
    if (diff === 1) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayDiff(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db2 = new Date(b + 'T00:00:00');
  return Math.round((db2 - da) / 86400000);
}

/**
 * 更新学生连续打卡天数
 */
async function updateStreak(studentId) {
  const streak = await calcStreak(studentId);
  await db.query(
    'UPDATE t_student_profile SET streak = ? WHERE student_id = ?',
    [streak, studentId]
  );
  return streak;
}

/**
 * 连续打卡达标解锁徽章
 */
async function unlockStreakBadge(studentId, streak) {
  const keys = {
    7: 'seven_days',
    21: 'three_weeks',
    30: 'month_master'
  };
  const key = keys[streak];
  if (!key) return;
  await transaction(async (conn) => {
    await conn.execute(
      'INSERT IGNORE INTO t_badge_unlock (student_id, badge_key) VALUES (?, ?)',
      [studentId, key]
    );
  });
}

module.exports = { calcStreak, updateStreak, unlockStreakBadge };
