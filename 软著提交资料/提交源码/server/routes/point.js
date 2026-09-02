/**
 * 积分路由模块
 * 提供积分账本查询与任务完成加分逻辑。
 */
const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { authRequired } = require('../middleware/auth');
const pointService = require('../services/pointService');

const router = express.Router();

/**
 * 查询积分明细（账本流水）
 * GET /api/point/logs
 */
router.get('/logs', authRequired, async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, student_id, delta, reason, remark, created_at FROM t_point_log WHERE student_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    return res.json(ok(rows));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 查询当前积分余额
 * GET /api/point/balance
 */
router.get('/balance', authRequired, async (req, res) => {
  try {
    const rows = await db.query('SELECT xp FROM t_student_profile WHERE student_id = ?', [req.user.id]);
    const xp = rows.length > 0 ? rows[0].xp : 0;
    return res.json(ok({ xp, level: pointService.levelOf(xp) }));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 管理员调整积分
 * POST /api/point/adjust
 */
router.post('/adjust', authRequired, async (req, res) => {
  try {
    const { studentId, delta, reason } = req.body || {};
    if (!studentId || !delta || !reason) return res.json(fail('参数不完整'));
    await pointService.adjust(studentId, delta, reason, req.user.id);
    return res.json(ok(null, '调整成功'));
  } catch (e) {
    return res.json(fail('调整失败', 500));
  }
});

module.exports = router;
