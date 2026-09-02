/**
 * 用户路由模块
 * 提供用户资料查询、修改与密码修改能力。
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ok, fail } = require('../utils/response');
const { requiredString } = require('../utils/validate');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

/**
 * 获取个人资料
 * GET /api/user/profile
 */
router.get('/profile', authRequired, async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, account, name, role, avatar, gender, school, grade, created_at FROM t_user WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return res.json(fail('用户不存在', 404));
    return res.json(ok(rows[0]));
  } catch (e) {
    return res.json(fail('查询失败', 500));
  }
});

/**
 * 更新个人资料
 * POST /api/user/profile
 */
router.post('/profile', authRequired, async (req, res) => {
  try {
    const { name, avatar, gender, school, grade } = req.body || {};
    const fields = [];
    const params = [];
    const allowMap = { name, avatar, gender, school, grade };
    for (const [key, val] of Object.entries(allowMap)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        params.push(val);
      }
    }
    if (fields.length === 0) return res.json(fail('没有需要更新的字段'));

    params.push(req.user.id);
    await db.query(`UPDATE t_user SET ${fields.join(', ')} WHERE id = ?`, params);
    return res.json(ok(null, '保存成功'));
  } catch (e) {
    return res.json(fail('更新失败', 500));
  }
});

/**
 * 修改密码
 * POST /api/user/password
 */
router.post('/password', authRequired, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.json(fail('参数不完整'));

    const rows = await db.query('SELECT password FROM t_user WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.json(fail('用户不存在', 404));

    const matched = await bcrypt.compare(oldPassword, rows[0].password);
    if (!matched) return res.json(fail('原密码错误'));

    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE t_user SET password = ? WHERE id = ?', [hash, req.user.id]);
    return res.json(ok(null, '密码修改成功'));
  } catch (e) {
    return res.json(fail('修改失败', 500));
  }
});

module.exports = router;
