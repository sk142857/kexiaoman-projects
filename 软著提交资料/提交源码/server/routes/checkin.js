/**
 * 打卡路由模块
 * 提供任务打卡的提交、查询与审核管理。
 */
const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { authRequired } = require('../middleware/auth');
const checkinService = require('../services/checkinService');

const router = express.Router();

/**
 * 提交打卡
 * POST /api/checkin/create
 */
router.post('/create', authRequired, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.taskId) return res.json(fail('任务ID不能为空'));

    const checkinId = await checkinService.createCheckin(body, req.user);
    return res.json(ok({ checkinId }, '打卡成功'));
  } catch (e) {
    return res.json(fail('打卡提交失败', 500));
  }
});

/**
 * 打卡列表（按任务）
 * GET /api/checkin/list
 */
router.get('/list', authRequired, async (req, res) => {
  try {
    const taskId = req.query.taskId;
    const studentId = req.query.studentId;
    const status = req.query.status;
    const conds = [];
    const params = [];
    if (taskId) {
      conds.push('task_id = ?');
      params.push(taskId);
    }
    if (studentId) {
      conds.push('student_id = ?');
      params.push(studentId);
    }
    if (status) {
      conds.push('audit_status = ?');
      params.push(status);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await db.query(`SELECT * FROM t_checkin ${where} ORDER BY checkin_date DESC`, params);
    return res.json(ok(rows));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 打卡详情
 * GET /api/checkin/detail/:id
 */
router.get('/detail/:id', authRequired, async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM t_checkin WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.json(fail('打卡记录不存在', 404));
    return res.json(ok(rows[0]));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 审核打卡（家长/管理员）
 * POST /api/checkin/review/:id
 */
router.post('/review/:id', authRequired, async (req, res) => {
  try {
    const { result, remark } = req.body || {};
    if (!['approved', 'rejected'].includes(result)) {
      return res.json(fail('审核结果非法'));
    }
    await db.query(
      'UPDATE t_checkin SET audit_status = ?, audit_remark = ?, auditor_id = ?, audited_at = NOW() WHERE id = ?',
      [result, remark || '', req.user.id, req.params.id]
    );
    return res.json(ok(null, '审核完成'));
  } catch (e) {
    return res.json(fail('审核失败', 500));
  }
});

/**
 * 删除打卡
 * POST /api/checkin/delete/:id
 */
router.post('/delete/:id', authRequired, async (req, res) => {
  try {
    await db.query('DELETE FROM t_checkin WHERE id = ?', [req.params.id]);
    return res.json(ok(null, '删除成功'));
  } catch (e) {
    return res.json(fail('删除失败', 500));
  }
});

module.exports = router;
