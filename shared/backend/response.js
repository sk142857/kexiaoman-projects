/**
 * 云托管统一响应工具（与云函数 response 结构一致）
 * { code: 0, msg, data } / { code: 400, msg } / { code: 500, msg }
 */

function ok(data, msg = "操作成功") {
  return { code: 0, msg, data: data === undefined ? null : data };
}

function fail(msg = "操作失败", code = 400) {
  return { code, msg, data: null };
}

module.exports = { ok, fail };
