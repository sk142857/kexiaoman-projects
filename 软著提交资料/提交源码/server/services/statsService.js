/**
 * 统计服务模块
 * 汇总学习仪表盘所需的各项统计指标。
 */
const db = require('../db');

async function studentStats(studentId) {
  const [taskTotal, doneTotal, checkinTotal, approvedTotal] = await Promise.all([
    db.query('SELECT COUNT(*) AS c FROM t_task_assignee WHERE student_id = ?', [studentId]),
    db.query(
      "SELECT COUNT(*) AS c FROM t_task_assignee a JOIN t_task t ON t.id = a.task_id WHERE a.student_id = ? AND t.status = 'done'",
      [studentId]
    ),
    db.query('SELECT COUNT(*) AS c FROM t_checkin WHERE student_id = ?', [studentId]),
    db.query(
      "SELECT COUNT(*) AS c FROM t_checkin WHERE student_id = ? AND audit_status = 'approved'",
      [studentId]
    )
  ]);
  return {
    taskTotal: taskTotal[0].c,
    doneTotal: doneTotal[0].c,
    checkinTotal: checkinTotal[0].c,
    approvedTotal: approvedTotal[0].c
  };
}

async function weeklyTrend(studentId, days = 7) {
  const since = new Date(Date.now() - days * 86400000);
  const sinceKey = since.toISOString().slice(0, 10);
  const rows = await db.query(
    `SELECT checkin_date, COUNT(*) AS cnt FROM t_checkin
      WHERE student_id = ? AND checkin_date >= ? AND audit_status = 'approved'
      GROUP BY checkin_date ORDER BY checkin_date`,
    [studentId, sinceKey]
  );
  return rows;
}

async function subjectDistribution(studentId) {
  const rows = await db.query(
    `SELECT t.subject, COUNT(*) AS cnt
       FROM t_task_assignee a
       JOIN t_task t ON t.id = a.task_id
      WHERE a.student_id = ? AND t.subject IS NOT NULL
      GROUP BY t.subject`,
    [studentId]
  );
  return rows;
}

module.exports = { studentStats, weeklyTrend, subjectDistribution };
