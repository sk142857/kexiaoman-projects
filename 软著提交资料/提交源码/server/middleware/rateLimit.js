/**
 * 简单限流中间件
 * 基于进程内滑动窗口实现，防止接口被暴力调用。
 */
const config = require('../config');
const { fail } = require('../utils/response');

const buckets = new Map();

function rateLimit(keyFn, options) {
  const windowMs = (options && options.windowMs) || config.rateLimit.windowMs;
  const max = (options && options.max) || config.rateLimit.max;

  return function (req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    const arr = buckets.get(key);
    while (arr.length > 0 && now - arr[0] > windowMs) {
      arr.shift();
    }
    if (arr.length >= max) {
      return res.json(fail('请求过于频繁，请稍后再试', 429));
    }
    arr.push(now);
    next();
  };
}

module.exports = { rateLimit };
