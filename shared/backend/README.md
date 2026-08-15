# 多小程序共享云托管后端 - 部署说明

本目录 `shared/backend/` 是**微信云托管（CloudBase Run）共享服务**，承载课小满等小程序的业务接口与后台管理，
供仓库内各小程序共用。

> 📄 完整技术架构见仓库根目录 [docs/技术架构文档.md](../docs/技术架构文档.md)
> 🖥️ 后台 UI 设计规范见 [docs/后端UI设计规范.md](../docs/后端UI设计规范.md)
> 🗄️ SQL 规范见 [sql/README.md](sql/README.md)
> 🆕 新增小程序见 [docs/新建小程序规范.md](../docs/新建小程序规范.md)

## 目录结构

```
shared/backend/
├── Dockerfile        # 多阶段容器构建（admin-build + 运行时，Node 20）
├── server.js         # HTTP 服务入口（静态托管 + 健康检查 + openid/app 鉴权 + 业务路由 + 链路追踪 + 监控）
├── apps.js           # 小程序注册表（X-WX-APPID → app_id 解析 / t_apps / t_staff_apps 授权）
├── appAuth.js        # 登录逻辑共用（静默注册 / 资料审核 / openid 去前缀规范化）
├── tables.js         # 表名映射（逻辑名 → t_/t_lp_ 物理表名）
├── db.js             # 数据库初始化（Proxy 代理 db.from 自动套前缀）
├── seq.js            # 主键序列发放（t_seqs 表）
├── response.js       # 统一 ok/fail 响应
├── utils.js          # 工具函数（时间/连击/月份范围/ID 生成）
├── trace.js          # 接口调用链路追踪中间件
├── monitor.js        # 系统监控（每 10 分钟采集）
├── storage.js        # 云存储上传/删除（COS + t_file_uploads 登记 + 数据万象缩略图）
├── staffAudit.js     # 后台 staff 操作审计
├── events.js         # 用户操作事件
├── taskTimeline.js   # 任务/打卡业务时间轴
├── routes/           # 业务路由（user/system/analytics/storage/lp）
├── routes/admin.js   # 后台管理路由（JWT 登录/角色菜单/多小程序切换/仪表盘）
├── routes/adminApi.js# 通用 CRUD 引擎（配置驱动 + appField 按 app 隔离）
├── admin/            # 后台管理前端源码（React + antd，Vite 构建）
├── public/admin/     # 后台构建产物（Express 静态托管）
├── sql/              # 建表 / 种子数据 / 增量升级脚本
└── package.json      # 依赖（express + @cloudbase/js-sdk + ws）
```

## 多小程序与表前缀

- 多小程序共享同一云环境与同一套后端；后台顶部「小程序切换器」按 `t_staff_apps` 授权切换。
- 业务表按前缀隔离归属，**不加 app_id 列**；共享系统表（`t_users` 等）保留 `app_id` 列：
  - `t_` 系统表（共享）：`t_users / t_staff / t_menus / t_seqs / t_file_uploads / t_apps / t_staff_apps / ...`
  - `t_lp_` 学习业务表：`t_lp_tasks / t_lp_task_checkins / ...`
- 后端代码统一写**逻辑表名**（`db.from("tasks")`），由 `tables.js` + `db.js` Proxy 自动映射。

## 课小满接口（环境内直调）

课小满前端经 `wx.cloud.callContainer` 直调云托管（`X-WX-SERVICE: kxm-service`），路由 `/api/lp/*`（操作 `t_lp_*` 表）：

- `POST /api/lp/login` / `POST /api/lp/bind`：code2session 登录 + 6 位邀请码绑定（学生=staff_id 身份，`t_lp_students` 映射）。
- 其余 `/api/lp/*`（profile / dashboard / tasks / checkins / collections / upload）走 `lpAuth` JWT，
  每次请求实时复核邀请码状态（作废即锁定）。
- 邀请码生成/作废接口：`POST /api/staff/generateInvite`、`POST /api/staff/revokeInvite`（后台管理员管理）。
- 前端：`apps/miniprogram-kxm/miniprogram/`（登录/绑定/仪表盘/任务/打卡/合集/我的）。

> ⚠️ **AI-SKIP 警告**：`package.json` 中的 `ws` 依赖**不可删除**。
> `@cloudbase/js-sdk` 的 `app.rdb()` 运行时通过 WebSocket 连接 MySQL，动态 require `ws`。
> 源码中没有显式 `require('ws')`（运行时注入），删除后所有 db 操作报「缺少依赖 ws」，
> 导致业务、系统监控、链路追踪全部失败。详见 `db.js` 顶部注释。

## 在微信云后台部署

### 方式一：微信开发者工具（推荐）

1. 打开项目 → 云开发控制台 → **云托管**
2. 点击「新建服务」，服务名 `kxm-service`
3. 镜像来源选择 **代码构建**（Dockerfile 构建）
4. 代码来源选 **本目录 `shared/backend/`**（或关联 Git 仓库，代码根目录指向 `shared/backend/`）
5. 端口填 `80`，等待构建部署

### 方式二：Git 仓库自动部署

1. 代码已推送到 GitHub（`shared/backend/` 在仓库内）
2. 云托管 → 新建服务 → 代码来源选 **Git**（关联 `github.com/sk142857/breakup-app.git`）
3. 构建根目录填 `shared/backend/`，Dockerfile 路径 `shared/backend/Dockerfile`
4. 保存后自动触发首次构建部署

## 验证部署成功

部署完成后，访问服务默认域名：

```
https://<服务域名>/
```

应返回：

```json
{ "status": "ok", "service": "kxm-service", "time": "..." }
```

访问 `/healthz` 返回 `{ "status": "ok" }`（云托管探活正常）。

## 后续迁移业务（可选）

如需把其他云函数业务迁到云托管，需在 `server.js` 中用 `@cloudbase/js-sdk` 初始化数据库、把逻辑改写为 Express 路由，
前端用 `wx.cloud.callContainer` 直调（`X-WX-SERVICE` 指定服务名），并处理鉴权。

> ⚠️ 云托管按容器资源持续计费（常驻实例），个人项目请评估成本后再迁移。

## 后台管理（cloud admin）

管理后台地址：`<服务域名>/admin`，使用独立 JWT 登录鉴权（不走小程序 openid）。
支持**角色-菜单权限体系**：默认内置「管理员」（全部菜单）与「学生」（仅学习管理）两个角色，
可通过「角色管理」为角色分配菜单，「菜单管理」动态维护菜单，前端菜单从 `/admin/menus` 动态加载。

**多小程序支持**：后台顶部提供「小程序切换器」（`/admin/myApps`）。管理员（admin）默认拥有全部小程序；
其他角色在 `系统设置 → 管理员管理` 中通过「小程序权限」分配可管理的小程序（`t_staff_apps`）。
切换后所有业务接口按当前小程序过滤（学习模块走 `t_lp_*` 表、共享系统表按 `app_id` 过滤）。

> ⚠️ 首次部署需执行 `sql/init_schema.sql`（建表）→ `sql/init_data.sql`（初始化角色/菜单/字典/
> 序列/超级管理员种子数据）；已有数据的库请勿执行 `init_schema.sql`（会清空数据），
> 业务变更统一走 `sql/upgrade_*.sql` 增量脚本（规范见 `sql/README.md`）。

### 必须配置的环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_JWT_SECRET` | 后台 JWT 签名密钥，**强烈建议配置**。未配置时回退内置密钥并打印警告（生产环境务必配置） |

> 课小满运行配置（AppSecret / JWT 密钥等）**不用环境变量**，存在 `t_apps` 表，后台
> 「系统设置 → 小程序配置」维护（`app_secret` / `jwt_secret` / `jwt_expires` / `service_url`），后端缓存 60s。

> 在云托管控制台 → 服务 → 环境变量中配置。更改 `ADMIN_JWT_SECRET` 会使已签发的登录态全部失效。

### 初始化管理员账号

账号初始化/改密通过 SQL 完成，全新部署时 `sql/init_data.sql` 已自动创建超级管理员（sys_admin / sk0987，幂等）。

```sql
-- 初始账号 sys_admin / sk0987（bcrypt 存储，幂等，可重复执行）
INSERT INTO staff (staff_username, staff_password, staff_nickname, staff_role, staff_status, created_at, updated_at)
SELECT 'sys_admin', '$2a$10$...', '超级管理员', 'admin', 1, NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM staff WHERE staff_username = 'sys_admin');
```

修改密码：重新生成 bcrypt 哈希后 `UPDATE staff SET staff_password='<新哈希>' WHERE staff_username='sys_admin'`。
生成哈希：`node -e "console.log(require('bcryptjs').hashSync('新密码', 10))"`。

### 学习管理（仅后台，与小程序无关）

- **任务管理**：为小朋友布置学习任务，支持增删改查、状态流转（未开始/进行中/已完成）、评分（0-10，新增固定 0 分）、**派发学生**（管理员可多选派发给学生，学生自建任务派发固定为本人）、图片上传（最多 9 张）、合集归类与任务打卡；新增/编辑为左右双列布局（左侧主字段 + 右侧图片/描述/链接），带「复制创建」与任务时间轴（流程）抽屉。
- **打卡管理**：针对学习任务的打卡记录，图片最多 9 张，支持按打卡日期筛选；任务已完成（done）时禁止修改/删除打卡。
- **合集管理**：任务合集（封面/描述/启用状态），删除合集自动解除其下任务归属，避免孤儿引用。
- **学习仪表盘**：面向学生的游戏化成长页——经验值/等级（打卡 +10、完成任务 +30）、连续打卡连击、成就徽章、近 7 天趋势、科目分布、任务打卡排行，以及后端生成的分级提醒文案（逾期/临期/进度偏低/今日未打卡）；学生按任务派发范围统计，管理员为全员汇总；统计口径剔除已删除任务/打卡（孤儿打卡不计数、不展示）。
- **任务审计**：任务/打卡全生命周期写入 `task_timeline`，后台「流程」抽屉审计展示（含修改前后值、打卡图片等）；删除任务前统计关联打卡/图片并级联清理。
- **数据字典**：`字典类型`/`字典项` 两个模块维护字典数据，任务「科目」、性别、任务状态等下拉选项均从字典加载（`dict_items` 表，默认内置 subject/gender/task_status 字典，字典项可配置颜色用于标签着色）。
- 学生角色登录后可访问「学习仪表盘」与「学习管理」（任务/打卡/合集），且只能管理自己创建的任务/打卡；管理员可查看全部。

### 安全说明

- 登录限流：同一 IP+账号 15 分钟内最多 5 次尝试，防暴力破解。
- 角色-菜单权限：非管理员角色仅可访问其角色已分配菜单对应的模块，后端按菜单做模块级鉴权。
- 「管理员管理」模块中填写密码可改密，留空则不修改；列表/详情响应不返回密码哈希。
- 401（登录过期/无效）：前端统一清除凭证并强制跳转登录页。
