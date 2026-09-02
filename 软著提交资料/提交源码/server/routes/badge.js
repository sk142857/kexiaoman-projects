/**
 * 徽章路由模块
 * 提供成就徽章解锁查询与解锁记录写入。
 */
const express = require('express');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const BADGE_LIST = [
  { key: 'first_checkin', name: '初次打卡', desc: '完成第一次打卡', icon: 'badge_01' },
  { key: 'seven_days', name: '坚持一周', desc: '连续打卡 7 天', icon: 'badge_02' },
  { key: 'month_master', name: '月度达人', desc: '当月打卡 20 次', icon: 'badge_03' },
  { key: 'task_complete', name: '任务先锋', desc: '累计完成任务 10 个', icon: 'badge_04' },
  { key: 'level_up', name: '等级成长', desc: '达到等级 5', icon: 'badge_05' }
];

/**
 * 查询我的徽章墙
 * GET /api/badge/mine
 */
router.get('/mine', authRequired, async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT badge_key, unlocked_at FROM t_badge_unlock WHERE student_id = ?',
      [req.user.id]
    );
    const unlocked = {};
    rows.forEach((r) => {
      unlocked[r.badge_key] = r.unlocked_at;
    });
    const list = BADGE_LIST.map((b) => ({
      ...b,
      unlocked: Boolean(unlocked[b.key]),
      unlockedAt: unlocked[b.key] || null
    }));
    return res.json(ok(list));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 后台徽章定义列表
 * GET /api/badge/defs
 */
router.get('/defs', authRequired, (req, res) => {
  return res.json(ok(BADGE_LIST));
});

module.exports = router;
