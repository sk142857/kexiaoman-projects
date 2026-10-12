-- ============================================================
-- 升级脚本：无限等级 + 不打卡衰减（系统参数种子）
-- 影响表：t_system_params（新增 key=level_decay）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（uk_app_key 唯一键 + ON DUPLICATE KEY UPDATE，可重复执行）
-- 说明：
--   1. 等级模型升级为「无限成长」：等级永不封顶（不再 10 级封顶），
--      由 shared/backend/learningLib.js 的 levelFromXp/xpToNextLevel/levelThreshold 计算，
--      纯代码逻辑，无需改表；历史 1~10 级阈值保持不变（老用户等级不降）。
--   2. 新增「不打卡衰减」定时任务（shared/backend/decayLib.js）：连续未打卡超过宽限期后
--      每天扣分（写入 t_lp_point_logs，reason=inactive_decay），扣分即可能导致降级。
--      本脚本预置可调参数 level_decay（后台「系统参数」可改，60s 内生效）。
--   3. 等级里程碑徽章（level_15/20/30/50/100 等）由运行时 syncBadgeUnlocks 自动落库，无需回填脚本。
-- ============================================================

INSERT INTO t_system_params (param_id, app_id, param_key, param_value, param_type, param_desc, param_status, created_at, updated_at) VALUES
  (4, 'miniprogram-kxm', 'level_decay', '{"enabled":true,"graceDays":3,"pointsPerDay":5}', 'json', '不打卡衰减配置（enabled 开关 / graceDays 宽限天数 / pointsPerDay 每日扣分；等级随扣分下降）', 1, NOW(), NOW())
  ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), param_type = VALUES(param_type),
    param_desc = VALUES(param_desc), param_status = VALUES(param_status);
