/**
 * 数据库连接池模块
 * 使用 mysql2 连接池管理 MySQL 连接，提供统一的查询封装。
 */
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  timezone: config.db.timezone,
  charset: config.db.charset,
  waitForConnections: true,
  queueLimit: 0
});

/**
 * 执行 SQL 查询
 * @param {string} sql SQL 语句
 * @param {Array} params 参数列表
 * @returns {Promise<Array>} 查询结果行
 */
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params || []);
  return rows;
}

/**
 * 事务封装
 * @param {Function} fn 事务内执行的异步函数，接收 conn 参数
 * @returns {Promise<*>} 事务结果
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 校验数据库连接
 */
async function ping() {
  await pool.query('SELECT 1');
}

module.exports = { pool, query, transaction, ping };
