/**
 * 统一响应封装模块
 * 约定前端统一的响应结构：{ code, message, data }
 * code = 0 表示成功，非 0 表示业务错误。
 */
const SUCCESS_CODE = 0;

/**
 * 成功响应
 */
function ok(data, message = 'success') {
  return { code: SUCCESS_CODE, message, data };
}

/**
 * 失败响应
 */
function fail(message, code = 400) {
  return { code, message, data: null };
}

/**
 * 分页数据封装
 */
function page(rows, total, pageNo, pageSize) {
  return {
    list: rows,
    total,
    pageNo,
    pageSize,
    hasMore: pageNo * pageSize < total
  };
}

module.exports = { ok, fail, page, SUCCESS_CODE };
