/**
 * 学习打卡管理平台 - 服务入口
 * 启动 HTTP 服务并挂载路由与中间件链。
 */
const express = require('express');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db');
const routes = require('./routes');

const app = express();

app.disable('x-powered-by');

// 请求体解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 统一请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'up', time: new Date().toISOString() });
});

// 业务路由
app.use('/api', routes);

// 静态资源
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 404 兜底
app.use((req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在', data: null });
});

// 全局异常兜底
app.use((err, req, res, next) => {
  logger.error('unhandled error:', err);
  res.status(500).json({ code: 500, message: '服务器内部错误', data: null });
});

async function bootstrap() {
  try {
    await db.ping();
    logger.info('数据库连接成功');
  } catch (e) {
    logger.error('数据库连接失败:', e.message);
    process.exit(1);
  }
  app.listen(config.port, config.host, () => {
    logger.info(`服务已启动: http://${config.host}:${config.port} (${config.env})`);
  });
}

bootstrap();

module.exports = app;
