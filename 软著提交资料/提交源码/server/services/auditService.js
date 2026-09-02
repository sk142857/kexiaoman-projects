/**
 * 审计服务模块
 * 记录关键操作日志，便于追溯与合规审查。
 */
const db = require('../db');

async function log(operatorId, action, detail, ip) {
  try {
    await db.query(
      'INSERT INTO t_audit_log (operator_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, NOW())',
      [operatorId, action, detail ? JSON.stringify(detail) : null, ip || '']
    );
  } catch (e) {
    // 审计失败不阻断主流程
  }
}

async function list(pageNo = 1, pageSize = 20) {
  const offset = (pageNo - 1) * pageSize;
  const rows = await db.query(
    `SELECT l.*, u.name AS operator_name
       FROM t_audit_log l
       LEFT JOIN t_user u ON u.id = l.operator_id
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  const totalRows = await db.query('SELECT COUNT(*) AS c FROM t_audit_log');
  return { list: rows, total: totalRows[0].c };
}

module.exports = { log, list };
