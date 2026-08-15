/**
 * 用户ID 生成：随机 10 位数字（1000000000-9999999999），进程内维护备用号池
 *
 * - 池容量默认 500：一次性预生成合规 ID 备用，取号时校验唯一性（users.user_uid），
 *   减少碰撞重试与重复生成的开销；池水位低于阈值时后台异步补池。
 * - 生成时过滤「连续 4 个及以上相同数字」（如 1111 / 55555），避免观感较差的 ID。
 * - 单实例进程内池；多实例各自持池，靠 DB 唯一性校验兜底
 *   （10 位随机空间 90 亿，碰撞率极低，冲突即弃号重取）。
 */
const { db } = require("./db");

const POOL_SIZE = Number(process.env.USER_UID_POOL) || 500; // 目标备用池容量
const REFILL_AT = 100; // 低于该水位触发异步补池
const MIN_VAL = 1000000000;
const MAX_VAL = 9999999999;

const pool = [];
let refilling = null; // 进行中的补池 promise，避免并发重复补池

/** 是否包含连续 4 个及以上相同数字 */
function hasBadRun(id) {
  return /(\d)\1{3,}/.test(String(id));
}

/** 生成一个合规的随机 10 位数字用户ID（避免连续 4 个及以上重复数字） */
function genUserUid() {
  for (let i = 0; i < 100; i++) {
    const id = String(Math.floor(MIN_VAL + Math.random() * (MAX_VAL - MIN_VAL + 1)));
    if (!hasBadRun(id)) return id;
  }
  return String(Math.floor(MIN_VAL + Math.random() * (MAX_VAL - MIN_VAL + 1)));
}

/** 后台补池到目标容量（并发去重，仅当池未满时执行） */
function refill() {
  if (refilling) return refilling;
  refilling = (async () => {
    try {
      while (pool.length < POOL_SIZE) pool.push(genUserUid());
    } finally {
      refilling = null;
    }
  })();
  return refilling;
}

/**
 * 取一个未被占用的用户ID（池中弹出 + DB 唯一性校验）
 * @returns {Promise<string>}
 */
async function nextUserUid() {
  if (pool.length === 0) await refill();
  for (let i = 0; i < 50; i++) {
    const uid = pool.pop();
    if (uid == null) {
      await refill();
      continue;
    }
    const { data, error } = await db.from("users").select("user_uid").eq("user_uid", uid).limit(1);
    if (error) throw error;
    if (!data || !data[0]) {
      if (pool.length <= REFILL_AT) refill();
      return uid;
    }
  }
  // 极端兜底：连续 50 次冲突（几乎不可能），直接生成一个合规 ID
  return genUserUid();
}

/** 当前备用池剩余数量（监控/调试用） */
function poolSize() {
  return pool.length;
}

module.exports = { nextUserUid, genUserUid, poolSize, hasBadRun };
