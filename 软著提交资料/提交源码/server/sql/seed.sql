-- ============================================
-- 学习打卡管理平台 种子数据
-- ============================================

-- 初始管理员账号：admin / admin123
INSERT INTO t_user (account, password, name, role, status)
VALUES ('admin', '$2a$10$7EqJtq98hPqEX7fNZaFWoO5CY9g1PqU6w1iL5f2u9NwvZ4X0aJvK', '平台管理员', 'admin', 1)
ON DUPLICATE KEY UPDATE account = account;

-- 演示科目字典
INSERT INTO t_subject (name, color, sort_no) VALUES
  ('语文', '#E74C3C', 1),
  ('数学', '#3498DB', 2),
  ('英语', '#2ECC71', 3),
  ('阅读', '#9B59B6', 4),
  ('运动', '#F39C12', 5)
ON DUPLICATE KEY UPDATE name = name;
