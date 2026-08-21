# 共享云托管后端 - 管理后台 UI 设计规范

> 本文档定义管理后台（`shared/backend/admin`，React + antd 5 + @ant-design/pro-components）的 UI 设计规范。
> 后台前端源码位于 `shared/backend/admin/src`，构建产物同步到 `shared/backend/public/admin`（云托管静态托管，`/admin`）。
> 所有后台 UI 相关的统一标准持续补充到本文档，避免各模块各写各的样式。

---

## 1. 总览：配置驱动的通用 CRUD

后台绝大多数业务页面（用户/任务/打卡/合集/管理员/字典/序列等）由 `CommonCrud.jsx` 一个组件承载，
**不写业务页面**，而是通过 `config/modules.jsx` 中的模块配置声明式描述：

| 配置项 | 说明 |
|--------|------|
| `columns` | 表格列（`dataIndex`/`render`），渲染函数使用 `fields.jsx` 的组件库 |
| `detailFields` | 详情抽屉字段（`{ name, label, type, span, map, dict, ... }`），`DetailDrawer` 按类型渲染 |
| `formFields` | 新增/编辑表单字段（`{ name, label, type, span, rules, ... }`），支持 `side:'right'` 左右布局 |
| `filters` | 顶部等值筛选（静态 options 或 `optionsSource` 动态加载字典/表） |
| `searchable` / `searchKey` | 列表关键字模糊搜索字段 |
| `readonly` / `noCreate` / `allowDelete` / `allowBatchDelete` | 读写能力开关 |
| `formColumns` / `modalWidth` / `drawerWidth` / `drawerColumns` | 布局尺寸 |
| `review` / `checkin` / `timeline` / `menuTree` / `collectionPicker` | 特殊能力开关 |
| `gridOps` / `copyCreate` / `copyReset` | 操作列网格布局 / 复制创建 / 复制时归零字段 |
| `ownField` / `createDefaults` / `deleteTip` | 数据隔离 / 新增默认值 / 自定义删除确认 |
| `entityName` / `pk` / `tableScroll` | 实体名 / 显式主键 / 表格滚动 |

> 新增模块时的标准做法：在 `MODULES` 中新增一条配置，通常无需改 `CommonCrud`。

---

## 2. 字段渲染组件库（`components/fields.jsx`）

所有「值 → 组件」渲染统一封装在 `fields.jsx`，页面禁止裸写 `<Tag>`/`<Image>`/三元表达式。

### 2.1 状态 / 枚举

| 组件 | 用途 | 说明 |
|------|------|------|
| `StatusTag` | 枚举值 Tag | `map: { key: { label, color } }`，空值渲染 `-` |
| `ColorTag` | 带色值 Tag | 自定义 hex 或 antd 标准色 |
| `DictTag` | 数据字典 Tag | 按 `dict_code` 加载，取 `item_label` + `item.color` 着色，模块级缓存 |
| `BoolTag` | 布尔 | `yes/no`（默认 是/否） |
| `HttpStatusTag` | HTTP 状态码 | 2xx绿/3xx蓝/4xx橙/5xx红 |
| `ScoreTag` | 任务评分 | 10 优秀绿 / 7-9 良好蓝 / 5-6 中等金 / 0-4 较差红 |
| `AssigneeTags` | 派发人员 Tag | 紫色标签列表，空显示「未派发」 |

### 2.2 文本

| 组件 | 用途 |
|------|------|
| `EmptyText` | 空值占位「-」（普通文本字段默认） |
| `PlainText` / `CopyText` | 单行省略文本（可复制） |
| `LongText` | 多行长文本（pre-wrap，详情用） |
| `LinkText` | 长文本 + URL 自动识别为链接 |
| `MaskId` | 长 ID 中间截断 `***`，完整值可复制 |
| `JsonBlock` | JSON 语法高亮 + 美化 |

### 2.3 数值 / 状态指示

| 组件 | 用途 |
|------|------|
| `Percent` | 百分比进度条 |
| `MemBar` | 内存已用/总量 + 进度条（>85% 异常色） |
| `CostText` | 耗时彩色纯文本（正常绿/超阈值红，不用 Tag） |
| `LevelText` | 等级（如冲动程度） |
| `StarRate` | 星级评分（只读） |

### 2.4 用户 / 员工 / 图片

| 组件 | 用途 | 说明 |
|------|------|------|
| `UserCell` | 用户单元 | 头像45px + 用户ID + 昵称 |
| `StaffCell` | 后台员工单元 | 昵称首字头像 + 员工ID + 昵称 |
| `UploaderCell` | 上传者单元 | 员工优先，否则为小程序用户 |
| `ImageAvatar` / `EmojiAvatar` | 头像 | 无图/加载失败回退昵称首字（字母大写） |
| `ImagePlaceholder` | 空图占位框 | **全后台统一空图标准**，见 §4 |
| `TableImages` | 表格缩略图 | 内置预览 + 占位 + `+N` 角标 |
| `CoverThumb` | 封面单图 | 合集封面专用，占位样式统一 |
| `ImageGallery` | 详情大图 | 内置预览 + 占位 |
| `ImageList` / `NineGridImages` | 图片列表 | 缩略图网格 |
| `ImageUploader` | 表单图片上传 | base64 直传，多选并发（2 并发），九宫格/单图两种形态 |

> **缩略图约定**：列表/表格/详情一律用 `toThumbUrl()`（数据万象 `?imageMogr2/thumbnail/300x300`，详情 600）
> 渲染，避免拉原图；点击预览时 `preview={{ src: 原图 }}`。封面/头像等外部 URL 不做处理。

---

## 3. 通用设计准则

### 3.1 表格（ProTable）

1. **默认禁止横向滚动条**（`tableScroll: false`），列数多时通过合理压缩列宽 / 省略号适配；确需横向滚动的模块显式传 `{ x: ... }`。
2. **长文本列**统一 `PlainText`（单行省略 + title）或 pre-wrap 多行，禁止整行溢出撑破布局。
3. **宽列固定宽度**：ID/时间/状态等窄列固定 `width`，描述等文本列 `width: 220~240` 或省略。
4. **图片列**一律 `TableImages`（无图自动渲染占位框，禁止回退「-」）。
5. **操作列**：单行按钮或 `gridOps` 2行3列网格（任务/打卡管理），按钮用 `type="link"` + `size="small"`。
6. 首列非主键的模块必须显式配置 `pk`（如 users 的 `user_id`），否则编辑/删除/审核 id 错配。

### 3.2 详情抽屉（DetailDrawer）

- 基于 `detailFields` 元数据 + `Descriptions bordered` 渲染，`column` 由 `drawerColumns` 控制（默认 2）。
- label 固定宽度 110px 不换行，value 区可换行折行（`table-layout: fixed`）。
- 特殊模块抽屉更宽：任务 820 / 操作审计 860 / 服务监控 920 / 会话画像 1080。
- 长 JSON（请求参数、事件详情）用 `JsonBlock`；图片用 `ImageGallery`；审核/状态用 `StatusTag`。

### 3.3 表单（新增/编辑弹窗）

1. `formColumns: 2` 时字段默认 span=12 双列；单列模块 span=24。
2. 只读主键展示用 `type: 'pk'`（编辑显示 ID，新增提示「创建后自动生成」）。
3. **左右布局**（`side: 'right'`）：任务管理表单左侧为主字段（标题/状态/日期/评分/派发），右侧 420px 放图片/描述/链接，`modalWidth: 1000`。
4. **派发学生字段**（`type: 'assignee'`）：学生登录时禁用并强制本人，提示「学生自建任务派发固定为本人」；管理员可多选。
5. **禁用时机**：新增时禁用的字段用 `disabledWhenCreate`（如任务评分新增固定 0 分），`tip` 支持函数式提示。
6. **复制创建**（`copyCreate`）：复制时重置时间字段，`copyReset` 指定归零字段（如评分）。

### 3.4 弹窗 / 确认

- 审核/删除/打卡均用**页面级 Modal**，禁用行级 Popconfirm（保证一致性）。
- 删除确认支持 `deleteTip` 自定义文案（如任务级联删除提醒，先请求 `deleteStats` 统计打卡/图片数）。
- 危险操作（删除/批量删除/驳回）`okButtonProps` 设 `danger`。

### 3.5 时间轴抽屉（TimelineDrawer）

- 任务/打卡「流程」按钮打开 `TimelineDrawer`（antd Timeline）。
- 事件节点按类型用不同图标/颜色（创建绿/完成绿/打卡蓝/修改紫/删除红…）。
- 关键内容按类型结构化展示（创建→科目/日期；打卡→备注/图片；更新→旧值→新值 变更明细；删除→状态/累计打卡）。
- 底部标注操作人 36px 头像 + 昵称/账号。

---

## 4. 空图片占位符（统一标准）

管理后台所有图片展示，在「无图片」时**必须**统一渲染灰色虚线占位框（图片图标 + 「暂无图片」），
**禁止**回退成通用文本空值「-」（`EmptyText`）。

### 4.1 标准组件

统一使用 `fields.jsx` 中的图片展示组件，无图时自动渲染 `ImagePlaceholder`：

| 场景 | 组件 | 说明 |
|------|------|------|
| 列表/表格缩略图 | `TableImages` | 内置点击预览，无图自动展示占位符 |
| 详情抽屉大图 | `ImageGallery` | 内置点击预览，无图自动展示占位符 |
| 封面单图 | `CoverThumb` | 合集封面专用，无图展示占位符 |
| 无图占位框 | `ImagePlaceholder` | 灰底虚线框 + 图片图标 + 文字「暂无图片」 |

### 4.2 视觉规格

- **尺寸**：表格单元格 `65×65`（与缩略图一致）；详情抽屉 `120×120`（与大图一致）；封面 `64×64`。
- **边框**：`1px dashed #d9d9d9`，圆角 `6px`。
- **背景**：`#fafafa`。
- **内容**：`PictureOutlined` 图标（18px）+ 文字「暂无图片」，颜色 `#bbb`，字号 `11px`。

### 4.3 使用规则

1. 列表图片列一律使用 `<TableImages value={v} />`，无图自动展示占位符，**禁止**回退成「-」。
2. 详情字段使用 `type: 'images'`（内部渲染 `ImageGallery`），无图同样展示占位符。
3. **无需传任何额外 prop**（旧版 `emptyPlaceholder` prop 已移除，默认即占位效果）。
4. 新增/自定义图片展示组件时，无图分支必须渲染 `ImagePlaceholder`，不得用 `EmptyText`（「-」）代替。
5. 图片加载失败（破图）使用 `IMG_FALLBACK` 兜底，与占位符共同保证单元格无破图。

### 4.4 涉及模块

以下模块的图片列均已按本标准生效（无图显示「暂无图片」占位框）：

- 打卡管理（`task_checkins`）
- 图片素材 / 文件记录（`file_url` 列）
- 任务管理（`images` 列）
- 合集管理（`cover_images` 封面列）

---

## 5. 状态色值约定

| 语义 | antd 色 | 用途 |
|------|---------|------|
| 成功/完成 | `success` (#52c41a) | 审核通过、任务已完成、角色启用、文件正常 |
| 失败/禁用/删除 | `error` (#ff4d4f) | 审核驳回、账号禁用、删除事件 |
| 待审核/警告 | `warning` (#faad14) | 审核中、进度偏低提醒 |
| 进行中 | `processing` (#1677ff) | 任务进行中 |
| 默认/未开始 | `default` | 任务未开始、未分类 |
| 管理员/紫色 | `purple` | 管理员角色、派发人员、修改打卡事件 |
| 学生/蓝色 | `blue` | 学生角色、通用标签 |

**关键映射（`modules.jsx`）**：
- `REVIEW_STATUS_MAP`：pending→warning「待审核」/ approved→success「已通过」/ rejected→error「已驳回」
- `TASK_STATUS_MAP`：todo→default「未开始」/ doing→processing「进行中」/ done→success「已完成」
- `STAFF_EVENT_TYPE_MAP`：login→success / login_fail→error / menu_click→cyan / create→success / update→geekblue / delete→error / review→magenta
- `TRACE_STATUS_MAP`：server_only→warning「仅服务端」/ complete→success「完整链路」
- 字典项着色：`dict_items.color` 字段（如 `#1677ff`），`DictTag` 自动按该色值渲染

### 5.1 统一随机 hash 色值（字符头像 / 任务标签）

无字典色值、需“按内容取色”的业务文本（**字符头像**、**任务标签**等），统一使用 `fields.jsx` 的 `hashColorFor(text)`：

- **色板**（`HASH_COLORS`，固定 7 色）：`#f6685d` / `#e37318` / `#2ba471` / `#c6c6c6` / `#029cd4` / `#ad75fe` / `#e851b3`
- **算法**：对文本做确定性 hash（`h = h*31 + charCodeAt`）后 `% 7` 取色；**同一文本恒取同一色**，禁止使用 `Math.random()`（避免刷新闪色/前后不一致）。
- **已接入场景**：
  - 字符头像：`ImageAvatar`（无头像地址时渲染昵称首字符 + `avatarColorFor(ch)`，即 `hashColorFor(ch)`）
  - 任务标签：任务卡片「任务标签」、详情抽屉 `type:'tags'`（`SplitTags` 内部已按标签文本 hash 着色）
- **新增场景规则**：优先复用 `hashColorFor`，禁止另起色板；有字典色值的枚举仍走 `DictTag` / `StatusTag`，不落入本规范。

---

## 6. 学习仪表盘设计约定

- **徽章配色**：已解锁徽章按 `key` 映射专属渐变背景（`BADGE_GRADIENTS`），未收录的新徽章按 key 哈希从渐变池确定性取色，避免千篇一律。
- **提醒告警**（`ALERT_THEME`）：danger=红系 / warning=橙系 / info=蓝系 / success=绿系；横幅 Banner 与 1 行 3 列卡片两种形态，卡片高度与 KPI 卡片对齐（min-height 100px）。
- 图表标签兜底：`formatter: (text, datum) => `${datum.value ?? 0}``，杜绝渲染 undefined/NaN。

---

## 7. 开发检查清单

新增/修改后台页面时核对：

- [ ] 复用 `CommonCrud` + `MODULES` 配置，不写独立业务页面（特殊情况除外）
- [ ] 状态枚举用 `StatusTag` + 映射表，不裸写三元/`<Tag>` 色值
- [ ] 图片一律 `TableImages`/`CoverThumb`/`ImageGallery`，无图自动占位，不显示「-」
- [ ] 图片用缩略图 `toThumbUrl`，预览用原图
- [ ] 字典值用 `DictTag`（自动着色），不硬编码 label/color
- [ ] 字符头像/任务标签等无字典色值的文本用 `hashColorFor` 统一 hash 取色，不硬编码/随机
- [ ] 长文本列用 `PlainText`/省略，禁止撑破表格
- [ ] 表格默认禁止横向滚动（`tableScroll` 默认 false）
- [ ] 删除/审核等用页面级 Modal，不用行级 Popconfirm
- [ ] 弹窗/抽屉宽度、表单列数与同模块一致（任务 1000/820、审计 860 等）
