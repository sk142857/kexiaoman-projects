/**
 * 管理后台路由模块
 * 提供用户管理、任务统计与基础数据维护接口。
 */
const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, adminOnly);

/**
 * 用户列表（分页 + 关键字搜索）
 * GET /api/admin/user/list
 */
router.get('/user/list', async (req, res) => {
  try {
    const pageNo = Math.max(parseInt(req.query.pageNo, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const keyword = req.query.keyword;
    const params = [];
    let where = '';
    if (keyword) {
      where = 'WHERE name LIKE ? OR account LIKE ?';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    const totalRows = await db.query(`SELECT COUNT(*) AS total FROM t_user ${where}`, params);
    const offset = (pageNo - 1) * pageSize;
    const list = await db.query(
      `SELECT id, account, name, role, status, created_at FROM t_user ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    return res.json(ok({ list, total: totalRows[0].total, pageNo, pageSize }));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 启用 / 禁用用户
 * POST /api/admin/user/status
 */
router.post('/user/status', async (req, res) => {
  try {
    const { userId, status } = req.body || {};
    if (!userId || ![0, 1].includes(status)) return res.json(fail('参数非法'));
    await db.query('UPDATE t_user SET status = ? WHERE id = ?', [status, userId]);
    return res.json(ok(null, '操作成功'));
  } catch (e) {
    return res.json(fail('操作失败', 500));
  }
});

/**
 * 任务统计概览
 * GET /api/admin/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const [taskTotal, checkinTotal, userTotal, doneTotal] = await Promise.all([
      db.query('SELECT COUNT(*) AS c FROM t_task'),
      db.query('SELECT COUNT(*) AS c FROM t_checkin'),
      db.query('SELECT COUNT(*) AS c FROM t_user'),
      db.query("SELECT COUNT(*) AS c FROM t_task WHERE status = 'done'")
    ]);
    return res.json(ok({
      taskTotal: taskTotal[0].c,
      checkinTotal: checkinTotal[0].c,
      userTotal: userTotal[0].c,
      doneTaskTotal: doneTotal[0].c
    }));
  } catch (e) {
    return res.json(fail('统计失败', 500));
  }
});

module.exports = router;
