/**
 * 超级管理员强保护模块
 *
 * 用途：禁止删除 999999 超级管理员账号；所有级联删除（cascade）一律跳过受保护账号，
 * 避免通过删除小程序用户 / 员工触发对超级管理员的连带清理。
 *
 * - 受保护 ID 默认 [999999]（生产超管固定 ID），可经环境变量 SUPER_ADMIN_IDS 追加（逗号分隔）。
 * - 所有判定函数接受 number/string 形态的 id，内部统一归一为数字比较。
 */
const DEFAULT_SUPER_ADMIN_IDS = [999999];

/** 解析受保护 ID：内置 999999 恒在，环境变量仅追加，不可移除 */
function parseProtectedIds() {
  const raw = String(process.env.SUPER_ADMIN_IDS || "").trim();
  const fromEnv = raw
    ? raw.split(",").map(s => Number(String(s).trim())).filter(v => Number.isFinite(v) && v > 0)
    : [];
  return [...new Set([...DEFAULT_SUPER_ADMIN_IDS, ...fromEnv])];
}

const PROTECTED_IDS = parseProtectedIds();
const PROTECTED_SET = new Set(PROTECTED_IDS);

/** 是否受强保护的超级管理员账号 */
function isProtectedStaff(id) {
  const n = Number(id);
  return Number.isFinite(n) && PROTECTED_SET.has(n);
}

module.exports = { isProtectedStaff, PROTECTED_IDS, PROTECTED_SET, DEFAULT_SUPER_ADMIN_IDS };
