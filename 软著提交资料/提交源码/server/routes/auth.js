/**
 * 认证路由模块
 * 提供注册、登录、登出与令牌刷新能力。
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const jwt = require('../utils/jwt');
const { ok, fail } = require('../utils/response');
const { requiredString } = require('../utils/validate');
const { rateLimit } = require('../middleware/rateLimit');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

/**
 * 注册新账号
 * POST /api/auth/register
 */
router.post('/register', rateLimit((req) => req.ip, { windowMs: 60 * 1000, max: 10 }), async (req, res) => {
  try {
    const { account, password, name, role } = req.body || {};
    const err = requiredString(account, '账号') || requiredString(password, '密码') || requiredString(name, '姓名');
    if (err) return res.json(err);

    const rows = await db.query('SELECT id FROM t_user WHERE account = ?', [account]);
    if (rows.length > 0) {
      return res.json(fail('账号已存在'));
    }

    const hash = await bcrypt.hash(password, 10);
    const roleValue = ['admin', 'teacher', 'parent', 'student'].includes(role) ? role : 'student';
    const result = await db.query(
      'INSERT INTO t_user (account, password, name, role, status, created_at) VALUES (?, ?, ?, ?, 1, NOW())',
      [account, hash, name, roleValue]
    );

    const token = jwt.sign({ uid: result.insertId, role: roleValue });
    return res.json(ok({ token, userId: result.insertId }));
  } catch (e) {
    return res.json(fail('注册失败', 500));
  }
});

/**
 * 账号登录
 * POST /api/auth/login
 */
router.post('/login', rateLimit((req) => req.ip, { windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    const { account, password } = req.body || {};
    const err = requiredString(account, '账号') || requiredString(password, '密码');
    if (err) return res.json(err);

    const rows = await db.query('SELECT id, account, password, name, role, status FROM t_user WHERE account = ?', [account]);
    if (rows.length === 0) {
      return res.json(fail('账号或密码错误', 401));
    }
    const user = rows[0];
    const matched = await bcrypt.compare(password, user.password);
    if (!matched) {
      return res.json(fail('账号或密码错误', 401));
    }
    if (user.status !== 1) {
      return res.json(fail('账号已被禁用，请联系管理员', 403));
    }

    const token = jwt.sign({ uid: user.id, role: user.role });
    return res.json(ok({ token, userId: user.id, name: user.name, role: user.role }));
  } catch (e) {
    return res.json(fail('登录失败', 500));
  }
});

/**
 * 获取当前登录用户信息
 * GET /api/auth/me
 */
router.get('/me', authRequired, (req, res) => {
  return res.json(ok(req.user));
});

/**
 * 登出（由前端丢弃令牌）
 * POST /api/auth/logout
 */
router.post('/logout', authRequired, (req, res) => {
  return res.json(ok(null, '已退出登录'));
});

module.exports = router;
