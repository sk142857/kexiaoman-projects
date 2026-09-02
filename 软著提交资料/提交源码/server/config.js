/**
 * 全局配置模块
 * 集中管理服务端口、数据库连接、密钥等运行参数。
 * 所有敏感配置均通过环境变量注入，避免硬编码泄露。
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const env = process.env.NODE_ENV || 'development';

const config = {
  env: env,
  isProd: env === 'production',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // 数据库连接配置
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'study_checkin',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
    timezone: '+08:00',
    charset: 'utf8mb4'
  },

  // JWT 签名配置
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES || '12h'
  },

  // 文件上传目录
  uploadDir: path.join(__dirname, 'uploads'),

  // 接口限流配置
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 1000
  }
};

module.exports = config;
