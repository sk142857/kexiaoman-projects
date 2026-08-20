-- ============================================================
-- 升级脚本：成就徽章解锁记录（t_lp_badge_unlocks）
-- 影响表：t_lp_badge_unlocks（新增）
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（CREATE TABLE IF NOT EXISTS；回填仅在空表执行 + NOT EXISTS 防重）
-- 说明：
--   1. 徽章从「每次现算」升级为「解锁落库」：仪表盘计算时把新解锁徽章写入本表，
--      记录解锁时间点（unlocked_at），可审计、可在「奖章墙」展示解锁日期。
--   2. 存量回填：历史已满足条件的徽章，用触发事件的时间估算解锁时间
--      （累计打卡=第 N 次通过打卡时间；等级=积分账本累计首次达到阈值；连击=连续打卡第 N 天等）。
--   3. 无法精确推算的滚动型徽章（perfect_week 近7天全勤）不做回填，由运行时首次达标时记录。
--   4. 需同步更新 init_schema.sql 保持一致。
-- ============================================================

-- 1. 建表（不存在才建，可重复执行）
CREATE TABLE IF NOT EXISTS t_lp_badge_unlocks (
  staff_id    BIGINT      NOT NULL COMMENT '学生 staff_id',
  badge_key   VARCHAR(32) NOT NULL COMMENT '徽章 key（如 checkin_10 / streak_7 / level_5）',
  unlocked_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '解锁时间',
  PRIMARY KEY (staff_id, badge_key),
  KEY idx_badge (badge_key),
  KEY idx_unlocked_at (unlocked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='成就徽章解锁记录';

-- 2. 存量回填（仅空表时执行一次；均带 NOT EXISTS 防重）
SET @cnt := (SELECT COUNT(*) FROM t_lp_badge_unlocks);

-- 2.1 累计打卡系列（first_checkin / checkin_10/50/100/200/300）：第 N 次审核通过打卡的时间
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, 'first_checkin' AS badge_key, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, checkin_id) AS rn
  FROM t_lp_task_checkins WHERE review_status = 'approved'
) x WHERE @cnt = 0 AND x.rn = 1
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'first_checkin');

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, 'checkin_10' AS badge_key, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, checkin_id) AS rn
  FROM t_lp_task_checkins WHERE review_status = 'approved'
) x WHERE @cnt = 0 AND x.rn = 10
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'checkin_10');

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, 'checkin_50' AS badge_key, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, checkin_id) AS rn
  FROM t_lp_task_checkins WHERE review_status = 'approved'
) x WHERE @cnt = 0 AND x.rn = 50
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'checkin_50');

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, 'checkin_100' AS badge_key, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, checkin_id) AS rn
  FROM t_lp_task_checkins WHERE review_status = 'approved'
) x WHERE @cnt = 0 AND x.rn = 100
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'checkin_100');

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, 'checkin_200' AS badge_key, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, checkin_id) AS rn
  FROM t_lp_task_checkins WHERE review_status = 'approved'
) x WHERE @cnt = 0 AND x.rn = 200
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'checkin_200');

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, 'checkin_300' AS badge_key, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, checkin_id) AS rn
  FROM t_lp_task_checkins WHERE review_status = 'approved'
) x WHERE @cnt = 0 AND x.rn = 300
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'checkin_300');

-- 2.2 连续打卡系列（streak_3/7/14/30/60/100）：连续天数首次达到 N 的那一天（岛屿分组法）
-- 分组法：天数序号 - 行号 相同 = 连续区间；区间首日 + (N-1) 即解锁时间；取所有区间里最早的一次
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, CONCAT('streak_', t.th) AS badge_key,
       MIN(DATE_ADD(STR_TO_DATE(x.start_d, '%Y-%m-%d'), INTERVAL (t.th - 1) DAY))
FROM (
  SELECT staff_id, grp, MIN(d) AS start_d,
         DATEDIFF(STR_TO_DATE(MAX(d), '%Y-%m-%d'), STR_TO_DATE(MIN(d), '%Y-%m-%d')) + 1 AS len
  FROM (
    SELECT d.staff_id, d.d,
           DATEDIFF(STR_TO_DATE(d.d, '%Y-%m-%d'), '2024-01-01') - ROW_NUMBER() OVER (PARTITION BY d.staff_id ORDER BY d.d) AS grp
    FROM (SELECT DISTINCT created_by AS staff_id, checkin_date AS d
          FROM t_lp_task_checkins WHERE review_status = 'approved') d
  ) i
  GROUP BY staff_id, grp
) x
CROSS JOIN (SELECT 3 AS th UNION ALL SELECT 7 UNION ALL SELECT 14
            UNION ALL SELECT 30 UNION ALL SELECT 60 UNION ALL SELECT 100) t
WHERE @cnt = 0 AND x.len >= t.th
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u
                  WHERE u.staff_id = x.staff_id AND u.badge_key = CONCAT('streak_', t.th))
GROUP BY x.staff_id, t.th;

-- 2.3 任务完成系列（task_done_1/5/10/20）：第 N 个完成任务的时间
-- （完成时间=已通过打卡审核时间，缺省用任务更新时间；有派发人按每人，否则创建人）
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, CONCAT('task_done_', t.th) AS badge_key, x.unlocked_at FROM (
  SELECT COALESCE(a.staff_id, t.created_by) AS staff_id,
         COALESCE(c.done_date, t.updated_at) AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY COALESCE(a.staff_id, t.created_by)
                            ORDER BY COALESCE(c.done_date, t.updated_at), t.task_id) AS rn
  FROM t_lp_tasks t
  LEFT JOIN (SELECT task_id, MIN(COALESCE(reviewed_at, created_at)) AS done_date
             FROM t_lp_task_checkins WHERE review_status = 'approved' GROUP BY task_id) c ON c.task_id = t.task_id
  LEFT JOIN t_lp_task_assignees a ON a.task_id = t.task_id
  WHERE t.task_status = 'done'
) x
CROSS JOIN (SELECT 1 AS th UNION ALL SELECT 5 UNION ALL SELECT 10 UNION ALL SELECT 20) t
WHERE @cnt = 0 AND x.rn = t.th
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u
                  WHERE u.staff_id = x.staff_id AND u.badge_key = CONCAT('task_done_', t.th));

-- 2.4 任务创建系列（task_create_5/10）：第 N 个创建任务的时间（按创建人）
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, CONCAT('task_create_', t.th) AS badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, created_at AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at, task_id) AS rn
  FROM t_lp_tasks
) x
CROSS JOIN (SELECT 5 AS th UNION ALL SELECT 10) t
WHERE @cnt = 0 AND x.rn = t.th
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u
                  WHERE u.staff_id = x.staff_id AND u.badge_key = CONCAT('task_create_', t.th));

-- 2.5 全任务达成（all_task_done）：学生名下无未完成任务时，最后一个完成任务的时间
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, 'all_task_done', MAX(x.done_date) FROM (
  SELECT COALESCE(a.staff_id, t.created_by) AS staff_id, t.task_id, t.task_status,
         COALESCE(c.done_date, t.updated_at) AS done_date
  FROM t_lp_tasks t
  LEFT JOIN (SELECT task_id, MIN(COALESCE(reviewed_at, created_at)) AS done_date
             FROM t_lp_task_checkins WHERE review_status = 'approved' GROUP BY task_id) c ON c.task_id = t.task_id
  LEFT JOIN t_lp_task_assignees a ON a.task_id = t.task_id
) x
WHERE @cnt = 0 AND x.task_status = 'done'
  AND NOT EXISTS (SELECT 1 FROM t_lp_tasks tt
                  WHERE tt.task_status IN ('todo', 'doing')
                    AND (tt.created_by = x.staff_id
                         OR EXISTS (SELECT 1 FROM t_lp_task_assignees ta
                                    WHERE ta.task_id = tt.task_id AND ta.staff_id = x.staff_id)))
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'all_task_done')
GROUP BY x.staff_id;

-- 2.6 等级系列（level_3/5/8/10）：积分账本累计首次达到阈值（利用积分账本精确推算）
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, x.badge_key, MIN(x.created_at) FROM (
  SELECT pl.staff_id, pl.created_at,
         CASE WHEN cum >= 3200 THEN 'level_10'
              WHEN cum >= 1900 THEN 'level_8'
              WHEN cum >= 700  THEN 'level_5'
              WHEN cum >= 250  THEN 'level_3' END AS badge_key
  FROM (
    SELECT staff_id, created_at, log_id,
           SUM(points) OVER (PARTITION BY staff_id ORDER BY created_at, log_id) AS cum
    FROM t_lp_point_logs
  ) pl
) x
WHERE @cnt = 0 AND x.badge_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = x.badge_key)
GROUP BY x.staff_id, x.badge_key;

-- 2.7 科目系列（subject_3/5）：第 N 个涉猎科目的首次出现时间（按任务创建时间，按创建人）
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, CONCAT('subject_', t.th) AS badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, MIN(created_at) AS unlocked_at,
         DENSE_RANK() OVER (PARTITION BY created_by ORDER BY MIN(created_at), subject) AS dr
  FROM t_lp_tasks WHERE subject <> '' GROUP BY created_by, subject
) x
CROSS JOIN (SELECT 3 AS th UNION ALL SELECT 5) t
WHERE @cnt = 0 AND x.dr = t.th
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u
                  WHERE u.staff_id = x.staff_id AND u.badge_key = CONCAT('subject_', t.th));

-- 2.8 活跃系列（active_30/100）：第 N 个活跃打卡日
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, CONCAT('active_', t.th) AS badge_key, x.unlocked_at FROM (
  SELECT created_by AS staff_id, checkin_date AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY checkin_date) AS rn
  FROM (SELECT DISTINCT created_by, checkin_date
        FROM t_lp_task_checkins WHERE review_status = 'approved') d
) x
CROSS JOIN (SELECT 30 AS th UNION ALL SELECT 100) t
WHERE @cnt = 0 AND x.rn = t.th
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u
                  WHERE u.staff_id = x.staff_id AND u.badge_key = CONCAT('active_', t.th));

-- 2.9 单日多次（day_multi_3/5）：首次单日通过打卡达 3 次 / 5 次（独立计算，避免 5 次日吞掉 3 次徽章）
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, 'day_multi_3', MIN(x.d) FROM (
  SELECT created_by AS staff_id, checkin_date AS d
  FROM t_lp_task_checkins WHERE review_status = 'approved'
  GROUP BY created_by, checkin_date HAVING COUNT(*) >= 3
) x
WHERE @cnt = 0
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'day_multi_3')
GROUP BY x.staff_id;

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, 'day_multi_5', MIN(x.d) FROM (
  SELECT created_by AS staff_id, checkin_date AS d
  FROM t_lp_task_checkins WHERE review_status = 'approved'
  GROUP BY created_by, checkin_date HAVING COUNT(*) >= 5
) x
WHERE @cnt = 0
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'day_multi_5')
GROUP BY x.staff_id;

-- 2.10 特色系列（early_bird / night_owl）：首次早间/夜间通过打卡
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, 'early_bird', MIN(x.created_at) FROM (
  SELECT created_by AS staff_id, created_at FROM t_lp_task_checkins
  WHERE review_status = 'approved' AND HOUR(created_at) BETWEEN 6 AND 9
) x
WHERE @cnt = 0
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'early_bird')
GROUP BY x.staff_id;

INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, 'night_owl', MIN(x.created_at) FROM (
  SELECT created_by AS staff_id, created_at FROM t_lp_task_checkins
  WHERE review_status = 'approved' AND HOUR(created_at) >= 21
) x
WHERE @cnt = 0
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'night_owl')
GROUP BY x.staff_id;

-- 2.11 合集系列（collection_3）：第 3 个使用合集的时间（按任务创建时间，按创建人）
INSERT INTO t_lp_badge_unlocks (staff_id, badge_key, unlocked_at)
SELECT x.staff_id, 'collection_3', x.unlocked_at FROM (
  SELECT created_by AS staff_id, MIN(created_at) AS unlocked_at,
         ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY MIN(created_at), collection_id) AS rn
  FROM t_lp_tasks WHERE collection_id > 0 GROUP BY created_by, collection_id
) x
WHERE @cnt = 0 AND x.rn = 3
  AND NOT EXISTS (SELECT 1 FROM t_lp_badge_unlocks u WHERE u.staff_id = x.staff_id AND u.badge_key = 'collection_3');
