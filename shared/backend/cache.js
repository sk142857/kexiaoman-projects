/**
 * 进程内 LRU 缓存（lru-cache v7，CJS）
 *
 * 用途：缓存读多写少的参考数据查询结果，削掉 RDB 网关按请求的往返延迟。
 * 注意：
 *  - 进程内每实例一份；多实例部署时靠 TTL / 写时失效保证最终一致
 *  - 业务数据（任务/打卡/用户明细等）不入缓存，只缓存字典/员工/合集/应用注册这类稳定数据
 */
const LRU = require("lru-cache");

const cache = new LRU({
  max: 5000,
  ttl: 5 * 60 * 1000,
  updateAgeOnGet: true,
});

/**
 * 带加载器的缓存读取：命中直接返回；未命中执行 loader 并写入
 * @param {string} key 缓存键
 * @param {() => Promise<any>} loader 数据加载器
 * @param {number} [ttlMs] 覆盖默认 TTL
 */
async function cached(key, loader, ttlMs) {
  if (cache.has(key)) return cache.get(key);
  const value = await loader();
  cache.set(key, value, ttlMs ? { ttl: ttlMs } : undefined);
  return value;
}

/** 删除单个缓存键 */
function invalidate(key) {
  cache.delete(key);
}

/** 删除指定前缀的全部缓存键（写数据后让整类缓存失效） */
function invalidatePrefix(prefix) {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

module.exports = { cache, cached, invalidate, invalidatePrefix };
