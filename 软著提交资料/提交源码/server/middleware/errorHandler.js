/**
 * 错误处理中间件
 * 统一捕获异常并返回规范的错误响应。
 */
const logger = require('../utils/logger');
const { fail } = require('../utils/response');

function notFound(req, res) {
  res.status(404).json(fail('接口不存在', 404));
}

function errorHandler(err, req, res, next) {
  logger.error('unhandled error', err);
  if (res.headersSent) {
    return next(err);
  }
  const message = process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message;
  res.status(500).json(fail(message, 500));
}

module.exports = { notFound, errorHandler };
