/**
 * 任务服务模块
 * 封装任务创建、更新、删除等核心业务逻辑。
 */
const db = require('../db');
const { transaction } = require('../db');

const STATUS = ['todo', 'doing', 'done'];

async function getTaskDetail(id) {
  const rows = await db.query(
    `SELECT t.*, u.name AS creator_name
       FROM t_task t
       LEFT JOIN t_user u ON u.id = t.creator_id
      WHERE t.id = ?`,
    [id]
  );
  if (rows.length === 0) return null;
  const task = rows[0];
  const assignees = await db.query(
    `SELECT u.id, u.name FROM t_task_assignee a JOIN t_user u ON u.id = a.student_id WHERE a.task_id = ?`,
    [id]
  );
  task.assignees = assignees;
  return task;
}

async function createTask(body, user) {
  const {
    title, subject, description, startDate, deadline,
    score, images, assigneeIds = []
  } = body;

  return transaction(async (conn) => {
    const result = await conn.execute(
      `INSERT INTO t_task (title, subject, description, start_date, deadline, score, images, status, creator_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, NOW(), NOW())`,
      [title, subject, description || '', startDate, deadline, score || 0, JSON.stringify(images || []), user.id]
    );
    const taskId = result[0].insertId;

    const students = user.role === 'admin' && assigneeIds.length > 0 ? assigneeIds : [user.id];
    for (const sid of students) {
      await conn.execute('INSERT INTO t_task_assignee (task_id, student_id) VALUES (?, ?)', [taskId, sid]);
    }
    return taskId;
  });
}

async function updateTask(id, body, user) {
  const fields = [];
  const params = [];
  const allowMap = {
    title: body.title,
    subject: body.subject,
    description: body.description,
    startDate: body.startDate,
    deadline: body.deadline,
    score: body.score,
    status: body.status,
    images: body.images === undefined ? undefined : JSON.stringify(body.images)
  };
  for (const [key, val] of Object.entries(allowMap)) {
    if (val !== undefined && val !== null) {
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (fields.length === 0) return true;

  const rows = await db.query('SELECT creator_id FROM t_task WHERE id = ?', [id]);
  if (rows.length === 0) return false;
  if (user.role !== 'admin' && rows[0].creator_id !== user.id) return false;

  params.push(id);
  await db.query(`UPDATE t_task SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  return true;
}

async function deleteTask(id, user) {
  const rows = await db.query('SELECT creator_id FROM t_task WHERE id = ?', [id]);
  if (rows.length === 0) return false;
  if (user.role !== 'admin' && rows[0].creator_id !== user.id) return false;

  await transaction(async (conn) => {
    await conn.execute('DELETE FROM t_task_assignee WHERE task_id = ?', [id]);
    await conn.execute('DELETE FROM t_checkin WHERE task_id = ?', [id]);
    await conn.execute('DELETE FROM t_task WHERE id = ?', [id]);
  });
  return true;
}

module.exports = { getTaskDetail, createTask, updateTask, deleteTask, STATUS };
