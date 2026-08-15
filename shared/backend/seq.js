/**
 * 序列管理：主键（任务ID/打卡ID等）由 seqs 表统一发放
 * - init_value 初始值、step 步长、batch 号段大小、current_value 当前值（下次发放的值）
 * - 所有无特殊生成要求、原本使用自增主键的表，统一接入本模块生成主键
 *
 * 号段（segment）发号策略：
 * - 首次取号时一次性从 seqs 领取一个号段（大小见 t_seqs.batch），缓存在进程内；
 *   后续取号直接命中内存，不再打库。号段耗尽才再次领段（一次 select + 一次 update）。
 * - 号段大小优先读 t_seqs.batch 列（后台「序列管理」可调整），未配置时回退代码默认：
 *   - 日志类（时间轴/订阅发送等写频繁）：500
 *   - 其余业务序列（任务/打卡/合集等更新不频繁）：200
 * - 取号阶段 DB 往返从「每次 2 次」降为「每个号段 2 次」，高并发下大幅削峰。
 * - 号段耗尽时立即在后台异步领取下一段（prefetch），后续取号直接命中，不阻塞。
 * - 进程内按 seq_key 加锁串行领段，避免同进程重复领段；跨实例靠
 *   `update ... where current_value = <读到的旧值>` 的条件更新 + 重读校验兜底，
 *   保证多实例各自持有的号段互不重叠（各实例号段可能不连续，属正常设计）。
 * - 注意：号段用不完会跳过（每实例每 key 浪费至多 batch-1 个），BIGINT 主键可忽略。
 */
const { db } = require("./db");
const { nowSql } = require("./utils");

// 默认号段大小（更新不频繁的普通业务序列；t_seqs.batch 未配置时兜底）
const DEFAULT_BATCH = 200;

// 日志类序列：写频繁、量大，给大号段减少打库次数；未列出的走 DEFAULT_BATCH
const BATCH_BY_SEQ = {
  task_timeline_event_id: 500,
  subscribe_send_id: 500,
};

/**
 * 解析号段大小：显式参数 > t_seqs.batch 列 > 序列类型映射 > 默认值
 * @param {object|null} rec seqs 行记录（可能为空）
 * @param {string} seqKey 序列键
 * @param {number} [batchSize] 显式传入的号段大小
 */
function resolveBatch(rec, seqKey, batchSize) {
  if (batchSize != null && Number(batchSize) > 0) return Number(batchSize);
  if (rec && Number(rec.batch) > 0) return Number(rec.batch);
  return BATCH_BY_SEQ[seqKey] || DEFAULT_BATCH;
}

// 进程内号段缓存：seqKey -> { next, end, step }
const segments = new Map();

// 每 key 的领段互斥锁（promise 链），串行化同一进程内的领段操作
const locks = new Map();

/** 对指定 key 串行执行 fn，并返回 fn 的结果 */
function withKeyLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  locks.set(key, run.catch(() => {}));
  return run;
}

/**
 * 确保 seqKey 有可用号段（无则领段），返回该号段对象，不消费号
 * @param {string} seqKey 序列键
 * @param {number} batchSize 号段大小
 * @returns {Promise<{ next: number, end: number, step: number }>}
 */
async function ensureSegment(seqKey, batchSize) {
  const seg = segments.get(seqKey);
  if (seg && seg.next <= seg.end) return seg;
  return withKeyLock(seqKey, async () => {
    const cached = segments.get(seqKey);
    if (cached && cached.next <= cached.end) return cached;

    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: rows, error } = await db.from("seqs").select().eq("seq_key", seqKey).limit(1);
      if (error) throw error;
      const rec = rows && rows[0];

      // 号段大小：t_seqs.batch 列优先，未配置时走映射/默认
      const batch = resolveBatch(rec, seqKey, batchSize);

      let cur;
      let step;
      if (!rec) {
        // 首次使用：建号（写入号段大小）并领取第一个号段
        cur = 1;
        step = 1;
        const { error: insErr } = await db.from("seqs").insert({
          seq_key: seqKey,
          seq_name: seqKey,
          current_value: 1 + batch,
          init_value: 1,
          step: 1,
          batch,
          updated_at: nowSql(),
        });
        if (insErr && /duplicate|unique/i.test(String(insErr.message || insErr))) continue;
        if (insErr) throw insErr;
      } else {
        step = Number(rec.step) || 1;
        cur = Number(rec.current_value) || 1;
        const newVal = cur + batch * step;
        const { data: updated, error: upErr } = await db
          .from("seqs")
          .update({ current_value: newVal, updated_at: nowSql() })
          .eq("seq_key", seqKey)
          .eq("current_value", cur);
        if (upErr) throw upErr;
        if (updated && Array.isArray(updated) && updated.length === 0) continue;
        if (!updated) {
          // 网关未返回受影响行数，重读校验：值不等于我们写入的目标值说明被并发修改，重试
          const { data: check } = await db.from("seqs").select("current_value").eq("seq_key", seqKey).limit(1);
          const cv = check && check[0] && Number(check[0].current_value);
          if (cv !== newVal) continue;
        }
      }

      const seg = { next: cur, end: cur + batch * step - 1, step, batch };
      segments.set(seqKey, seg);
      return seg;
    }

    throw new Error("seq allocation failed after retries: " + seqKey);
  });
}

/**
 * 取下一个序列值（走号段缓存，仅号段耗尽时才落库）
 * @param {string} seqKey 序列键（如 task_id/staff_id）
 * @param {number} [batchSize] 号段大小（默认读 t_seqs.batch，未配置按类型回退）
 * @returns {Promise<number>}
 */
async function nextSeq(seqKey, batchSize) {
  const seg = await ensureSegment(seqKey, batchSize);
  const v = seg.next;
  seg.next += seg.step;
  // 号段耗尽：后台异步领取下一段，下次取号直接命中，避免阻塞
  if (seg.next > seg.end) prefetchSeq(seqKey, seg.batch);
  return v;
}

/** 进程内预热一个号段（只占号段不消耗号，降低首次取号延迟） */
function prefetchSeq(seqKey, batchSize) {
  ensureSegment(seqKey, batchSize).catch(() => {});
}

module.exports = { nextSeq, prefetchSeq };
