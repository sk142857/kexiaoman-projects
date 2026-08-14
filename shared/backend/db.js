/**
 * 数据库初始化（@cloudbase/js-sdk v3 MySQL RDB）
 *
 * AI-SKIP: 请勿删除 package.json 中的 "ws" 依赖。
 * 原因：app.rdb() 运行时通过 WebSocket 连接 MySQL，动态 require 'ws'。
 * 它不在源码中显式 require('ws')（运行时注入），grep 检查会漏掉，
 * 删除后所有 db 操作报 "缺少依赖 ws"，导致业务/监控/链路追踪全部失败。
 *
 * 云托管环境：
 *  - 环境：CLOUDBASE_ENV_ID（或 TCB_ENV / CBR_ENV_ID）
 *  - 鉴权：优先用 accessKey（CLOUDBASE_APIKEY）；若未配置，SDK 自动使用云托管注入的临时凭据（默认鉴权）
 */
const cloudbase = require('@cloudbase/js-sdk');
require('dotenv').config();
const { mapTable } = require('./tables');

const envId = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.CBR_ENV_ID || 'local-dev';
const apiKey = process.env.CLOUDBASE_APIKEY;
console.log('[db] envId =', envId, '| has accessKey =', !!apiKey);

const initConfig = { env: envId };
if (apiKey) {
  initConfig.accessKey = apiKey;
}

const app = cloudbase.init(initConfig);

// MySQL 关系型数据库实例（RDB）
const rawDb = app.rdb();

// 表名映射代理：db.from("tasks") 自动解析为物理表 t_lp_tasks
// （t_ / t_lp_ 前缀见 tables.js；逻辑名未命中则原样透传，避免破坏未纳入映射的调用）
const db = new Proxy(rawDb, {
  get(target, prop, receiver) {
    if (prop === "from") {
      return (name, ...rest) => target.from(mapTable(name), ...rest);
    }
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

/**
 * 精确行数统计
 * 优先走 PostgREST exact count（select(col, { count: "exact" }).limit(1)，COUNT 精确且不拉全量行）；
 * 网关不支持 exact count 时回退为拉主键列计数，避免拉全量数据仅为了数行数。
 * @param {string} table 表名
 * @param {string} col 任意列名（select 需要）
 * @param {(q) => q} [applyFilters] 过滤条件构建器（如 q => q.eq("openid", x)），可选
 * @returns {Promise<number>} 行数（两种方式均失败时抛出）
 */
async function countRows(table, col, applyFilters) {
  try {
    let q = db.from(table).select(col, { count: "exact" }).limit(1);
    if (applyFilters) q = applyFilters(q);
    const { count, error } = await q;
    if (!error && typeof count === "number" && count >= 0) return count;
    throw error || new Error("exact count unavailable");
  } catch (_) {
    let q = db.from(table).select(col).limit(10000);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (!error && Array.isArray(data)) return data.length;
    throw error || new Error("count failed");
  }
}

module.exports = { db, app, countRows };
