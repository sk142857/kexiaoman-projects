# 多小程序共享云托管仓库（课小满）

微信云开发多小程序仓库。所有小程序**共享同一云环境 + 同一套云托管后端**，
登录逻辑共用，后台管理按小程序切换，业务数据按**表前缀**天然隔离。

当前已接入：

| 小程序 | 目录 | 微信 AppID | 业务表前缀 |
|--------|------|-----------|-----------|
| 课小满 | `apps/miniprogram-kxm/` | `wxa8035a4cd63554fe` | `t_lp_*` |

> 📄 完整技术架构文档见 [docs/技术架构文档.md](docs/技术架构文档.md)（技术选型、数据模型、后台管理、监控体系、部署方案）
>
> 🖥️ 管理后台 UI 设计规范见 [docs/后端UI设计规范.md](docs/后端UI设计规范.md)（React 后台通用 CRUD、组件库、图片占位符、色值约定）
>
> 🆕 新增小程序规范见 [docs/新建小程序规范.md](docs/新建小程序规范.md)

## 项目结构

```
├── apps/                       # 各小程序前端工程（微信开发者工具分别打开对应目录）
│   └── miniprogram-kxm/        # 课小满
│       ├── miniprogram/
│       └── project.config.json #   AppID=wxa8035a4cd63554fe
├── shared/backend/             # 共享云托管后端（唯一代码库，多小程序共用）
│   ├── server.js               # 服务入口（静态托管 / openid+app 解析鉴权 / 路由挂载）
│   ├── apps.js                 # 小程序注册表（X-WX-APPID → app_id 解析 + 授权）
│   ├── appAuth.js              # 登录逻辑共用（静默注册 / 资料审核 / openid 规范化）
│   ├── tables.js               # 表名映射（逻辑名 → t_/t_lp_ 物理表名）
│   ├── db.js                   # 数据库初始化（Proxy 代理 from 自动套前缀）
│   ├── seq.js / storage.js / trace.js / monitor.js / events.js / staffAudit.js
│   ├── routes/                 # 业务路由（user / system / analytics / storage / lp）
│   ├── routes/admin.js         # 后台管理（JWT 登录 / 角色菜单 / 多小程序切换 / 仪表盘）
│   ├── routes/adminApi.js      # 通用 CRUD 引擎（appField 支持按 app 维度隔离）
│   ├── admin/                  # 后台管理前端源码（React + antd，构建产物入 public/admin）
│   ├── sql/                    # 建表 / 种子数据 / 增量升级脚本
│   └── Dockerfile              # 多阶段容器构建
└── docs/                       # 全仓文档（架构 / UI / 规范 / 新建小程序规范）
```

## 多小程序架构（共享环境）

- **环境共享**：同主体下多个小程序绑定到同一云开发环境（云开发控制台「多小程序共享环境」），
  一套云托管服务 + 一套 MySQL，靠业务表前缀隔离数据。
- **登录共用**：`shared/backend/appAuth.js` 提供统一静默注册/资料审核；云托管注入 `X-WX-OPENID`、
  `X-WX-APPID`，后端把 openid 统一去 `{AppID}_` 前缀存储（兼容历史数据），并以 `t_users.app_id`
  记录来源小程序。
- **后台区分小程序**：登录后顶部「小程序切换器」；管理员可管理的小程序由 `t_staff_apps` 授权
  （admin 角色默认全部）；所有 `/api` 模块按当前 app 过滤（`requireAppAccess` + CRUD `appField`）。
- **表前缀约定**（见 `shared/backend/tables.js`）：
  - `t_` 系统表（共享）：`t_users / t_staff / t_menus / t_seqs / t_file_uploads / t_apps / ...`
  - `t_lp_` 学习业务表：`t_lp_tasks / t_lp_task_checkins / ...`
  - 业务表**不再加 app_id 列**（靠前缀隔离）；仅共享系统表保留 app_id 用于后台区分来源。

## 课小满（环境内直调云托管）

课小满已绑定云环境 `cloud1-d6gddqzrsda16338f`，前端通过 **`wx.cloud.callContainer` 直调云托管服务**
（`X-WX-SERVICE: kxm-service`），`X-WX-OPENID` / `X-WX-APPID` 由云托管网关自动注入，无需配置 request 合法域名 / 域名备案。

| 项 | 说明 |
|----|------|
| 登录 | `POST /api/lp/login`（wx.login code → code2session 换 openid，复用 `appAuth` 共享登录；返回 `identities[]` 多身份列表 + 活动身份） |
| 绑定 | `POST /api/lp/bind`：输入 6 位大写邀请码，绑定 openid ↔ 学生账号（`t_lp_students`）；**多身份追加绑定**（家长/孩子/家属可共存于同一 openid） |
| 切换 | `POST /api/lp/switch`：切换活动身份（家长↔孩子↔家属）；切到家长/管理员需 PIN（若已设置） |
| 鉴权 | `lpAuth` 中间件校验 LP JWT（含活动身份 staffId），**每次请求实时复核该绑定状态，作废即刻锁定** |
| 业务 | `/api/lp/profile · dashboard · tasks · checkins · collections · upload`（操作 `t_lp_*`，学生=staff_id） |
| 学生身份 | 首次绑定自动建 `role=student` 的 `t_staff` 记录并生成绑定映射，与后台学习模块数据打通 |

**邀请码准入**：邀请码独立维护在 `t_lp_invites`（不再挂 `t_staff`），6 位大写（生成时排除 0/O/1/I），分三类：
- `student` 学生码：主家长在孩子档案中生成，绑定孩子学生账号（role=student），仅可绑定一次（未绑定可用）。
- `parent` 家长码：管理员在后台「邀请码管理」为已注册主家长账号生成（单次使用，绑定即作废），家长小程序「我是家长→绑定已有账号」输入即可绑定，无需自动建号。
- `family` 家属共享码：主家长生成（单次使用，绑定即作废），绑定后建家属账号（role=family）并写入家属关系。

**家长入驻两种模式**：
- 无码自动建号：小程序「我是家长→创建新账号」自动建后台账号（密码可查看/重置）+ 生成家属共享码；
- 后台发码只绑定：管理员先建主家长账号并生成家长码，家长输入码绑定，避免「后台一个账号、小程序一个账号」双账号。

**身份与角色**：首次静默登录后需选择身份（家长 / 学生 / 家属），绑定后形成身份；**支持一 openid 多身份（共用微信）**：
- `parent` 主家长：自动建后台账号（密码点击查看，可重置）+ 生成家属共享码；可维护孩子档案、管理本家庭任务与打卡审核；**可设置身份 PIN 锁**。
- `family` 家属：输入共享码进入，除孩子档案维护外与主家长相同（可审核，仅查看档案）。
- `student` 学生：输入学生码绑定，仅本人任务/打卡，无审核权限。
- `admin` 平台管理员：全量（含系统设置）。
- **共用微信（家长 + 孩子一台手机）**：同一 openid 可同时绑定家长与孩子身份（`t_lp_students` 唯一键 `(app_id, openid, staff_id)`），
  「我的」页可切换身份；切到家长身份若已设 PIN 锁则需校验 PIN（`t_staff.pin_hash`，bcrypt，家长自选开启，防止孩子越权切家长模式）。
- 各有手机场景不变：openid 各自绑定单身份，无切换 UI。

**孩子档案**：主家长在【我的】→【孩子档案】维护（姓名/性别/出生年月/学校/年级班级如 四（6），班级 1-35），并为每个孩子生成学生邀请码。
**绑定关系**：后台「学习管理 → 绑定管理」集中管理 `t_lp_students`（openid ↔ 账号），支持解除/变更绑定。
**管理员后台**：家长角色登录后菜单收敛「学习管理」且数据限定本家庭；平台管理员可管理全部。

**运行配置（存表，后台维护，不用环境变量）**：课小满的 AppSecret / JWT 密钥等配置在
`t_apps` 表（后台「系统设置 → 小程序配置」维护）：`app_secret`（code2session）、`jwt_secret`、`jwt_expires`、`service_url`。
后端缓存 60s，修改后最多 1 分钟生效；未配置时登录/绑定会报错并打印告警。

**环境内直调要点**：
- 小程序前端：`apps/miniprogram-kxm/miniprogram/utils/api.js` 定义 `CLOUD_ENV`（`cloud1-d6gddqzrsda16338f`）
  与 `CLOUD_SERVICE`（`kxm-service`），所有请求经 `wx.cloud.callContainer` 携带 `X-LP-Token` 调用 `/api/lp/*`。
- 部署：需在云开发控制台把课小满绑定到云环境 `cloud1-d6gddqzrsda16338f`（多小程序共享环境），
  云托管服务名部署为 `kxm-service`。
- 图片/视频/语音均走 `wx.cloud.uploadFile` **直传云存储**（绕过 callContainer 100KB 请求体限制），
  再调 `/api/storage/upload` 登记 `t_file_uploads`（该接口以 `X-LP-Token` 会话验签确认身份，不再信任 `X-WX-OPENID` 请求头）。

> 安全提示：`t_apps.app_secret` 为明文存储，请收敛 `t_apps` 表的访问权限，勿将含密钥的数据导出仓库。
>
> 安全提示：后台管理 JWT 仅接受环境变量 `ADMIN_JWT_SECRET`，未配置时后台登录/鉴权一律拒绝（fail-closed），不会回退内置弱密钥。
> 课小满小程序会话 `jwt_secret` 缺失时登录/绑定同样拒绝并提示，请在后台「小程序配置」中配置后再启动。
>
> 安全提示：`t_apps.app_secret` / `jwt_secret` 未配置时，登录、绑定及 `X-LP-Token` 相关接口全部拒绝（fail-closed），需在后台配置后恢复。
>
> 安全提示：邀请码为弱共享密钥（6 位），`/api/lp/bind` 已做失败限流（同一 openid 15 分钟 10 次）；请定期轮换邀请码。

## 积分制度（积分账本，可审计可减分）

课小满积分从「现算只增不减」升级为**账本式**（表 `t_lp_point_logs`，逻辑名 `point_logs`），
每次加分/减分写一条流水（`reason` 区分原因），**经验值 = 账本累加**，杜绝待审核/被驳回误计与只增不减。

| 事件 | 变动 | 流水 reason |
|------|------|------------|
| 打卡审核通过 | +10 | `checkin_approved` |
| 任务完成（状态转 done） | +30（有派发人则每人，否则创建人） | `task_done` |
| 删除已通过打卡 | -10 | `checkin_deleted` |
| 已完成任务回退（done→doing/todo） | -30 | `task_undone` |
| 删除已完成任务 | -30 + 该任务已通过打卡每人 -10 | `task_deleted` / `checkin_deleted` |

- 加分/减分幂等：按「状态变迁」判定（如任务 old→new 才计分），重复调用不重复计。
- 审核驳回本身不加分也不扣分（从未计分，无需回扣）。
- 后台「学习仪表盘 → 选中单个学生 → 积分明细」可审计最近 10 条加减分流水；余额即 `level.xp`。
- 存量回填：`sql/upgrade_035_points_ledger.sql` 一次性把历史已通过打卡（+10）与已完成任务（+30）补录进账本，
  并自动纠正旧公式把待审核/驳回打卡计入经验的问题（经验小幅回落属预期修复）。
- 等级阈值（Lv.1~10，满级 3200 XP）见 `learningLib.js LEARNING_LEVELS`，经验上限可后台按需调整。

## 成就徽章系统（解锁落库，记录达成时间）

徽章从「每次现算」升级为**解锁落库**（表 `t_lp_badge_unlocks`，逻辑名 `badge_unlocks`）：
仪表盘计算时把**新解锁**的徽章写入记录（`staff_id + badge_key` 唯一，幂等），响应附带 `unlocked_at` 解锁时间，
可在后台徽章悬停提示 / 小程序「我的奖章」墙展示「xxxx-xx-xx 解锁」。

- 运行时落库：首页/奖章页每次打开都会调 `/api/lp/dashboard`，达标即记录，时间精确到"下次打开 App 时"（学生打开 App 频率高，误差很小）。
- 存量回填：`sql/upgrade_036_badge_unlocks.sql` 用触发事件时间**估算**历史解锁时间（第 N 次通过打卡时间 / 连续打卡第 N 天 / 积分账本累计首达阈值等）。
  滚动型徽章（`perfect_week` 近 7 天全勤）不做回填，运行时首次达标时记录。
- 部署顺序：先跑 `upgrade_035_points_ledger.sql`（积分账本，等级徽章回填依赖它），再跑 `upgrade_036_badge_unlocks.sql`。

## 学习仪表盘（Web 后台）学生切换

`/dashboard/learning` 支持按学生视角查看：

- **管理员**：默认「全部学生」汇总，可下拉切换到任意单个学生（统计该学生派发+创建的任务与打卡）。
- **家长/家属**：默认第一个孩子，仅能切换**名下孩子**（`lp_children` 关系），越权切换自动回退。
- **学生**：固定本人。
- 切换选择存 `localStorage`（`lp_admin_view_student`），刷新后保持。
- 后端接口：`/api/admin/dashboard/learning?studentId=xxx`（`studentId` 留空=默认视角）；
  响应含 `students`（可切换列表）与 `viewStudentId`（当前视角，空串=全部）。

## 内容审核机制

用户提交的**打卡**默认进入 `pending`（待审核）状态：

- **前端展示脱敏**：未审核通过（待审核/已驳回）的内容，正文用 `****` 代替，图片以「加锁审核」占位代替，防止截图传播未审核信息；列表与详情带状态角标（审核中 / 已驳回）。
- **待审核记录严禁操作**：打卡被拦截（前后端双重校验），仅允许删除；已驳回的内容可编辑后重新提交，重新进入审核流程。
- **后台审核**：管理后台「打卡审核」支持按审核状态筛选，提供 **通过 / 驳回** 操作；审核通过后才正常展示。
- **存量数据**：审核系统上线前已有的记录需执行 `UPDATE ... SET review_status='approved'` 回填（此类数据修复统一以 `upgrade_*.sql` 增量脚本执行，规范见 `shared/backend/sql/README.md`）。

## 图片上传

- 前端选择图片后**仅本地预览**（选原图，压缩统一由后端异步完成），通过 `wx.cloud.uploadFile` **直传云存储**（绕过 `callContainer` 100KB 请求体限制，错误码 `-606001`），再调 `/api/storage/upload` 登记 `t_file_uploads` 记录表。
- 列表/详情展示使用 `previewUrl` 缩略图（数据万象 `imageMogr2/thumbnail`），lightbox 查看原图，减少流量。
- 存储桶：`636c-cloud1-d6gddqzrsda16338f-1467751604`；共享存储根路径 `kxm`；按业务分目录，如任务图片 `kxm/tasks/yyyy-mm-dd/{fileId}.jpg`。
- 图片公开访问域名：`https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la/{路径}`（前端/后台拼接完整域名）。
- ⚠️ 小程序端 `<image>` 展示该域名图片，需在微信公众平台配置 **downloadFile 合法域名**。

## 语音打卡存储

- 语音目录：`kxm/voice/{yyyy-MM-dd}/{fileId}.mp3`（业务类型 `voice`，见 `storage.js` 白名单）。
- 小程序端录音（`utils/voice.js`，mp3 ≤60s）→ `wx.cloud.uploadFile` 直传云存储 → `/api/storage/upload` 登记 `t_file_uploads`（语音走直传，避免 callContainer 请求体限制）。
- 打卡提交带 `voiceUrl`（相对路径）+ `voiceDuration`（秒），展示用 `voice-player` 组件（`wx.createInnerAudioContext`）或后台 `<audio>` 播放。
- 音频播放/下载域名与图片同一域名，已在微信公众平台配置。

## 环境初始化

### 1. 建表 / 升级（云托管自带 MySQL）

- **全新部署**：执行 `shared/backend/sql/init_schema.sql`（建表，`DROP` 重建）→ `shared/backend/sql/init_data.sql`（种子数据）。
- **已有数据的库**：按序号执行 `shared/backend/sql/upgrade_*.sql` 增量脚本（禁止执行 init_schema，会清库）。
- 多小程序支持已内置：`t_apps`（小程序注册表）、`t_staff_apps`（员工-小程序授权）、
  共享系统表 `app_id` 列、业务表 `t_lp_*` 重命名，全部收敛在 `upgrade_009_apps.sql`。

### 2. 云环境绑定

将课小满绑定到云环境 `cloud1-d6gddqzrsda16338f`
（云开发控制台 → 环境 → 更多 → 多小程序共享），并在 `t_apps` 中登记其 AppID。

### 3. 表权限

| 表 | 权限 | 说明 |
|------|------|------|
| `t_user_sessions` | 所有用户不可读写 | 仅云托管写入，前端禁止直连 |
| 其余业务表 | 仅创建者可读写 | 数据按 openid 隔离 |

## 云托管部署

云托管共享后端在 `shared/backend/` 目录，通过微信云托管控制台部署（Dockerfile 构建，代码根目录指向 `shared/backend/`）。

部署前需在各小程序前端 `utils/api.js` 配置（共享同一环境与服务）：
- `CLOUD_ENV`：云开发环境 ID（`cloud1-d6gddqzrsda16338f`）
- `CLOUD_SERVICE`：云托管服务名（`kxm-service`）

前端 `wx.cloud.callContainer` 请求头 `X-WX-SERVICE` 必须与服务名一致。

## Skyline 底部固定按钮布局方案

在 Skyline 渲染下实现「底部操作栏固定 + 内容区滚动」的可靠写法（已在 iPhone 12 真机验证）。

### 结构（WXML）

```xml
<view class="detail-page">
  <view class="block">
    <t-navbar title="页面标题" placeholder="{{true}}" />
  </view>

  <scroll-view class="detail-scroll" scroll-y>
    <view class="detail-main">...</view>
  </scroll-view>

  <!-- 底部操作栏：flex 子项，自然贴底 -->
  <view class="detail-actions">
    <view class="detail-btn detail-btn--save">保存</view>
    <view class="detail-btn detail-btn--delete">删除</view>
  </view>
</view>
```

### 关键样式（WXSS）

```css
/* 页面根容器：flex 纵向布局 + 满屏高度 */
.detail-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* 滚动区：flex:1 吸收剩余高度，内容超高时内部滚动 */
.detail-scroll {
  flex: 1;
  overflow: hidden;   /* 注意：必须是 overflow: hidden，而非 overflow-y: hidden */
}

/* 底部操作栏：flex 子项，flex-shrink:0 固定贴底 */
.detail-actions {
  flex-shrink: 0;
  padding: 20rpx 40rpx 48rpx;  /* 底部固定 padding，避免紧贴屏幕底 */
  background: #fff;
  border-top: 1rpx solid #eee;
}
```

### 页面 JSON 配置

```json
{
  "navigationStyle": "custom",
  "disableScroll": true
}
```

### 踩坑记录（重要）

| 错误做法 | 问题 | 正确做法 |
|---------|------|---------|
| `overflow-y: hidden` | Skyline 的 `overflow` 只支持整体 `hidden/visible`，不支持单独 x/y 轴，样式不生效 | `overflow: hidden` |
| `position: sticky` 做底部栏 | Skyline 不支持 CSS sticky（需用 sticky-header 组件替代） | flex 子项 + `flex-shrink: 0` |
| `position: fixed` 做底部栏 | 真机与开发者工具 vh 计算不一致，按钮位置偏移 | 纯 flex 文档流布局 |
| `env(safe-area-inset-bottom)` 适配 | Skyline 真机上可能不生效，按钮紧贴屏幕底 | 固定底部 padding（如 `48rpx`）兜底 |
| scroll-view 加 `enhanced`/`show-scrollbar` | 这两个是 WebView 特有属性，Skyline 下可能干扰滚动 | 仅用 `scroll-y` |

### 要点总结

1. **页面根容器**必须是 flex column + `100vh`
2. **滚动区** `flex:1` + `overflow: hidden`，依赖 `scroll-y` 属性滚动
3. **底部栏**作为 flex 子项（`flex-shrink: 0`）自然贴底，不依赖 sticky/fixed
4. 底部 padding 用**固定值**兜底，不依赖 `env()`
5. 页面 JSON 需 `disableScroll: true`（防止页面自身滚动与 scroll-view 冲突）

## 云函数（已全部废除）

> ⚠️ 原 `lpProxy` 反向代理云函数已删除，课小满改为 `wx.cloud.callContainer` 环境内直调云托管，仓库内不再有任何云函数。
