/**
 * 通用工具函数
 */

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 计算连续打卡天数（从今天往前，中断即止） */
function calcStreak(recentDates) {
  const dateSet = new Set(recentDates);
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (dateSet.has(formatDate(d))) streak++;
    else if (i > 0) break;
  }
  return streak;
}

/** 本月前缀，如 "2026-08" */
function thisMonthPrefix() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

/** 指定月份（yyyy-MM）的起止日期，如 "2026-08" → { start: "2026-08-01", end: "2026-09-01" } */
function monthRange(month) {
  const [y, m] = String(month).split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return { start, end };
}

/** MySQL datetime 字符串：YYYY-MM-DD HH:MM:SS（TDSQL 不接受 ISO 格式） */
function nowSql(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
}

/** 生成主键：13 位毫秒时间戳 + 3 位随机数（file_uploads / user_events 用） */
function genId() {
  const rand = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `${Date.now()}${rand}`;
}

// ==================== 进程内互斥锁（单实例串行化读改写，如 checkin_count 计数） ====================
// 场景：@cloudbase RDB 无原子自增 API，checkin_count 等计数为「读-改-写」，
// 并发请求会丢失更新。该锁在同一进程内按 key 串行执行，避免并发丢计数；
// 多实例部署时各实例独立锁（需分布式锁才完全消除，当前单实例场景已足够收敛）。
const __locks = new Map();
async function withLock(key, fn) {
  const prev = __locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  const run = prev.then(() => gate);
  __locks.set(key, run);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (__locks.get(key) === run) __locks.delete(key);
  }
}

module.exports = { formatDate, calcStreak, thisMonthPrefix, monthRange, nowSql, genId, withLock };
