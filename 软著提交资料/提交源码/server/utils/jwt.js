/**
 * JWT 工具模块
 * 负责访问令牌的签发与校验，支持用户端与管理端两套令牌。
 */
const jwt = require('jsonwebtoken');
const config = require('../config');

function sign(payload, options) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    ...options
  });
}

function verify(token) {
  return jwt.verify(token, config.jwt.secret);
}

function parseBearer(header) {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

module.exports = { sign, verify, parseBearer };
