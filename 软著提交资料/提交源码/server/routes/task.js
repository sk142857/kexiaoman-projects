/**
 * 任务路由模块
 * 提供学习任务的增删改查、状态流转与派发管理。
 */
const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { authRequired } = require('../middleware/auth');
const taskService = require('../services/taskService');

const router = express.Router();

/**
 * 任务列表（支持分页与状态筛选）
 * GET /api/task/list
 */
router.get('/list', authRequired, async (req, res) => {
  try {
    const pageNo = Math.max(parseInt(req.query.pageNo, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const status = req.query.status;
    const subject = req.query.subject;
    const keyword = req.query.keyword;

    const conds = [];
    const params = [];
    if (status) {
      conds.push('t.status = ?');
      params.push(status);
    }
    if (subject) {
      conds.push('t.subject = ?');
      params.push(subject);
    }
    if (keyword) {
      conds.push('(t.title LIKE ? OR t.description LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (req.user.role !== 'admin') {
      conds.push('(t.creator_id = ? OR EXISTS (SELECT 1 FROM t_task_assignee a WHERE a.task_id = t.id AND a.student_id = ?))');
      params.push(req.user.id, req.user.id);
    }

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (pageNo - 1) * pageSize;

    const countRows = await db.query(`SELECT COUNT(*) AS total FROM t_task t ${where}`, params);
    const total = countRows[0] ? countRows[0].total : 0;
    const list = await db.query(
      `SELECT t.*, u.name AS creator_name
         FROM t_task t
         LEFT JOIN t_user u ON u.id = t.creator_id
         ${where}
         ORDER BY t.created_at DESC
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json(ok({ list, total, pageNo, pageSize }));
  } catch (e) {
    return res.json(fail('查询任务失败', 500));
  }
});

/**
 * 任务详情
 * GET /api/task/detail/:id
 */
router.get('/detail/:id', authRequired, async (req, res) => {
  try {
    const task = await taskService.getTaskDetail(req.params.id);
    if (!task) return res.json(fail('任务不存在', 404));
    return res.json(ok(task));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 创建任务
 * POST /api/task/create
 */
router.post('/create', authRequired, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.title) return res.json(fail('任务标题不能为空'));

    const taskId = await taskService.createTask(body, req.user);
    return res.json(ok({ taskId }, '创建成功'));
  } catch (e) {
    return res.json(fail('创建失败', 500));
  }
});

/**
 * 更新任务
 * POST /api/task/update/:id
 */
router.post('/update/:id', authRequired, async (req, res) => {
  try {
    const ok1 = await taskService.updateTask(req.params.id, req.body || {}, req.user);
    if (!ok1) return res.json(fail('任务不存在或无权限', 404));
    return res.json(ok(null, '保存成功'));
  } catch (e) {
    return res.json(fail('更新失败', 500));
  }
});

/**
 * 删除任务
 * POST /api/task/delete/:id
 */
router.post('/delete/:id', authRequired, async (req, res) => {
  try {
    const ok1 = await taskService.deleteTask(req.params.id, req.user);
    if (!ok1) return res.json(fail('任务不存在或无权限', 404));
    return res.json(ok(null, '删除成功'));
  } catch (e) {
    return res.json(fail('删除失败', 500));
  }
});

/**
 * 更新任务状态（todo / doing / done）
 * POST /api/task/status/:id
 */
router.post('/status/:id', authRequired, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['todo', 'doing', 'done'].includes(status)) {
      return res.json(fail('状态值非法'));
    }
    await db.query('UPDATE t_task SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
    return res.json(ok(null, '状态更新成功'));
  } catch (e) {
    return res.json(fail('更新失败', 500));
  }
});

module.exports = router;
