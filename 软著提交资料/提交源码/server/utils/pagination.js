/**
 * 分页参数工具模块
 * 统一解析与校验分页参数，防止非法输入。
 */
function parsePage(query) {
  const pageNo = Math.max(parseInt(query.pageNo, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  return { pageNo, pageSize, offset: (pageNo - 1) * pageSize };
}

function buildPageResult(list, total, pageNo, pageSize) {
  return {
    list,
    total,
    pageNo,
    pageSize,
    hasMore: pageNo * pageSize < total
  };
}

module.exports = { parsePage, buildPageResult };
