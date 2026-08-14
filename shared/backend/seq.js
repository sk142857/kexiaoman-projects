/**
 * 序列管理：主键（任务ID/打卡ID等）由 seqs 表统一发放
 * - init_value 初始值、step 步长、current_value 当前值（下次发放的值）
 * - 所有无特殊生成要求、原本使用自增主键的表，统一接入本模块生成主键
 */
const { db } = require("./db");
const { nowSql } = require("./utils");

async function nextSeq(seqKey) {
  const { data: rows, error } = await db.from("seqs").select().eq("seq_key", seqKey).limit(1);
  if (error) throw error;
  const rec = rows && rows[0];
  if (!rec) {
    await db.from("seqs").insert({ seq_key: seqKey, seq_name: seqKey, current_value: 1, init_value: 1, step: 1, updated_at: nowSql() });
    return 1;
  }
  const step = Number(rec.step) || 1;
  const next = Number(rec.current_value) || 1;
  await db.from("seqs").update({ current_value: next + step, updated_at: nowSql() }).eq("seq_key", seqKey);
  return next;
}

module.exports = { nextSeq };
