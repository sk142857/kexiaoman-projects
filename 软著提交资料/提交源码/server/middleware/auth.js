/**
 * 鉴权中间件
 * 校验请求头中的访问令牌，并将用户信息挂载到 req.user。
 */
const jwt = require('../utils/jwt');
const { fail } = require('../utils/response');
const db = require('../db');

async function authRequired(req, res, next) {
  try {
    const token = jwt.parseBearer(req.headers.authorization || '');
    if (!token) {
      return res.json(fail('未登录或令牌缺失', 401));
    }
    const payload = jwt.verify(token);
    const rows = await db.query('SELECT id, name, role, status FROM t_user WHERE id = ?', [payload.uid]);
    if (rows.length === 0) {
      return res.json(fail('用户不存在', 401));
    }
    const user = rows[0];
    if (user.status !== 1) {
      return res.json(fail('账号已被禁用', 403));
    }
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.json(fail('登录状态失效，请重新登录', 401));
    }
    return res.json(fail('鉴权异常', 500));
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.json(fail('无管理员权限', 403));
  }
  next();
}

module.exports = { authRequired, adminOnly };
