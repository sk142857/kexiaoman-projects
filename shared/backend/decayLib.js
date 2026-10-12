/**
 * 打卡衰减定时任务（不打卡降级扣分）
 *
 * 设计（游戏化「掉分/衰减」机制）：
 *  - 学生连续未打卡超过宽限期（默认 3 天）后，每天扣 pointsPerDay（默认 5）经验；
 *    经验 = 积分账本余额，扣分即可能导致降级，形成「坚持打卡、别掉队」的正向压力。
 *  - 判定「活跃」：最近 graceDays 天内有过打卡（任意状态）或有过加分流水（完成任务等），
 *    有则当天不衰减（避免待审核打卡被误伤）。
 *  - 幂等：同一学生同一自然日最多扣一次（按当天已写 inactive_decay 流水去重，多实例安全）。
 *  - 只对余额 > 0 的学生扣分；扣分不低于 0（余额见底不再扣）。
 *  - 扣分写入积分账本（reason=inactive_decay），可审计、可追溯。
 *
 * 可配置：t_system_params 里 key=level_decay 的 JSON
 *        （{ enabled, graceDays, pointsPerDay }），未配置时用下方默认值；60s 缓存。
 *
 * 触发：server.js 启动时调用 startDecay()，每 3 小时运行一次
 *      （进程内定时器 + 流水按天幂等兜底；停机期间不补扣，只按运行当日衰减）。
 */
const { db } = require("./db");
const { formatDate } = require("./utils");
const { logPoints } = require("./learningLib");
const { getParamJson } = require("./params");

const APP_ID = "miniprogram-kxm";

const DEFAULT_DECAY_CONFIG = {
  enabled: true,
  graceDays: 3,    // 连续未打卡宽限天数（宽限期内不衰减）
  pointsPerDay: 5, // 宽限期后每未打卡一天扣分
};

let _running = false;

/** 读取衰减配置（系统参数可覆盖，非法值回退默认） */
async function getDecayConfig() {
  let cfg = null;
  try { cfg = await getParamJson(APP_ID, "level_decay"); } catch (_) { cfg = null; }
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  return {
    enabled: c.enabled === undefined ? DEFAULT_DECAY_CONFIG.enabled : !!c.enabled,
    graceDays: num(c.graceDays, DEFAULT_DECAY_CONFIG.graceDays),
    pointsPerDay: num(c.pointsPerDay, DEFAULT_DECAY_CONFIG.pointsPerDay),
  };
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

/** 分批执行 in 查询，避免单次 in 值过多（超长 SQL/URL） */
async function selectInChunks(table, cols, field, ids, applyFilters, chunkSize = 300) {
  const rows = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const part = ids.slice(i, i + chunkSize);
    let q = db.from(table).select(cols).in(field, part);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q.limit(20000);
    if (error) throw error;
    if (Array.isArray(data)) rows.push(...data);
  }
  return rows;
}

/** 执行一轮衰减扫描（导出便于测试/手动触发） */
async function runOnce() {
  const cfg = await getDecayConfig();
  if (!cfg.enabled || cfg.pointsPerDay <= 0) return;

  const today = formatDate(new Date());
  const windowStart = shiftDate(today, -cfg.graceDays); // 活跃窗口起点（含）
  const todayStart = `${today} 00:00:00`;

  // 1. 候选：有积分余额的学生（余额<=0 无需衰减）
  const { data: balRows, error: balErr } = await db.from("point_balances")
    .select("staff_id, balance").limit(20000);
  if (balErr) throw balErr;
  const balances = {};
  (balRows || []).forEach(r => {
    const sid = Number(r.staff_id);
    const b = Number(r.balance) || 0;
    if (sid > 0 && b > 0) balances[sid] = b;
  });
  const ids = Object.keys(balances).map(Number);
  if (ids.length === 0) return;

  // 2. 活跃学生：最近 graceDays 天内有过打卡（任意审核状态）
  const active = new Set();
  const chkRows = await selectInChunks(
    "task_checkins", "created_by, checkin_date", "created_by", ids,
    q => q.gte("checkin_date", windowStart)
  );
  chkRows.forEach(c => { if (c.created_by) active.add(Number(c.created_by)); });

  // 3. 活跃学生：最近 graceDays 天内有过加分（完成任务等）
  const logRows = await selectInChunks(
    "point_logs", "staff_id, points", "staff_id", ids,
    q => q.gte("created_at", `${windowStart} 00:00:00`)
  );
  logRows.forEach(l => { if (Number(l.points) > 0) active.add(Number(l.staff_id)); });

  // 4. 今天已衰减过的学生（按天幂等去重）
  const decRows = await selectInChunks(
    "point_logs", "staff_id", "staff_id", ids,
    q => q.eq("reason", "inactive_decay").gte("created_at", todayStart)
  );
  const decayedToday = new Set(decRows.map(r => Number(r.staff_id)));

  // 5. 逐人结算：不活跃且今天未扣 → 扣 min(pointsPerDay, 余额)
  let charged = 0;
  for (const sid of ids) {
    if (active.has(sid)) continue;
    if (decayedToday.has(sid)) continue;
    const deduct = Math.min(cfg.pointsPerDay, balances[sid]);
    if (deduct <= 0) continue;
    await logPoints({
      staffId: sid,
      points: -deduct,
      reason: "inactive_decay",
      refType: "decay",
      refId: Number(today.replace(/-/g, "")),
      note: `连续 ${cfg.graceDays} 天以上未打卡，衰减 -${deduct}`,
    });
    charged += 1;
  }
  if (charged > 0) console.log(`[decay] ${today} 活跃窗口 ${windowStart}~${today} | 衰减 ${charged} 人`);
}

/** 定时入口（进程内互斥，防止重入） */
async function runDecay() {
  if (_running) return;
  _running = true;
  try { await runOnce(); }
  catch (e) { console.error("[decay] 任务异常", e); }
  finally { _running = false; }
}

/** 启动衰减定时任务（默认每 3 小时运行一次） */
function startDecay(intervalMs = 3 * 60 * 60 * 1000) {
  setTimeout(runDecay, 60 * 1000);
  setInterval(runDecay, intervalMs);
}

module.exports = { runDecay, runOnce, startDecay, getDecayConfig, DEFAULT_DECAY_CONFIG };
