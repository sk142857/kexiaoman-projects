# SQL 规范文档（shared/backend/sql）

本目录管理共享云托管后端数据库脚本，约定如下：

## 目录文件

| 文件 | 用途 | 何时执行 |
| ---- | ---- | -------- |
| `init_schema.sql` | 表结构 DDL（含 `DROP TABLE IF EXISTS`，**会清空数据**） | 仅全新部署 / 彻底重置时执行 |
| `init_data.sql`  | 初始化种子数据（角色/菜单/角色-菜单/数据字典/序列/超级管理员，幂等） | 建表后执行，可重复执行 |
| `upgrade_NNN_<模块名称>.sql` | 业务修复 / 升级增量脚本（保留已有数据） | 按需逐个执行，见下方规范 |

> 旧版本的历史迁移脚本（`migrate_batch*.sql`、`migrate_rename.sql`、`alter_*.sql`、
> `fix_auto_increment.sql` 等）已在「数据已同步至最新」后清理归档，不再保留。

## 使用场景

### 1. 全新部署 / 彻底重置（无历史数据）
```sql
-- 顺序执行，缺一不可
source init_schema.sql;   -- 建表（会 DROP 重建）
source init_data.sql;     -- 种子数据 + 超级管理员
```

### 2. 已有数据的库（日常业务变更）
**禁止**执行 `init_schema.sql`（会清空数据）。所有变更一律通过 `upgrade_*.sql` 增量执行。

### 3. 重置管理员密码
```bash
node -e "console.log(require('bcryptjs').hashSync('新密码',10))"
```
```sql
UPDATE staff SET staff_password = '<生成的哈希>' WHERE staff_username = 'sys_admin';
```

## upgrade 脚本规范

### 命名规则
```
upgrade_<三位序号>_<模块名称>.sql
```
- 序号从 `001` 开始，全局递增，**不可跳号、不可复用**（即使同一模块多次变更也递增）。
- 模块名称用英文小写、下划线分隔，对应变更所属业务模块，如：
  - `upgrade_001_tasks.sql`
  - `upgrade_002_dicts.sql`
  - `upgrade_004_menus.sql`

### 编写要求
1. 文件头必须写明：变更内容、影响表、执行方式、是否幂等、前置条件。
2. **优先幂等**：能加条件判断的尽量幂等（参考下方模板），保证重复执行不报错、不产生脏数据。
3. **禁止**使用 `DROP TABLE`、`TRUNCATE`（除非变更设计明确要求，且需在文件头醒目标注会丢数据）。
4. 涉及数据修复的，必须先备份受影响数据（`CREATE TABLE xxx_bak AS SELECT * FROM xxx` 或导出）。
5. 命名规范（已有约定，延续使用）：
   - 业务表主键由 `seqs` 序列统一发放，新增表/序列时必须同步初始化 `seqs` 记录；
   - `users.user_id` 保留自增；
   - 新增字段必须带 `COMMENT`，索引命名用 `idx_*`、唯一索引用 `uk_*`。
6. 菜单 / 角色 / 字典等基础数据变更，必须同时更新 `init_data.sql`（保持一致），并在文件头注明。

### 幂等写法模板

```sql
-- ============================================================
-- 升级脚本：<一句话说明>
-- 影响表：xxx
-- 执行方式：数据库控制台（DMS）或 mysql 客户端执行
-- 幂等性：是（可重复执行）
-- 前置条件：需先执行 upgrade_yyy_003.sql（如依赖）
-- ============================================================

-- 1. 加列（MySQL 不支持 ADD COLUMN IF NOT EXISTS，用 information_schema 判断）
SET @db := DATABASE();
SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = @db AND table_name = 'tasks' AND column_name = 'deadline');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE tasks ADD COLUMN deadline VARCHAR(10) NOT NULL DEFAULT '''' COMMENT ''截止日期 yyyy-MM-dd'' AFTER start_date',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. 索引（不存在才加）
SET @has_idx := (SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema = @db AND table_name = 'tasks' AND index_name = 'idx_deadline');
SET @sql2 := IF(@has_idx = 0, 'ALTER TABLE tasks ADD KEY idx_deadline (deadline)', 'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- 3. 新增表 + 序列（序列必须与表同时初始化）
CREATE TABLE IF NOT EXISTS xxx_timeline (...);
INSERT IGNORE INTO seqs (seq_key, seq_name, current_value, init_value, step)
SELECT 'xxx_event_id', 'xxx事件ID', COALESCE(MAX(event_id), 0) + 1, 1, 1 FROM xxx_timeline;

-- 4. 种子数据用 ON DUPLICATE KEY UPDATE / INSERT IGNORE
INSERT INTO menus (...) VALUES (...) ON DUPLICATE KEY UPDATE menu_name = VALUES(menu_name);
```

## 注意事项

- 本库为**微信云托管自带 MySQL**，字符集统一 `utf8mb4`，表引擎统一 `InnoDB`。
- `seqs.current_value` 为“下次发放的值”，升级脚本中计算务必 `MAX(id) + 1`。
- 执行任何 `upgrade_*.sql` 前，建议先在测试库验证，并对线上库做备份。
- 涉及 `.sql` 引用（README / 技术文档 / 代码注释）的更新，与脚本一并提交。
