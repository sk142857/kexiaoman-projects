// 业务模块配置：供通用 CRUD 页面使用
// columns: 表格列（渲染函数使用 components/fields.js 的丰富组件）
// detailFields: 详情抽屉字段描述（type 对应 CommonCrud 渲染逻辑）
import { Tag, Progress, message } from 'antd';
import { SafetyOutlined, StopOutlined, UnlockOutlined, GiftOutlined, LockOutlined, PlusOutlined, EditOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { crudApi } from '../services/api';
import {
  StatusTag, PlainText, EmptyText, EmojiAvatar, ImageAvatar, Percent, MemBar,
  BoolTag, SplitTags, MaskId, HttpStatusTag, CostText,
  ImageList, ImageGallery, NineGridImages, TableImages, UserCell, UploaderCell,
  StaffCell, DictTag, ScoreTag, AssigneeTags, CoverThumb, SizeText, RatioText,
} from '../components/fields.jsx';

// ==================== 字典映射 ====================
// 性别/科目等已由数据字典驱动（DictTag 按字典配置的 color 渲染），不再维护静态映射
const REVIEW_STATUS_MAP = {
  pending: { label: '待审核', color: 'warning' },
  approved: { label: '已通过', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
};
const TASK_STATUS_MAP = {
  todo: { label: '未开始', color: 'default' },
  doing: { label: '进行中', color: 'processing' },
  done: { label: '已完成', color: 'success' },
};
// 任务状态 → 进度百分比（用于 pro-components 列渲染）
const TASK_STATUS_PROGRESS = { todo: 0, doing: 50, done: 100 };
// 任务状态列：状态文字 + 进度百分比 Tag + 进度条（pro-components 风格）
// accentTodo=true 时「未开始」状态文字与百分比以 #f6685d 醒目提示
const renderTaskStatus = (_, record, accentTodo = false) => {
  const progress = TASK_STATUS_PROGRESS[record.task_status] ?? 0;
  const label = (TASK_STATUS_MAP[record.task_status] || {}).label || record.task_status || '-';
  const todo = record.task_status === 'todo';
  const tagColor = progress === 100 ? 'success' : progress === 0 ? 'default' : 'processing';
  return (
    <div style={{ minWidth: 120, maxWidth: 180 }}>
      <div>
        {todo && accentTodo
          ? <span style={{ color: '#f6685d', fontWeight: 600 }}>{label}</span>
          : label}{' '}
        <Tag color={todo && accentTodo ? '#f6685d' : tagColor}>{progress}%</Tag>
      </div>
      <Progress percent={progress} showInfo={false} />
    </div>
  );
};
const MENU_TYPE_MAP = {
  1: { label: '分组', color: 'blue' },
  2: { label: '叶子', color: 'green' },
};
// 课小满邀请码（独立维护于 t_lp_invites，与 staff 解耦）
const INVITE_KIND_MAP = {
  student: { label: '学生码', color: 'blue' },
  family: { label: '家属共享码', color: 'purple' },
};
const INVITE_KIND_OPTIONS = [
  { value: 'student', label: '学生码' },
  { value: 'family', label: '家属共享码' },
];
const INVITE_STATUS_MAP = {
  available: { label: '未绑定', color: 'processing' },
  bound: { label: '已绑定', color: 'success' },
  revoked: { label: '已作废', color: 'error' },
};
// 任务评分（满分10分）下拉选项
const SCORE_OPTIONS = [0, 3, 5, 7, 9, 10].map(v => ({ value: v, label: `${v}分` }));
const FILE_STATUS_MAP = {
  active: { label: '正常', color: 'success' },
  removed: { label: '已删除', color: 'default' },
};
// 订阅消息模板（业务事件 → 模板ID → 展示名）
const SUB_TMPL_NAMES = {
  '91HSfOQSSVKHPwT2oNM4NdGuKe9Gw1uY0VkLf_nyJ9I': '审核结果通知',
  'aIReeE_R92te__wWL7EKRknaZ0pXhSJ2Kcct_rNWzVg': '打卡提醒',
};
const SUB_TMPL_OPTIONS = Object.entries(SUB_TMPL_NAMES).map(([value, label]) => ({ value, label }));
// 订阅授权记录：状态 / 来源
const SUB_GRANT_STATUS_MAP = {
  active: { label: '可用', color: 'success' },
  consumed: { label: '已用尽', color: 'default' },
};
const SUB_GRANT_SOURCE_MAP = {
  mini: { label: '小程序授权', color: 'blue' },
  backoffice: { label: '后台赠送', color: 'purple' },
};
// 订阅消息发送记录：状态 / 事件类型
const SUB_SEND_STATUS_MAP = {
  sent: { label: '发送成功', color: 'success' },
  failed: { label: '发送失败', color: 'error' },
  skip: { label: '跳过', color: 'default' },
};
const SUB_EVENT_MAP = {
  review_approve: { label: '审核通过', color: 'success' },
  review_reject: { label: '审核驳回', color: 'error' },
  checkin_remind: { label: '打卡提醒', color: 'processing' },
};
const EVENT_TYPE_MAP2 = {
  login: { label: '登录', color: 'purple' },
  page_view: { label: '页面访问', color: 'blue' },
  menu_click: { label: '菜单点击', color: 'cyan' },
  button_click: { label: '按钮点击', color: 'green' },
  create: { label: '创建', color: 'success' },
  update: { label: '更新', color: 'geekblue' },
  delete: { label: '删除', color: 'error' },
  end: { label: '结束', color: 'magenta' },
  reset: { label: '重置', color: 'warning' },
  custom: { label: '自定义', color: 'default' },
};
const BIZ_MAP = {
  avatar: { label: '头像', color: 'blue' },
  events: { label: '事件', color: 'default' },
  tasks: { label: '任务', color: 'purple' },
};
// 后台 staff 操作审计事件类型（staff_events）
const STAFF_EVENT_TYPE_MAP = {
  login: { label: '登录', color: 'success' },
  login_fail: { label: '登录失败', color: 'error' },
  logout: { label: '退出', color: 'warning' },
  menu_click: { label: '菜单点击', color: 'cyan' },
  create: { label: '创建', color: 'success' },
  update: { label: '更新', color: 'geekblue' },
  delete: { label: '删除', color: 'error' },
  detail: { label: '查看详情', color: 'blue' },
  review: { label: '审核', color: 'magenta' },
  custom: { label: '其他', color: 'default' },
};
// 账号角色（后台管理员 / 学生 / 主家长 / 家属）
const STAFF_ROLE_MAP = {
  admin: { label: '管理员', color: 'purple' },
  student: { label: '学生', color: 'blue' },
  parent: { label: '主家长', color: 'green' },
  family: { label: '家属', color: 'orange' },
};
// 用户管理：小程序用户绑定身份（课小满角色）
const USER_LP_ROLE_MAP = {
  student: { label: '学生', color: 'blue' },
  parent: { label: '主家长', color: 'green' },
  family: { label: '家属', color: 'orange' },
  admin: { label: '管理员', color: 'purple' },
};
// 用户管理：账号锁定状态（锁定中 / 已禁用 / 正常）
const USER_LOCK_STATUS_MAP = {
  locked: { label: '锁定中', color: 'error' },
  disabled: { label: '已禁用', color: 'warning' },
  normal: { label: '正常', color: 'success' },
};
// 锁定时长选项（小时）
const LOCK_DURATION_OPTIONS = [
  { value: 1, label: '1 小时' },
  { value: 6, label: '6 小时' },
  { value: 12, label: '12 小时' },
  { value: 24, label: '1 天' },
  { value: 72, label: '3 天' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
];
const GENDER_MAP = {
  0: { label: '未知', color: 'default' },
  1: { label: '男', color: 'blue' },
  2: { label: '女', color: 'magenta' },
};
// 年级中文（孩子档案展示：四（6））
const GRADE_CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
const TRACE_STATUS_MAP = {
  server_only: { label: '仅服务端', color: 'warning' },
  complete: { label: '完整链路', color: 'success' },
};
const METHOD_MAP = {
  GET: { label: 'GET', color: 'blue' },
  POST: { label: 'POST', color: 'green' },
  PUT: { label: 'PUT', color: 'orange' },
  PATCH: { label: 'PATCH', color: 'purple' },
  DELETE: { label: 'DELETE', color: 'red' },
};
const PLATFORM_MAP = {
  ios: { label: 'iOS', color: 'geekblue' },
  android: { label: 'Android', color: 'green' },
};
const NETWORK_MAP = {
  wifi: { label: 'WiFi', color: 'cyan' },
  '4g': { label: '4G', color: 'blue' },
  '5g': { label: '5G', color: 'purple' },
};
const ENV_MAP = {
  release: { label: '正式', color: 'success' },
  trial: { label: '体验', color: 'warning' },
  develop: { label: '开发', color: 'processing' },
};
const LEVEL_MAP = {
  high: { label: '高', color: 'red' },
  middle: { label: '中', color: 'orange' },
  low: { label: '低', color: 'green' },
};

export const MODULES = {
  users: {
    biz: 'users',
    title: '用户管理',
    searchable: ['openid', 'nickname'],
    searchKey: 'nickname',
    // 首列展示的是 user_uid（非主键），必须显式指定 pk=user_id，否则编辑/删除/审核 id 错配
    pk: 'user_id',
    noCreate: true,
    review: true,
    reviewField: 'profile_review_status',
    reviewEndpoint: 'reviewProfile',
    // 丰富列较多，允许横向滚动
    tableScroll: { x: 1260 },
    filters: [
      { name: 'user_status', label: '状态', options: [{ value: 1, label: '正常' }, { value: 0, label: '禁用' }] },
      { name: 'profile_review_status', label: '资料审核', options: [
        { value: 'pending', label: '待审核' },
        { value: 'approved', label: '已通过' },
        { value: 'rejected', label: '已驳回' },
      ] },
    ],
    columns: [
      { title: '用户ID', dataIndex: 'user_uid', key: 'user_uid', width: 100, render: (v) => <PlainText value={v} maxWidth={90} /> },
      { title: '头像', dataIndex: 'avatar', key: 'avatar', width: 64, render: (v, r) => <ImageAvatar avatar={v} nickname={r.nickname} size={42} /> },
      { title: '昵称', dataIndex: 'nickname', key: 'nickname', width: 110 },
      { title: '身份角色', dataIndex: '_role', key: '_role', width: 90, render: (v) => (v ? <StatusTag value={v} map={USER_LP_ROLE_MAP} /> : <Tag>未绑定</Tag>) },
      { title: '绑定账号', dataIndex: '_boundStaffNickname', key: '_boundStaffNickname', width: 110, render: (v) => (v ? <PlainText value={v} maxWidth={100} /> : <EmptyText />) },
      { title: '邀请码', dataIndex: '_inviteCode', key: '_inviteCode', width: 100, render: (v) => (v ? <PlainText value={v} strong /> : <EmptyText />) },
      { title: '性别', dataIndex: 'gender', key: 'gender', width: 60, render: (v) => <DictTag code="gender" value={v} /> },
      { title: '资料审核', dataIndex: 'profile_review_status', key: 'profile_review_status', width: 84, render: (v) => <StatusTag value={v} map={REVIEW_STATUS_MAP} /> },
      { title: '账号状态', dataIndex: '_lockStatus', key: '_lockStatus', width: 84, render: (v) => <StatusTag value={v} map={USER_LOCK_STATUS_MAP} /> },
      { title: '注册时间', dataIndex: 'created_at', key: 'created_at', width: 140 },
    ],
    detailFields: [
      { name: 'user_uid', label: '用户ID' },
      { name: 'user_id', label: '内部ID' },
      { name: 'openid', label: 'openid', span: 2 },
      { name: 'nickname', label: '昵称' },
      { name: 'avatar', label: '头像', type: 'imageAvatar' },
      { name: 'gender', label: '性别', type: 'dictTag', dict: 'gender' },
      { name: '_role', label: '身份角色', type: 'tag', map: USER_LP_ROLE_MAP },
      { name: '_boundStaffId', label: '绑定账号ID' },
      { name: '_boundStaffNickname', label: '绑定账号' },
      { name: '_inviteCode', label: '绑定邀请码' },
      { name: '_inviteStatus', label: '邀请码状态', type: 'tag', map: INVITE_STATUS_MAP },
      { name: 'profile_review_status', label: '资料审核', type: 'tag', map: REVIEW_STATUS_MAP },
      { name: 'nickname_pending', label: '待审核昵称' },
      { name: 'gender_pending', label: '待审核性别', type: 'dictTag', dict: 'gender' },
      { name: '_lockStatus', label: '账号状态', type: 'tag', map: USER_LOCK_STATUS_MAP },
      { name: 'locked_until', label: '锁定截止时间', type: 'date' },
      { name: 'locked_reason', label: '锁定原因', type: 'longText', span: 2 },
      { name: 'locked_by', label: '锁定操作人' },
      { name: 'locked_at', label: '锁定时间', type: 'date' },
      { name: 'user_status', label: '禁用状态', type: 'tag', map: { 1: { label: '正常', color: 'success' }, 0: { label: '禁用', color: 'error' } } },
      { name: 'created_at', label: '注册时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'nickname', label: '昵称', type: 'text' },
      { name: 'gender', label: '性别', type: 'select', options: [{ value: 0, label: '保密' }, { value: 1, label: '男' }, { value: 2, label: '女' }] },
      { name: 'user_status', label: '状态', type: 'select', options: [{ value: 1, label: '正常' }, { value: 0, label: '禁用' }] },
    ],
    // 账号锁定/解锁（按 user_id，含时效；操作写入操作审计）
    customActions: [
      {
        label: '锁定账号',
        icon: <LockOutlined />,
        color: '#ff4d4f',
        show: (r, ctx) => ctx.isAdmin && r._lockStatus !== 'locked',
        modal: {
          title: '锁定用户',
          width: 520,
          fields: [
            { name: 'duration', label: '锁定时长', type: 'select', options: LOCK_DURATION_OPTIONS, rules: [{ required: true, message: '请选择锁定时长' }] },
            { name: 'reason', label: '锁定原因', type: 'textarea', placeholder: '选填，便于审计追踪' },
          ],
        },
        onClick: async (r, ctx, values) => {
          const res = await crudApi.userLock(r.user_id, { hours: values.duration, reason: values.reason || '' });
          message.success(res?.msg || '已锁定');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
      {
        label: '解锁账号',
        icon: <UnlockOutlined />,
        color: '#52c41a',
        show: (r, ctx) => ctx.isAdmin && r._lockStatus === 'locked',
        confirm: '解锁后该用户可立即恢复正常使用（绑定未解除则直接进首页），确定解锁？',
        onClick: async (r, ctx) => {
          await crudApi.userUnlock(r.user_id);
          message.success('已解锁');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
    ],
  },

  monitors: {
    biz: 'monitors',
    title: '服务监控',
    drawerWidth: 920,
    searchable: ['instance_id'],
    searchKey: 'instance_id',
    readonly: true,
    // 日志类：默认只查最近 3 天，过滤栏可切换其他时间范围
    defaultDays: 3,
    columns: [
      { title: '实例', dataIndex: 'instance_id', key: 'instance_id', width: 200, render: (v) => <PlainText value={v} maxWidth={190} /> },
      { title: 'CPU', dataIndex: 'cpu_percent', key: 'cpu_percent', width: 110, render: (v) => <Percent value={v} suffix="%" /> },
      { title: 'RSS', dataIndex: 'rss_mb', key: 'rss_mb', width: 120, render: (_, r) => <MemBar used={r.rss_mb} total={r.mem_total_mb} /> },
      { title: '内网IP', dataIndex: 'internal_ip', key: 'internal_ip', width: 120 },
      { title: '集群', dataIndex: 'cluster_id', key: 'cluster_id', width: 200, render: (v) => <PlainText value={v} maxWidth={190} /> },
      { title: '节点', dataIndex: 'node_version', key: 'node_version', width: 80 },
      { title: '采集时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'monitor_id', label: '监控ID', type: 'text' },
      { name: 'env_id', label: '云环境ID' },
      { name: 'instance_id', label: '实例ID', type: 'text' },
      { name: 'instance_spec', label: '实例规格' },
      { name: 'cpu_cores', label: 'CPU核数' },
      { name: 'mem_total_mb', label: '总内存(MB)' },
      { name: 'internal_ip', label: '内网IP' },
      { name: 'zone_id', label: '可用区' },
      { name: 'cluster_id', label: '集群ID' },
      { name: 'node_version', label: 'Node版本' },
      { name: 'cpu_percent', label: 'CPU使用率', type: 'progress' },
      { name: 'rss_mb', label: '常驻内存', type: 'mem', totalField: 'mem_total_mb' },
      { name: 'heap_used_mb', label: '堆内存', type: 'mem', totalField: 'heap_total_mb' },
      { name: 'external_mb', label: '外部内存(MB)' },
      { name: 'uptime_min', label: '运行时长(分钟)' },
      { name: 'active_handles', label: '活跃句柄' },
      { name: 'active_reqs', label: '活跃请求' },
      { name: 'created_at', label: '采集时间', type: 'date' },
    ],
    formFields: [],
  },

  traces: {
    biz: 'traces',
    title: '接口链路',
    searchable: ['user_id', 'api_path'],
    searchKey: 'api_path',
    readonly: true,
    // 日志类：默认只查最近 3 天，过滤栏可切换其他时间范围
    defaultDays: 3,
    columns: [
      { title: '请求ID', dataIndex: 'request_id', key: 'request_id', width: 190, render: (v) => <MaskId value={v} maxWidth={180} /> },
      { title: '方法', dataIndex: 'api_method', key: 'api_method', width: 90, render: (v) => <StatusTag value={v} map={METHOD_MAP} /> },
      { title: '路径', dataIndex: 'api_path', key: 'api_path', width: 200, render: (v) => <PlainText value={v} maxWidth={190} /> },
      { title: '用户ID', dataIndex: 'user_id', key: 'user_id', width: 150, render: (v, r) => <UserCell userId={v || r._userId} nickname={r._userNickname} avatar={r._userAvatar} avatarChar={r._userAvatarChar} showNick={false} /> },
      { title: 'HTTP', dataIndex: 'http_status', key: 'http_status', width: 80, render: (v) => <HttpStatusTag value={v} /> },
      { title: '服务端', dataIndex: 'server_cost_ms', key: 'server_cost_ms', width: 100, render: (v) => <CostText value={v} /> },
      { title: '总耗时', dataIndex: 'client_cost_ms', key: 'client_cost_ms', width: 100, render: (v) => <CostText value={v} /> },
      { title: '链路', dataIndex: 'trace_status', key: 'trace_status', width: 100, render: (v) => <StatusTag value={v} map={TRACE_STATUS_MAP} /> },
      { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'request_id', label: '请求ID', type: 'id', span: 2 },
      { name: 'user_id', label: '用户ID' },
      { name: 'api_path', label: '接口路径', type: 'longText', span: 2 },
      { name: 'api_method', label: '请求方法', type: 'tag', map: METHOD_MAP },
      { name: 'http_status', label: 'HTTP状态', type: 'httpStatus' },
      { name: 'server_cost_ms', label: '服务端耗时(ms)', type: 'cost' },
      { name: 'client_cost_ms', label: '前端总耗时(ms)', type: 'cost' },
      { name: 'server_code', label: '业务code' },
      { name: 'trace_status', label: '链路状态', type: 'tag', map: TRACE_STATUS_MAP },
      { name: 'client_fingerprint', label: '客户端指纹', type: 'longText', span: 2 },
      { name: 'req_params', label: '请求参数', type: 'json', span: 2 },
      { name: 'start_time', label: '服务端开始', type: 'date' },
      { name: 'end_time', label: '服务端结束', type: 'date' },
      { name: 'client_at', label: '前端上报时间', type: 'date' },
      { name: 'created_at', label: '首次记录时间', type: 'date' },
    ],
    formFields: [],
  },

  sessions: {
    biz: 'sessions',
    title: '会话画像',
    drawerWidth: 1080,
    drawerColumns: 3,
    searchable: ['openid', 'platform'],
    searchKey: 'platform',
    readonly: true,
    // 日志类：默认只查最近 3 天，过滤栏可切换其他时间范围
    defaultDays: 3,
    columns: [
      { title: '会话ID', dataIndex: 'session_id', key: 'session_id', width: 190, render: (v) => <MaskId value={v} maxWidth={180} /> },
      { title: '用户', dataIndex: '_userId', key: '_userId', width: 140, render: (v, r) => <UserCell userId={r._userId} nickname={r._userNickname} avatar={r._userAvatar} avatarChar={r._userAvatarChar} /> },
      { title: '品牌', dataIndex: 'brand', key: 'brand', width: 100 },
      { title: '型号', dataIndex: 'model', key: 'model', width: 140 },
      { title: '平台', dataIndex: 'platform', key: 'platform', width: 90, render: (v) => <StatusTag value={v} map={PLATFORM_MAP} /> },
      { title: '网络', dataIndex: 'network_type', key: 'network_type', width: 90, render: (v) => <StatusTag value={v} map={NETWORK_MAP} /> },
      { title: '环境', dataIndex: 'env_version', key: 'env_version', width: 90, render: (v) => <StatusTag value={v} map={ENV_MAP} /> },
      { title: '电量', dataIndex: 'battery_level', key: 'battery_level', width: 100, render: (v) => <Percent value={v} suffix="%" /> },
      { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'session_id', label: '会话ID', type: 'id', span: 2 },
      { name: '_userId', label: '用户', type: 'userCell', span: 2 },
      { name: 'openid', label: 'openid', span: 2 },
      { name: 'brand', label: '品牌' },
      { name: 'model', label: '型号' },
      { name: 'platform', label: '平台', type: 'tag', map: PLATFORM_MAP },
      { name: 'os_version', label: '系统版本' },
      { name: 'cpu_type', label: 'CPU型号' },
      { name: 'wechat_version', label: '微信版本' },
      { name: 'sdk_version', label: '基础库' },
      { name: 'renderer', label: '渲染引擎' },
      { name: 'network_type', label: '网络', type: 'tag', map: NETWORK_MAP },
      { name: 'env_version', label: '环境', type: 'tag', map: ENV_MAP },
      { name: 'app_version', label: '应用版本' },
      { name: 'launch_scene', label: '进入场景' },
      { name: 'model_level', label: '性能档位', type: 'tag', map: LEVEL_MAP },
      { name: 'screen_w', label: '屏幕宽' },
      { name: 'screen_h', label: '屏幕高' },
      { name: 'battery_level', label: '电量', type: 'progress' },
      { name: 'is_charging', label: '充电中', type: 'bool' },
      { name: 'dark_mode', label: '深色模式', type: 'bool' },
      { name: 'auth_notification', label: '通知权限', type: 'bool' },
      { name: 'auth_album', label: '相册权限', type: 'bool' },
      { name: 'auth_camera', label: '摄像头权限', type: 'bool' },
      { name: 'auth_location', label: '位置权限', type: 'bool' },
      { name: 'auth_mic', label: '麦克风权限', type: 'bool' },
      { name: 'referrer_info', label: '来源信息', type: 'json', span: 2 },
      { name: 'payload', label: '原始画像', type: 'json', span: 2 },
      { name: 'created_at', label: '采集时间', type: 'date' },
    ],
    formFields: [],
  },

  staff: {
    biz: 'staff',
    title: '管理员管理',
    searchable: ['staff_username', 'staff_nickname'],
    searchKey: 'staff_username',
    columns: [
      { title: 'ID', dataIndex: 'staff_id', key: 'staff_id', width: 80 },
      { title: '账号', dataIndex: 'staff_username', key: 'staff_username' },
      { title: '昵称', dataIndex: 'staff_nickname', key: 'staff_nickname' },
      { title: '角色', dataIndex: 'staff_role', key: 'staff_role', width: 100, render: (v) => <StatusTag value={v} map={STAFF_ROLE_MAP} /> },
      { title: '状态', dataIndex: 'staff_status', key: 'staff_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } }} /> },
      { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'staff_id', label: 'ID' },
      { name: 'staff_username', label: '账号' },
      { name: 'staff_nickname', label: '昵称' },
      { name: 'staff_role', label: '角色', type: 'tag', map: STAFF_ROLE_MAP },
      { name: 'staff_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } } },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    customActions: [
      {
        label: '赠送订阅次数',
        icon: <GiftOutlined />,
        color: '#52c41a',
        show: (r, ctx) => ctx.isAdmin && r.staff_role === 'student',
        modal: {
          title: '后台赠送订阅次数',
          width: 520,
          fields: [
            {
              name: 'tmpl_id',
              label: '订阅模板',
              type: 'select',
              options: SUB_TMPL_OPTIONS,
              placeholder: '不选=通用次数（任意通知可消耗）',
            },
            { name: 'count', label: '赠送次数', type: 'number', min: 1, max: 100, rules: [{ required: true, message: '请填写赠送次数' }] },
            { name: 'remark', label: '备注', type: 'textarea', placeholder: '选填' },
          ],
        },
        onClick: async (r, ctx, values) => {
          await crudApi.subscribeGrant({ staffId: r.staff_id, ...values });
          message.success('已赠送');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
    ],
    formFields: [
      { name: 'staff_username', label: '账号', type: 'text', rules: [{ required: true }] },
      { name: 'staff_nickname', label: '昵称', type: 'text' },
      { name: 'staff_role', label: '角色', type: 'select', optionsSource: 'roles', optionsMap: { value: 'role_code', label: 'role_name' } },
      { name: 'staff_status', label: '状态', type: 'select', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
      { name: 'staff_password', label: '密码（新增必填，编辑留空则不修改）', type: 'password' },
    ],
  },

  // 课小满绑定关系管理：小程序用户 openid ↔ 学生/管理员账号（t_lp_students）统一维护
  // 权限：管理员可查看全部并解除/变更绑定；学生仅可查看自己名下的绑定（只读）
  lp_students: {
    biz: 'lp_students',
    title: '绑定管理',
    entityName: '绑定关系',
    searchable: ['openid'],
    searchKey: 'openid',
    readonly: true,
    rowDblClick: true,
    filters: [
      { name: 'boundStatus', label: '状态', options: [
        { value: 1, label: '正常' },
        { value: 0, label: '已锁定' },
      ] },
    ],
    columns: [
      { title: 'ID', dataIndex: 'id', key: 'id', width: 70 },
      { title: '学生账号', dataIndex: 'staff_id', key: 'staff_id', width: 160, render: (v, r) => <StaffCell staffId={v} nickname={r.staff_nickname} /> },
      { title: '角色', dataIndex: 'staff_role', key: 'staff_role', width: 90, render: (v) => <StatusTag value={v} map={{ admin: { label: '管理员', color: 'purple' }, student: { label: '学生', color: 'blue' } }} /> },
      { title: '小程序用户', dataIndex: '_userId', key: '_userId', width: 160, render: (v, r) => <UserCell userId={v || r.openid} nickname={r._userNickname} avatar={r._userAvatar} avatarChar={r._userAvatarChar} /> },
      { title: 'openid', dataIndex: 'openid', key: 'openid', width: 200, render: (v) => <MaskId value={v} maxWidth={190} /> },
      { title: '绑定状态', dataIndex: 'bound_status', key: 'bound_status', width: 90, render: (v) => <StatusTag value={v} map={{ 1: { label: '正常', color: 'success' }, 0: { label: '已锁定', color: 'error' } }} /> },
      { title: '绑定时间', dataIndex: 'bound_at', key: 'bound_at', width: 150 },
    ],
    detailFields: [
      { name: 'id', label: '绑定ID' },
      { name: 'staff_id', label: '绑定账号ID' },
      { name: 'staff_username', label: '绑定账号' },
      { name: 'staff_nickname', label: '账号昵称' },
      { name: 'staff_role', label: '账号角色', type: 'tag', map: { admin: { label: '管理员', color: 'purple' }, student: { label: '学生', color: 'blue' } } },
      { name: 'staff_invite_code', label: '绑定邀请码' },
      { name: 'staff_invite_code_status', label: '邀请码状态', type: 'tag', map: INVITE_STATUS_MAP },
      { name: '_userId', label: '小程序用户', type: 'userCell', span: 2 },
      { name: 'openid', label: 'openid', type: 'text', span: 2 },
      { name: 'bound_status', label: '绑定状态', type: 'tag', map: { 1: { label: '正常', color: 'success' }, 0: { label: '已锁定', color: 'error' } } },
      { name: 'bound_at', label: '绑定时间', type: 'date' },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [],
    // 统一维护（仅管理员）：新增绑定 / 编辑（换绑或改状态）/ 解除绑定（物理删除）
    customActions: [
      {
        label: '新增绑定',
        icon: <PlusOutlined />,
        color: '#52c41a',
        show: (r, ctx) => ctx.isAdmin,
        modal: {
          title: '新增绑定',
          width: 560,
          fields: [
            {
              name: 'openid',
              label: '小程序用户',
              type: 'select',
              optionsSource: 'users',
              optionsParams: { pageSize: 200 },
              optionsMap: { value: 'openid', label: 'nickname' },
              showSearch: true,
              rules: [{ required: true, message: '请选择小程序用户（openid）' }],
              placeholder: '选择已登录过的小程序用户',
            },
            {
              name: 'staffId',
              label: '目标学生账号',
              type: 'select',
              optionsSource: 'staff',
              optionsParams: { pageSize: 200, staff_role: 'student' },
              optionsMap: { value: 'staff_id', label: 'staff_nickname' },
              showSearch: true,
              rules: [{ required: true, message: '请选择目标学生账号' }],
              placeholder: '选择绑定到的学生账号',
            },
            {
              name: 'boundStatus',
              label: '绑定状态',
              type: 'select',
              options: [{ value: 1, label: '正常' }, { value: 0, label: '已锁定' }],
            },
          ],
        },
        onClick: async (r, ctx, values) => {
          await crudApi.lpStudentCreate({
            openid: values.openid,
            staffId: values.staffId,
            boundStatus: values.boundStatus !== undefined && values.boundStatus !== null && values.boundStatus !== '' ? values.boundStatus : 1,
          });
          message.success('绑定创建成功');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
      {
        label: '编辑',
        icon: <EditOutlined />,
        color: '#1677ff',
        show: (r, ctx) => ctx.isAdmin,
        modal: {
          title: '编辑绑定',
          width: 520,
          fields: [
            {
              name: 'staffId',
              label: '目标学生账号',
              type: 'select',
              optionsSource: 'staff',
              optionsParams: { pageSize: 200, staff_role: 'student' },
              optionsMap: { value: 'staff_id', label: 'staff_nickname' },
              showSearch: true,
              placeholder: '留空则不更换学生账号',
            },
            {
              name: 'boundStatus',
              label: '绑定状态',
              type: 'select',
              options: [{ value: 1, label: '正常' }, { value: 0, label: '已锁定' }],
              placeholder: '留空则不修改状态',
            },
          ],
        },
        onClick: async (r, ctx, values) => {
          const payload = {};
          if (values.staffId !== undefined && values.staffId !== null && values.staffId !== '') payload.staffId = values.staffId;
          if (values.boundStatus !== undefined && values.boundStatus !== null && values.boundStatus !== '') payload.boundStatus = values.boundStatus;
          if (Object.keys(payload).length === 0) return;
          await crudApi.lpStudentUpdate(r.id, payload);
          message.success('已更新绑定');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
      {
        label: '解除绑定',
        icon: <UnlockOutlined />,
        color: '#ff4d4f',
        show: (r, ctx) => ctx.isAdmin,
        confirm: '解除后该小程序用户需重新绑定邀请码才能访问课小满，确定解除？',
        onClick: async (r, ctx) => {
          await crudApi.lpStudentUnbind(r.id);
          message.success('已解除绑定');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
    ],
  },

  // 课小满孩子档案（后台只读：孩子档案/学生码由家长在小程序维护，后台仅查看与审计）
  lp_children: {
    biz: 'lp_children',
    title: '孩子档案',
    entityName: '孩子档案',
    searchable: ['child_name', 'school_name'],
    searchKey: 'child_name',
    readonly: true,
    rowDblClick: true,
    filters: [
      { name: 'grade', label: '年级', options: [1, 2, 3, 4, 5, 6].map(g => ({ value: g, label: `${g}年级` })) },
      { name: 'class_no', label: '班级', options: Array.from({ length: 35 }, (_, i) => ({ value: i + 1, label: `${i + 1}班` })) },
    ],
    columns: [
      { title: 'ID', dataIndex: 'child_id', key: 'child_id', width: 80 },
      { title: '家长', dataIndex: '_parentNickname', key: '_parentNickname', width: 120 },
      { title: '家长账号ID', dataIndex: 'parent_staff_id', key: 'parent_staff_id', width: 100 },
      { title: '孩子账号ID', dataIndex: 'student_staff_id', key: 'student_staff_id', width: 100 },
      { title: '姓名', dataIndex: 'child_name', key: 'child_name', width: 100 },
      { title: '性别', dataIndex: 'gender', key: 'gender', width: 70, render: (v) => <StatusTag value={v} map={GENDER_MAP} /> },
      { title: '出生年月', dataIndex: 'birth_date', key: 'birth_date', width: 110 },
      { title: '学校', dataIndex: 'school_name', key: 'school_name' },
      { title: '年级班级', dataIndex: 'grade', key: 'grade', width: 100, render: (v, r) => `${GRADE_CN[v] ?? v}（${r.class_no ?? '-'}）` },
      { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'child_id', label: '孩子档案ID' },
      { name: '_parentNickname', label: '家长', type: 'text' },
      { name: 'parent_staff_id', label: '家长账号ID' },
      { name: 'student_staff_id', label: '孩子学生账号ID' },
      { name: 'child_name', label: '孩子姓名' },
      { name: 'gender', label: '性别', type: 'tag', map: GENDER_MAP },
      { name: 'birth_date', label: '出生年月', type: 'date' },
      { name: 'school_name', label: '学校名称' },
      { name: 'grade', label: '年级', type: 'tag', map: Object.fromEntries([1, 2, 3, 4, 5, 6].map(g => [g, { label: `${GRADE_CN[g] ?? g}年级` }])) },
      { name: 'class_no', label: '班级' },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [],
  },

  // 课小满家属关系（后台只读：家属关系由主家长在小程序共享，后台仅查看与审计）
  lp_family_members: {
    biz: 'lp_family_members',
    title: '家属关系',
    entityName: '家属关系',
    searchable: ['member_openid'],
    searchKey: 'member_openid',
    readonly: true,
    rowDblClick: true,
    filters: [
      { name: 'member_status', label: '状态', options: [
        { value: 1, label: '正常' },
        { value: 0, label: '已解除' },
      ] },
    ],
    columns: [
      { title: 'ID', dataIndex: 'id', key: 'id', width: 70 },
      { title: '主家长', dataIndex: '_ownerNickname', key: '_ownerNickname', width: 120 },
      { title: '主家长ID', dataIndex: 'owner_staff_id', key: 'owner_staff_id', width: 100 },
      { title: '家属', dataIndex: '_memberNickname', key: '_memberNickname', width: 120 },
      { title: '家属ID', dataIndex: 'member_staff_id', key: 'member_staff_id', width: 100 },
      { title: '状态', dataIndex: 'member_status', key: 'member_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '正常', color: 'success' }, 0: { label: '已解除', color: 'error' } }} /> },
      { title: '绑定时间', dataIndex: 'bound_at', key: 'bound_at', width: 150 },
    ],
    detailFields: [
      { name: 'id', label: '关系ID' },
      { name: '_ownerNickname', label: '主家长' },
      { name: 'owner_staff_id', label: '主家长ID' },
      { name: '_memberNickname', label: '家属' },
      { name: 'member_staff_id', label: '家属账号ID' },
      { name: 'member_openid', label: '家属openid', type: 'text', span: 2 },
      { name: 'member_status', label: '状态', type: 'tag', map: { 1: { label: '正常', color: 'success' }, 0: { label: '已解除', color: 'error' } } },
      { name: 'bound_at', label: '绑定时间', type: 'date' },
      { name: 'created_at', label: '创建时间', type: 'date' },
    ],
    formFields: [],
  },

  // 课小满邀请码管理（独立模块，邀请码维护于 t_lp_invites，与 staff 解耦）
  // 学生码 / 家属共享码统一维护：支持新增/编辑/删除（管理员）；作废 / 重新生成走下方自定义操作
  lp_invites: {
    biz: 'lp_invites',
    title: '邀请码管理',
    entityName: '邀请码',
    searchable: ['invite_code'],
    searchKey: 'invite_code',
    rowDblClick: true,
    filters: [
      { name: 'kind', label: '类型', options: [
        { value: 'student', label: '学生码' },
        { value: 'family', label: '家属共享码' },
      ] },
      { name: 'status', label: '状态', options: [
        { value: 'available', label: '未绑定' },
        { value: 'bound', label: '已绑定' },
        { value: 'revoked', label: '已作废' },
      ] },
    ],
    columns: [
      { title: 'ID', dataIndex: 'invite_id', key: 'invite_id', width: 80 },
      { title: '邀请码', dataIndex: 'invite_code', key: 'invite_code', width: 110, render: (v) => <PlainText value={v} strong /> },
      { title: '类型', dataIndex: 'kind', key: 'kind', width: 100, render: (v) => <StatusTag value={v} map={INVITE_KIND_MAP} /> },
      { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (v) => <StatusTag value={v} map={INVITE_STATUS_MAP} /> },
      { title: '归属人', dataIndex: '_ownerNickname', key: '_ownerNickname', width: 120, render: (v, r) => <StaffCell staffId={r.owner_staff_id} nickname={v} /> },
      { title: '孩子', dataIndex: '_childName', key: '_childName', width: 100, render: (v) => <PlainText value={v || '--'} /> },
      { title: '绑定人', dataIndex: '_boundNickname', key: '_boundNickname', width: 120, render: (v) => <PlainText value={v || '--'} /> },
      { title: '绑定时间', dataIndex: 'bound_at', key: 'bound_at', width: 150 },
      { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'invite_id', label: '邀请码ID' },
      { name: 'invite_code', label: '邀请码', type: 'longText', span: 2 },
      { name: 'kind', label: '类型', type: 'tag', map: INVITE_KIND_MAP },
      { name: 'status', label: '状态', type: 'tag', map: INVITE_STATUS_MAP },
      { name: '_ownerNickname', label: '归属人' },
      { name: 'owner_staff_id', label: '归属账号ID' },
      { name: '_childName', label: '关联孩子' },
      { name: 'child_id', label: '孩子档案ID' },
      { name: '_boundNickname', label: '绑定人' },
      { name: 'bound_staff_id', label: '绑定账号ID' },
      { name: '_boundUserNickname', label: '绑定小程序用户', type: 'text', span: 2 },
      { name: 'bound_openid', label: '绑定openid', type: 'text', span: 2 },
      { name: 'bound_at', label: '绑定时间', type: 'date' },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'kind', label: '类型', type: 'select', options: INVITE_KIND_OPTIONS, rules: [{ required: true, message: '请选择类型' }], tip: '学生码：绑定孩子学生账号；家属共享码：单次使用，绑定即作废' },
      { name: 'owner_staff_id', label: '归属账号', type: 'select', optionsSource: 'staff', optionsParams: { pageSize: 500 }, optionsMap: { value: 'staff_id', label: 'staff_nickname' }, showSearch: true, rules: [{ required: true, message: '请选择归属账号' }], tip: '学生码选择学生账号；家属共享码选择主家长账号' },
      { name: 'child_id', label: '关联孩子档案', type: 'select', optionsSource: 'lp_children', optionsParams: { pageSize: 500 }, optionsMap: { value: 'child_id', label: 'child_name' }, showSearch: true, allowClear: true, tip: '学生码可关联孩子档案（选填）；家属共享码无需填写' },
      { name: 'status', label: '状态', type: 'select', options: [
        { value: 'available', label: '未绑定' },
        { value: 'bound', label: '已绑定' },
        { value: 'revoked', label: '已作废' },
      ], tip: '已绑定状态由小程序绑定产生，后台不可手动改为已绑定' },
    ],
    createDefaults: { kind: 'student', status: 'available' },
    // 独立管理操作（仅管理员）：作废锁定访问 / 重新生成恢复访问
    customActions: [
      {
        label: '重新生成',
        icon: <SafetyOutlined />,
        color: '#1677ff',
        show: (r, ctx) => ctx.isAdmin && r.kind === 'student',
        confirm: '将为该学生生成新的学生码（旧可用学生码作废）并恢复其名下小程序访问，确定？',
        onClick: async (r, ctx) => {
          const res = await crudApi.lpInviteRegenerate(r.invite_id);
          message.success(`新邀请码：${res.data.invite_code}`);
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
      {
        label: '作废',
        icon: <StopOutlined />,
        color: '#ff4d4f',
        show: (r, ctx) => ctx.isAdmin && r.status !== 'revoked',
        confirm: '作废后该邀请码不可再绑定（已绑定的学生码将同步锁定小程序访问），确定作废？',
        onClick: async (r, ctx) => {
          await crudApi.lpInviteRevoke(r.invite_id);
          message.success('已作废');
          if (ctx && ctx.refresh) ctx.refresh();
        },
      },
    ],
  },

  apps: {
    biz: 'apps',
    title: '小程序配置',
    searchable: ['app_id', 'app_name'],
    searchKey: 'app_name',
    // 密钥明文存表（AppSecret/JWT密钥），列表与详情不展示，仅在编辑表单填写；编辑留空保持原值
    // 编辑表单分左右布局：左侧基础信息（应用身份/服务域名/提醒规则），右侧安全凭证与订阅（密钥/模板/说明）
    formColumns: 2,
    modalWidth: 920,
    columns: [
      { title: '应用ID', dataIndex: 'app_id', key: 'app_id', width: 150, render: (v) => <PlainText value={v} maxWidth={140} /> },
      { title: '名称', dataIndex: 'app_name', key: 'app_name', width: 120 },
      { title: 'AppID', dataIndex: 'wechat_appid', key: 'wechat_appid', width: 190, render: (v) => <PlainText value={v} maxWidth={180} /> },
      { title: '订阅模板', dataIndex: 'subscribe_tmpl_ids', key: 'subscribe_tmpl_ids', width: 220, render: (v) => <SplitTags value={v} separator="," /> },
      { title: '提醒窗口', dataIndex: 'reminder_window', key: 'reminder_window', width: 100 },
      { title: '提前/逾期(天)', dataIndex: 'reminder_days', key: 'reminder_days', width: 120, render: (v, r) => `${r.reminder_days ?? '-'} / ${r.reminder_overdue_days ?? '-'}` },
      { title: 'JWT有效期', dataIndex: 'jwt_expires', key: 'jwt_expires', width: 90 },
      { title: '状态', dataIndex: 'app_status', key: 'app_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '停用', color: 'default' } }} /> },
    ],
    detailFields: [
      { name: 'app_id', label: '应用ID' },
      { name: 'app_name', label: '名称' },
      { name: 'wechat_appid', label: '微信 AppID' },
      { name: 'subscribe_tmpl_ids', label: '订阅模板ID（逗号分隔）', type: 'longText', span: 2 },
      { name: 'reminder_window', label: '打卡提醒窗口' },
      { name: 'reminder_days', label: '打卡提醒提前天数' },
      { name: 'reminder_overdue_days', label: '逾期提醒回溯天数' },
      { name: 'jwt_expires', label: 'JWT 有效期' },
      { name: 'service_url', label: '服务域名', type: 'longText', span: 2 },
      { name: 'app_desc', label: '说明', type: 'longText', span: 2 },
      { name: 'app_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '停用', color: 'default' } } },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    // 左侧：基础信息
    formFields: [
      { name: 'app_id', label: '应用ID（如 learning-planet）', type: 'text', rules: [{ required: true }], placeholder: '应用ID不可重复', span: 12 },
      { name: 'app_name', label: '名称', type: 'text', rules: [{ required: true }], span: 12 },
      { name: 'wechat_appid', label: '微信 AppID', type: 'text', placeholder: 'wx 开头', span: 12 },
      { name: 'app_status', label: '状态', type: 'select', options: [{ value: 1, label: '启用' }, { value: 0, label: '停用' }], span: 12 },
      { name: 'service_url', label: '服务域名', type: 'text', placeholder: '云托管默认公网域名，前端 BASE_URL 依据', span: 24 },
      { name: 'reminder_window', label: '打卡提醒窗口', type: 'text', placeholder: '默认 18:00-22:00', span: 8 },
      { name: 'reminder_days', label: '打卡提醒提前天数', type: 'number', placeholder: '默认 3', span: 8 },
      { name: 'reminder_overdue_days', label: '逾期提醒回溯天数', type: 'number', placeholder: '默认 7', span: 8 },
      // 右侧：安全凭证与订阅
      { name: 'app_secret', label: 'AppSecret（code2session）', type: 'password', placeholder: '编辑留空则保持原值', side: 'right', span: 24 },
      { name: 'jwt_secret', label: 'JWT 签名密钥', type: 'password', placeholder: '编辑留空则保持原值', side: 'right', span: 24 },
      { name: 'jwt_expires', label: 'JWT 有效期', type: 'text', placeholder: '如 7d', side: 'right', span: 24 },
      { name: 'subscribe_tmpl_ids', label: '订阅消息模板ID（逗号分隔）', type: 'textarea', placeholder: '如 审核结果通知模板,打卡提醒模板（小程序端「增加订阅次数」会订阅这些模板）', side: 'right', span: 24 },
      { name: 'app_desc', label: '说明', type: 'textarea', side: 'right', span: 24 },
    ],
  },

  // 订阅消息：用户授权记录（小程序主动订阅 / 后台赠送）——只读
  subscribe_grants: {
    biz: 'subscribe_grants',
    title: '订阅授权',
    entityName: '订阅授权',
    searchable: ['openid'],
    searchKey: 'openid',
    readonly: true,
    filters: [
      { name: 'grant_status', label: '状态', options: [
        { value: 'active', label: '可用' },
        { value: 'consumed', label: '已用尽' },
      ] },
      { name: 'source', label: '来源', options: [
        { value: 'mini', label: '小程序授权' },
        { value: 'backoffice', label: '后台赠送' },
      ] },
      { name: 'tmpl_id', label: '模板', options: SUB_TMPL_OPTIONS },
    ],
    columns: [
      { title: 'ID', dataIndex: 'grant_id', key: 'grant_id', width: 110 },
      { title: '学生', dataIndex: 'staff_id', key: 'staff_id', width: 140, render: (v, r) => <StaffCell staffId={v} nickname={r._recipientNickname} /> },
      { title: '模板', dataIndex: 'tmpl_id', key: 'tmpl_id', width: 140, render: (v) => (v ? <StatusTag value={v} map={SUB_TMPL_NAMES} /> : <Tag>通用</Tag>) },
      { title: '次数', dataIndex: 'grant_count', key: 'grant_count', width: 70 },
      { title: '已用', dataIndex: 'used_count', key: 'used_count', width: 70 },
      { title: '状态', dataIndex: 'grant_status', key: 'grant_status', width: 80, render: (v) => <StatusTag value={v} map={SUB_GRANT_STATUS_MAP} /> },
      { title: '来源', dataIndex: 'source', key: 'source', width: 110, render: (v) => <StatusTag value={v} map={SUB_GRANT_SOURCE_MAP} /> },
      { title: '授权时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'grant_id', label: '授权ID' },
      { name: 'staff_id', label: '学生账号ID' },
      { name: '_recipientNickname', label: '学生昵称' },
      { name: 'openid', label: 'openid', span: 2 },
      { name: 'tmpl_id', label: '模板', type: 'tag', map: SUB_TMPL_NAMES },
      { name: 'grant_count', label: '授权次数' },
      { name: 'used_count', label: '已用次数' },
      { name: 'grant_status', label: '状态', type: 'tag', map: SUB_GRANT_STATUS_MAP },
      { name: 'source', label: '来源', type: 'tag', map: SUB_GRANT_SOURCE_MAP },
      { name: 'remark', label: '备注', type: 'longText', span: 2 },
      { name: 'created_at', label: '授权时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [],
  },

  // 订阅消息：发送结果记录（业务事件自动发送）——只读日志类
  subscribe_sends: {
    biz: 'subscribe_sends',
    title: '发送记录',
    entityName: '消息发送',
    searchable: ['openid'],
    searchKey: 'openid',
    readonly: true,
    defaultDays: 3,
    filters: [
      { name: 'send_status', label: '状态', options: [
        { value: 'sent', label: '发送成功' },
        { value: 'failed', label: '发送失败' },
        { value: 'skip', label: '跳过' },
      ] },
      { name: 'event_type', label: '事件', options: [
        { value: 'review_approve', label: '审核通过' },
        { value: 'review_reject', label: '审核驳回' },
        { value: 'checkin_remind', label: '打卡提醒' },
      ] },
      { name: 'tmpl_id', label: '模板', options: SUB_TMPL_OPTIONS },
    ],
    columns: [
      { title: 'ID', dataIndex: 'send_id', key: 'send_id', width: 110 },
      { title: '学生', dataIndex: 'staff_id', key: 'staff_id', width: 140, render: (v, r) => <StaffCell staffId={v} nickname={r._recipientNickname} /> },
      { title: '事件', dataIndex: 'event_type', key: 'event_type', width: 110, render: (v) => <StatusTag value={v} map={SUB_EVENT_MAP} /> },
      { title: '模板', dataIndex: 'tmpl_id', key: 'tmpl_id', width: 130, render: (v) => (v ? <StatusTag value={v} map={SUB_TMPL_NAMES} /> : <Tag>通用</Tag>) },
      { title: '状态', dataIndex: 'send_status', key: 'send_status', width: 90, render: (v) => <StatusTag value={v} map={SUB_SEND_STATUS_MAP} /> },
      { title: '消耗次数', dataIndex: 'credit_consumed', key: 'credit_consumed', width: 90, render: (v) => <BoolTag value={v} yes="是" no="否" /> },
      { title: '说明', dataIndex: 'errmsg', key: 'errmsg', width: 200, render: (v) => (v && v !== 'ok' ? <PlainText value={v} maxWidth={190} /> : <EmptyText />) },
      { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'send_id', label: '发送ID' },
      { name: 'staff_id', label: '学生账号ID' },
      { name: '_recipientNickname', label: '学生昵称' },
      { name: 'openid', label: 'openid', span: 2 },
      { name: 'event_type', label: '事件', type: 'tag', map: SUB_EVENT_MAP },
      { name: 'tmpl_id', label: '模板', type: 'tag', map: SUB_TMPL_NAMES },
      { name: 'biz_type', label: '业务类型' },
      { name: 'biz_id', label: '业务ID' },
      { name: 'page', label: '跳转页面', type: 'longText', span: 2 },
      { name: 'payload', label: '发送数据', type: 'json', span: 2 },
      { name: 'send_status', label: '状态', type: 'tag', map: SUB_SEND_STATUS_MAP },
      { name: 'errcode', label: '微信 errcode' },
      { name: 'errmsg', label: 'errmsg', type: 'longText', span: 2 },
      { name: 'credit_consumed', label: '消耗次数', type: 'bool', yes: '是', no: '否' },
      { name: 'created_at', label: '发送时间', type: 'date' },
    ],
    formFields: [],
  },

  file_uploads: {
    biz: 'file_uploads',
    title: '图片上传记录',
    searchable: ['openid', 'file_path'],
    searchKey: 'openid',
    readonly: true,
    // 日志类：默认只查最近 3 天，过滤栏可切换其他时间范围
    defaultDays: 3,
    // 列宽已收紧至常规屏幕可直接放下，x 仅作为最小宽度（超出才横向滚动）
    tableScroll: { x: 975 },
    // 支持多选批量删除：物理删除腾讯云存储对象 + 登记记录
    allowBatchDelete: true,
    // 操作列额外加宽 20px
    opWidthExtra: 20,
    filters: [
      { name: 'biz', label: '业务类型', options: [
        { value: 'avatar', label: '头像' },
        { value: 'events', label: '事件' },
        { value: 'tasks', label: '任务' },
      ] },
      { name: 'file_status', label: '文件状态', options: [
        { value: 'active', label: '正常' },
        { value: 'removed', label: '已删除' },
      ] },
    ],
    columns: [
      { title: '文件ID', dataIndex: 'file_id', key: 'file_id', width: 115, render: (v) => <PlainText value={v} maxWidth={105} /> },
      { title: '上传者', dataIndex: 'staff_id', key: 'staff_id', width: 120, render: (v, r) => <UploaderCell staffId={v} userId={r._userId} nickname={r._userNickname} avatar={r._userAvatar} avatarChar={r._userAvatarChar} /> },
      { title: '业务', dataIndex: 'biz', key: 'biz', width: 70, render: (v) => <StatusTag value={v} map={BIZ_MAP} /> },
      { title: '业务ID', dataIndex: 'biz_id', key: 'biz_id', width: 80, render: (v) => <PlainText value={v} maxWidth={70} /> },
      { title: '图片', dataIndex: 'file_url', key: 'file_url', width: 100, render: (v) => <TableImages value={v} /> },
      { title: '原大小', dataIndex: 'file_size_orig', key: 'file_size_orig', width: 75, render: (v, r) => <SizeText value={r.file_size_orig || r.file_size} /> },
      { title: '压缩后', dataIndex: 'file_size_compressed', key: 'file_size_compressed', width: 75, render: (v, r) => <SizeText value={r.file_size_compressed || r.file_size} /> },
      { title: '压缩比', dataIndex: 'file_size_ratio', key: 'file_size_ratio', width: 75, render: (v, r) => <RatioText value={r.file_size_ratio} orig={r.file_size_orig} comp={r.file_size_compressed || r.file_size} /> },
      { title: '状态', dataIndex: 'file_status', key: 'file_status', width: 70, render: (v) => <StatusTag value={v} map={FILE_STATUS_MAP} /> },
      { title: '上传时间', dataIndex: 'created_at', key: 'created_at', width: 120 },
    ],
    detailFields: [
      { name: 'file_id', label: '文件ID', type: 'text' },
      { name: 'staff_id', label: '上传者(员工)' },
      { name: '_userId', label: '用户', type: 'userCell', span: 2 },
      { name: 'openid', label: 'openid', type: 'text' },
      { name: 'biz', label: '业务类型', type: 'tag', map: BIZ_MAP },
      { name: 'biz_id', label: '业务ID', type: 'text' },
      { name: 'file_name', label: '原始文件名' },
      { name: 'file_url', label: '图片预览', type: 'images', span: 2 },
      { name: 'file_size_orig', label: '原大小', type: 'size' },
      { name: 'file_size_compressed', label: '压缩后大小', type: 'size' },
      { name: 'file_size_ratio', label: '压缩比', type: 'ratio' },
      { name: 'file_size', label: '实际存储大小(字节)' },
      { name: 'content_type', label: 'MIME类型' },
      { name: 'file_status', label: '文件状态', type: 'tag', map: FILE_STATUS_MAP },
      { name: 'created_at', label: '上传时间', type: 'date' },
    ],
    formFields: [],
  },

  user_events: {
    biz: 'user_events',
    title: '用户事件',
    drawerWidth: 820,
    searchable: ['openid', 'event_name', 'page_path'],
    searchKey: 'event_name',
    readonly: true,
    // 日志类：默认只查最近 3 天，过滤栏可切换其他时间范围
    defaultDays: 3,
    filters: [
      { name: 'event_type', label: '事件类型', options: [
        { value: 'login', label: '登录' },
        { value: 'page_view', label: '页面访问' },
        { value: 'menu_click', label: '菜单点击' },
        { value: 'button_click', label: '按钮点击' },
        { value: 'create', label: '创建' },
        { value: 'update', label: '更新' },
        { value: 'delete', label: '删除' },
        { value: 'end', label: '结束' },
        { value: 'reset', label: '重置' },
        { value: 'custom', label: '自定义' },
      ] },
    ],
    columns: [
      { title: '事件ID', dataIndex: 'event_id', key: 'event_id', width: 150, render: (v) => <PlainText value={v} maxWidth={140} /> },
      { title: '类型', dataIndex: 'event_type', key: 'event_type', width: 100, render: (v) => <StatusTag value={v} map={EVENT_TYPE_MAP2} /> },
      { title: '事件名称', dataIndex: 'event_name', key: 'event_name', width: 160 },
      { title: '页面', dataIndex: 'page_path', key: 'page_path', width: 180, render: (v) => <PlainText value={v} maxWidth={170} /> },
      { title: '用户', dataIndex: '_userId', key: '_userId', width: 140, render: (v, r) => <UserCell userId={r._userId} nickname={r._userNickname} avatar={r._userAvatar} avatarChar={r._userAvatarChar} /> },
      { title: '业务ID', dataIndex: 'biz_id', key: 'biz_id', width: 110, render: (v) => <PlainText value={v} maxWidth={100} /> },
      { title: '发生时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'event_id', label: '事件ID', type: 'text' },
      { name: 'event_type', label: '事件类型', type: 'tag', map: EVENT_TYPE_MAP2 },
      { name: 'event_name', label: '事件名称' },
      { name: 'page_path', label: '页面路径', type: 'longText', span: 2 },
      { name: '_userId', label: '用户', type: 'userCell', span: 2 },
      { name: 'openid', label: 'openid', type: 'text', span: 2 },
      { name: 'biz_id', label: '业务ID', type: 'text' },
      { name: 'extra', label: '附加信息', type: 'json', span: 2 },
      { name: 'client_at', label: '客户端时间', type: 'date' },
      { name: 'created_at', label: '入库时间', type: 'date' },
    ],
    formFields: [],
  },

  staff_events: {
    biz: 'staff_events',
    title: '操作审计',
    drawerWidth: 860,
    searchable: ['staff_username', 'event_name', 'module', 'client_ip'],
    searchKey: 'event_name',
    readonly: true,
    // 日志类：默认只查最近 3 天，过滤栏可切换其他时间范围
    defaultDays: 3,
    filters: [
      { name: 'staff_id', label: '操作人', optionsSource: 'staff', optionsParams: { pageSize: 200 }, optionsMap: { value: 'staff_id', label: 'staff_nickname' }, showSearch: true, width: 160 },
      { name: 'event_type', label: '事件类型', options: [
        { value: 'login', label: '登录' },
        { value: 'login_fail', label: '登录失败' },
        { value: 'logout', label: '退出登录' },
        { value: 'menu_click', label: '菜单点击' },
        { value: 'create', label: '创建' },
        { value: 'update', label: '更新' },
        { value: 'delete', label: '删除' },
        { value: 'detail', label: '查看详情' },
        { value: 'review', label: '审核' },
        { value: 'custom', label: '其他' },
      ] },
      { name: 'module', label: '模块', options: [
        { value: 'auth', label: '鉴权' },
        { value: 'menu', label: '菜单' },
        { value: 'upload', label: '上传' },
        { value: 'users', label: '用户' },
        { value: 'staff', label: '管理员' },
        { value: 'roles', label: '角色' },
        { value: 'menus', label: '菜单管理' },
        { value: 'dict_types', label: '字典类型' },
        { value: 'dict_items', label: '字典项' },
        { value: 'seqs', label: '序列' },
        { value: 'tasks', label: '任务' },
        { value: 'task_checkins', label: '任务打卡' },
        { value: 'task_collections', label: '合集' },
        { value: 'file_uploads', label: '图片上传' },
        { value: 'user_events', label: '用户事件' },
        { value: 'staff_events', label: '操作审计' },
        { value: 'monitors', label: '服务监控' },
        { value: 'traces', label: '接口链路' },
        { value: 'sessions', label: '会话画像' },
        { value: 'lp_invites', label: '邀请码' },
      ] },
    ],
    columns: [
      { title: '事件ID', dataIndex: 'event_id', key: 'event_id', width: 150, render: (v) => <PlainText value={v} maxWidth={140} /> },
      { title: '类型', dataIndex: 'event_type', key: 'event_type', width: 100, render: (v) => <StatusTag value={v} map={STAFF_EVENT_TYPE_MAP} /> },
      { title: '事件', dataIndex: 'event_name', key: 'event_name', width: 170, render: (v) => <PlainText value={v} maxWidth={160} /> },
      { title: '操作人', dataIndex: 'staff_id', key: 'staff_id', width: 150, render: (v, r) => <StaffCell staffId={v} nickname={r._staffNickname} /> },
      { title: '账号', dataIndex: 'staff_username', key: 'staff_username', width: 110 },
      { title: '模块', dataIndex: 'module', key: 'module', width: 100, render: (v) => (v ? <Tag color="blue">{v}</Tag> : <EmptyText />) },
      { title: '业务ID', dataIndex: 'biz_id', key: 'biz_id', width: 110, render: (v) => <PlainText value={v} maxWidth={100} /> },
      { title: 'IP', dataIndex: 'client_ip', key: 'client_ip', width: 130, render: (v) => <PlainText value={v} maxWidth={120} /> },
      { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'event_id', label: '事件ID', type: 'text', span: 2 },
      { name: 'event_type', label: '事件类型', type: 'tag', map: STAFF_EVENT_TYPE_MAP },
      { name: 'event_name', label: '事件名称' },
      { name: 'staff_id', label: '操作人', type: 'staffCell', span: 2 },
      { name: 'staff_username', label: '操作账号' },
      { name: 'module', label: '模块', type: 'tag', map: { auth: { label: '鉴权', color: 'green' }, menu: { label: '菜单', color: 'cyan' }, upload: { label: '上传', color: 'orange' } } },
      { name: 'biz_id', label: '业务ID', type: 'text' },
      { name: 'client_ip', label: '客户端IP', span: 2 },
      { name: 'client_fingerprint', label: '客户端指纹', type: 'longText', span: 2 },
      { name: 'user_agent', label: 'User-Agent', type: 'longText', span: 2 },
      { name: 'api_path', label: '接口路径', type: 'longText', span: 2 },
      { name: 'extra', label: '请求参数', type: 'json', span: 2 },
      { name: 'created_at', label: '事件时间', type: 'date' },
    ],
    formFields: [],
  },

  tasks: {
    biz: 'tasks',
    title: '任务管理',
    searchable: ['title', 'subject'],
    searchKey: 'title',
    checkin: true,
    timeline: { paramField: 'task_id', paramName: 'taskId', title: '任务时间轴', buttonText: '流程' },
    ownField: 'created_by',
    collectionPicker: true,
    gridOps: true,
    copyCreate: true,
    copyReset: ['score'],
    // 复制任务副本重置为未开始，保证可重新打卡
    copyResetValues: { task_status: 'todo' },
    // 已完成任务仅可查看：学生禁止编辑/删除/打卡（管理员不受限）
    lockFn: (record, { isAdmin }) => (!isAdmin && record.task_status === 'done')
      ? '任务已完成，仅可查看，禁止修改/删除/打卡'
      : null,
    // 任务ID不在表单内展示，改到新增/编辑窗口标题展示（编辑时显示：编辑任务（任务ID：xxxxxxx））
    titlePk: { field: 'task_id', label: '任务ID' },
    formColumns: 2,
    modalWidth: 1000,
    tableScroll: false,
    drawerColumns: 2,
    drawerWidth: 820,
    // 删除任务提醒：先查询关联打卡/图片数量，提示将一并级联删除，避免误删
    deleteTip: async (record) => {
      let stats = {};
      try {
        const res = await crudApi.taskDeleteStats(record.task_id);
        stats = res.data || {};
      } catch (_) {}
      const checkinCount = stats.checkin_count || 0;
      const imageCount = stats.image_count || 0;
      return `删除任务「${record.title || ''}」后不可恢复，将一并删除该任务下 ${checkinCount} 条打卡记录及 ${imageCount} 张图片，确定删除吗？`;
    },
    // 新增任务默认值：状态=未开始，评分=0分，派发人员默认 900001，开始日期=当天，截止日期=当天；
    // 学生自建任务由 CommonCrud 强制覆盖为派发本人（前后端双重校验）
    createDefaults: () => ({
      task_status: 'todo',
      score: 0,
      assignee_ids: [900001],
      start_date: dayjs().format('YYYY-MM-DD'),
      deadline: dayjs().format('YYYY-MM-DD'),
    }),
    filters: [
      { name: 'task_status', label: '任务状态', options: [
        { value: 'todo', label: '未开始' },
        { value: 'doing', label: '进行中' },
        { value: 'done', label: '已完成' },
      ] },
      { name: 'subject', label: '科目', optionsSource: 'dict_items', optionsParams: { dict_code: 'subject' }, optionsMap: { value: 'item_value', label: 'item_label' } },
      { name: 'collection_id', label: '合集', type: 'collection' },
    ],
    columns: [
      { title: '任务ID', dataIndex: 'task_id', key: 'task_id', width: 60, render: (v) => <PlainText value={v} maxWidth={55} /> },
      { title: '任务日期', dataIndex: 'start_date', key: 'start_date', width: 115 },
      { title: '创建人', dataIndex: 'created_by', key: 'created_by', width: 140, render: (v, r) => <StaffCell staffId={v} nickname={r._creatorNickname} /> },
      { title: '标题', dataIndex: 'title', key: 'title', width: 230, render: (v, r) => (
        <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <DictTag code="subject" value={r.subject} />{' '}{v}
        </div>
      ) },
      { title: '描述', dataIndex: 'description', key: 'description', width: 220, render: (v) => (v ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{v}</div> : <EmptyText />) },
      { title: '任务状态', dataIndex: 'task_status', key: 'task_status', listSlot: 'content', width: 170, render: (_, r) => renderTaskStatus(_, r, true) },
      { title: '任务评分', dataIndex: 'score', key: 'score', width: 85, align: 'center', render: (v) => <ScoreTag value={v} /> },
      { title: '派发人员', dataIndex: 'assignee_names', key: 'assignee_names', width: 120, render: (v, r) => <AssigneeTags names={r.assignee_names} /> },
      { title: '图片', dataIndex: 'images', key: 'images', width: 110, align: 'center', render: (v) => <TableImages value={v} maxShow={1} /> },
      { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 150 },
    ],
    detailFields: [
      { name: 'task_id', label: '任务ID', type: 'text' },
      { name: 'title', label: '任务标题', span: 2 },
      { name: 'task_status', label: '任务状态', type: 'tag', map: TASK_STATUS_MAP },
      { name: 'score', label: '任务评分', type: 'score' },
      { name: 'assignee_names', label: '任务派发', type: 'assignees' },
      { name: 'subject', label: '科目', type: 'dictTag', dict: 'subject' },
      { name: 'collection_name', label: '所属合集' },
      { name: 'checkin_count', label: '打卡次数' },
      { name: 'start_date', label: '开始日期', type: 'dateOnly' },
      { name: 'deadline', label: '截止日期', type: 'dateOnly' },
      { name: 'created_by', label: '创建人', type: 'staffCell' },
      { name: 'tags', label: '标签', type: 'tags', span: 2 },
      { name: 'images', label: '任务图片', type: 'images', span: 2 },
      { name: 'description', label: '任务描述', type: 'linkText', span: 2 },
      { name: 'task_link', label: '任务链接', type: 'linkText', span: 2 },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'title', label: '任务标题', type: 'text', span: 24, rules: [{ required: true }], placeholder: '请输入任务标题' },
      { name: 'assignee_ids', label: '派发学生', type: 'assignee', span: 12, rules: [{ required: true, type: 'array', message: '请选择派发学生' }], placeholder: '选择任务派发给哪些学生（可多选）' },
      { name: 'subject', label: '科目', type: 'select', span: 12, optionsSource: 'dict_items', optionsParams: { dict_code: 'subject' }, optionsMap: { value: 'item_value', label: 'item_label' }, rules: [{ required: true, message: '请选择科目' }], placeholder: '请选择科目' },
      { name: 'collection_id', label: '所属合集（可选）', type: 'select', span: 12, optionsSource: 'task_collections', optionsParams: { pageSize: 200 }, optionsMap: { value: 'collection_id', label: 'name' }, showSearch: true, allowClear: true, placeholder: '请选择合集（可不选，只能选一个）' },
      { name: 'task_status', label: '任务状态', type: 'select', span: 12, options: [
        { value: 'todo', label: '未开始' },
        { value: 'doing', label: '进行中' },
        { value: 'done', label: '已完成' },
      ], placeholder: '请选择任务状态' },
      { name: 'score', label: '任务评分', type: 'select', span: 12, options: SCORE_OPTIONS, disabledWhenCreate: true, tip: ({ editing }) => (editing ? undefined : '初始固定为 0 分，禁止选择'), placeholder: '请选择任务评分' },
      { name: 'start_date', label: '开始日期', type: 'date', span: 12, placeholder: '请选择开始日期' },
      { name: 'deadline', label: '截止日期', type: 'date', span: 12, placeholder: '请选择截止日期' },
      { name: 'tags', label: '标签（输入后回车添加，可多个）', type: 'tags', span: 12, placeholder: '输入后回车添加标签' },
      { name: 'images', label: '任务图片（最多9张）', type: 'images', span: 24, side: 'right', max: 9, biz: 'tasks' },
      { name: 'task_link', label: '任务链接', type: 'text', span: 24, side: 'right', placeholder: '请输入任务链接（http/https 开头，详情页可点击跳转）' },
      { name: 'description', label: '任务描述', type: 'textarea', span: 24, side: 'right', placeholder: '请输入任务描述' },
    ],
  },

  task_checkins: {
    biz: 'task_checkins',
    title: '打卡管理',
    searchable: ['checkin_note'],
    searchKey: 'checkin_note',
    noCreate: true,
    allowDelete: true,
    timeline: { paramField: 'checkin_id', paramName: 'checkinId', title: '打卡时间轴' },
    ownField: 'created_by',
    // 已完成任务仅可查看：学生禁止修改/删除打卡（管理员不受限）
    lockFn: (record, { isAdmin }) => (!isAdmin && record.task_status === 'done')
      ? '任务已完成，仅可查看，禁止修改/删除打卡'
      : null,
    // 布局与「任务管理」保持一致：操作列网格、双列表单、单列详情抽屉、禁止横滚动条
    gridOps: true,
    formColumns: 2,
    tableScroll: false,
    drawerColumns: 2,
    drawerWidth: 820,
    filters: [
      { name: 'checkin_date', label: '打卡日期', type: 'date' },
    ],
    columns: [
      { title: 'ID', dataIndex: 'checkin_id', key: 'checkin_id', width: 80 },
      { title: '任务ID', dataIndex: 'task_id', key: 'task_id', width: 60, render: (v) => <PlainText value={v} maxWidth={55} /> },
      { title: '任务标题', dataIndex: 'task_title', key: 'task_title', width: 160, render: (v) => (v ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{v}</div> : <EmptyText />) },
      { title: '任务状态', dataIndex: 'task_status', key: 'task_status', listSlot: 'content', width: 170, render: renderTaskStatus },
      { title: '图片', dataIndex: 'checkin_images', key: 'checkin_images', width: 110, align: 'center', render: (v) => <TableImages value={v} maxShow={1} /> },
      { title: '备注', dataIndex: 'checkin_note', key: 'checkin_note', width: 170, render: (v) => (v ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{v}</div> : <EmptyText />) },
      { title: '打卡人', dataIndex: 'created_by', key: 'created_by', width: 140, render: (v, r) => <StaffCell staffId={v} username={r._creatorUsername} nickname={r._creatorNickname} /> },
      { title: '打卡时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'checkin_id', label: '打卡ID' },
      { name: 'task_id', label: '任务ID', type: 'text' },
      { name: 'task_title', label: '任务标题', span: 2 },
      { name: 'task_status', label: '任务状态', type: 'tag', map: TASK_STATUS_MAP },
      { name: 'checkin_date', label: '打卡日期', type: 'dateOnly' },
      { name: 'checkin_note', label: '备注', type: 'longText', span: 2 },
      { name: 'checkin_images', label: '打卡图片', type: 'images', span: 2 },
      { name: 'created_by', label: '打卡人', type: 'staffCell' },
      { name: 'created_at', label: '打卡时间', type: 'date' },
    ],
    formFields: [
      { name: 'checkin_id', label: '打卡ID', type: 'pk', span: 12, createText: '创建后自动生成' },
      { name: 'checkin_date', label: '打卡日期', type: 'date', span: 12, rules: [{ required: true }], placeholder: '请选择打卡日期' },
      { name: 'checkin_note', label: '打卡备注', type: 'textarea', span: 24, placeholder: '请输入打卡备注' },
      { name: 'checkin_images', label: '打卡图片（最多9张）', type: 'images', span: 24, max: 9, biz: 'tasks' },
    ],
  },

  task_collections: {
    biz: 'task_collections',
    title: '合集管理',
    entityName: '合集',
    searchable: ['name'],
    searchKey: 'name',
    ownField: 'created_by',
    formColumns: 2,
    createDefaults: () => ({ collection_status: 1 }),
    filters: [
      { name: 'collection_status', label: '状态', options: [
        { value: 1, label: '启用' },
        { value: 0, label: '停用' },
      ] },
    ],
    columns: [
      { title: 'ID', dataIndex: 'collection_id', key: 'collection_id', width: 70 },
      { title: '合集名称', dataIndex: 'name', key: 'name', width: 180, render: (v) => <PlainText value={v} maxWidth={170} /> },
      { title: '任务数', dataIndex: 'task_count', key: 'task_count', width: 80 },
      { title: '封面', dataIndex: 'cover_images', key: 'cover_images', width: 80, render: (v) => <CoverThumb value={v} size={64} /> },
      { title: '描述', dataIndex: 'description', key: 'description', width: 240, render: (v) => (v ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{v}</div> : <EmptyText />) },
      { title: '创建人', dataIndex: 'created_by', key: 'created_by', width: 140, render: (v, r) => <StaffCell staffId={v} nickname={r._creatorNickname} /> },
      { title: '状态', dataIndex: 'collection_status', key: 'collection_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '停用', color: 'error' } }} /> },
      { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 150 },
    ],
    detailFields: [
      { name: 'collection_id', label: '合集ID', type: 'text' },
      { name: 'name', label: '合集名称' },
      { name: 'task_count', label: '任务数量' },
      { name: 'collection_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '停用', color: 'error' } } },
      { name: 'created_by', label: '创建人', type: 'staffCell' },
      { name: 'cover_images', label: '封面图', type: 'images', span: 2 },
      { name: 'description', label: '合集描述', type: 'longText', span: 2 },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'name', label: '合集名称', type: 'text', span: 12, rules: [{ required: true }], placeholder: '请输入合集名称，如：数学单元练习' },
      { name: 'collection_id', label: '合集ID', type: 'pk', span: 12, createText: '创建后自动生成' },
      { name: 'collection_status', label: '状态', type: 'select', span: 12, options: [{ value: 1, label: '启用' }, { value: 0, label: '停用' }], placeholder: '请选择状态' },
      { name: 'cover_images', label: '封面图（1张，正方形）', type: 'images', span: 12, max: 1, size: 120, biz: 'tasks', square: true },
      { name: 'description', label: '合集描述', type: 'textarea', span: 24, placeholder: '请输入合集描述' },
    ],
  },

  roles: {
    biz: 'roles',
    title: '角色管理',
    searchable: ['role_name', 'role_code'],
    searchKey: 'role_name',
    menuTree: true,
    columns: [
      { title: 'ID', dataIndex: 'role_id', key: 'role_id', width: 80 },
      { title: '角色编码', dataIndex: 'role_code', key: 'role_code', width: 120, render: (v) => <Tag color="blue">{v}</Tag> },
      { title: '角色名称', dataIndex: 'role_name', key: 'role_name', width: 130 },
      { title: '状态', dataIndex: 'role_status', key: 'role_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } }} /> },
      { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'role_id', label: 'ID' },
      { name: 'role_code', label: '角色编码' },
      { name: 'role_name', label: '角色名称' },
      { name: 'role_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } } },
      { name: 'menuIds', label: '菜单ID', type: 'json', span: 2 },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'role_code', label: '角色编码（如 student）', type: 'text', rules: [{ required: true }] },
      { name: 'role_name', label: '角色名称', type: 'text', rules: [{ required: true }] },
      { name: 'role_status', label: '状态', type: 'select', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
    ],
  },

  menus: {
    biz: 'menus',
    title: '菜单管理',
    searchable: ['menu_name', 'menu_path'],
    searchKey: 'menu_name',
    filters: [
      { name: 'menu_type', label: '类型', options: [{ value: 1, label: '分组' }, { value: 2, label: '叶子' }] },
      { name: 'menu_status', label: '状态', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
    ],
    columns: [
      { title: 'ID', dataIndex: 'menu_id', key: 'menu_id', width: 70 },
      { title: '父级', dataIndex: 'parent_id', key: 'parent_id', width: 70 },
      { title: '名称', dataIndex: 'menu_name', key: 'menu_name', width: 130 },
      { title: '路径', dataIndex: 'menu_path', key: 'menu_path', width: 180, render: (v) => <PlainText value={v} maxWidth={170} /> },
      { title: '图标', dataIndex: 'menu_icon', key: 'menu_icon', width: 140, render: (v) => <PlainText value={v} maxWidth={130} /> },
      { title: '类型', dataIndex: 'menu_type', key: 'menu_type', width: 80, render: (v) => <StatusTag value={v} map={MENU_TYPE_MAP} /> },
      { title: '排序', dataIndex: 'sort', key: 'sort', width: 60 },
      { title: '状态', dataIndex: 'menu_status', key: 'menu_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } }} /> },
      { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 150 },
    ],
    detailFields: [
      { name: 'menu_id', label: 'ID' },
      { name: 'parent_id', label: '父级ID' },
      { name: 'menu_name', label: '名称' },
      { name: 'menu_path', label: '路径', type: 'longText', span: 2 },
      { name: 'menu_icon', label: '图标' },
      { name: 'menu_type', label: '类型', type: 'tag', map: MENU_TYPE_MAP },
      { name: 'sort', label: '排序' },
      { name: 'menu_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } } },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'parent_id', label: '父级ID', type: 'select', optionsSource: 'menus', optionsMap: { value: 'menu_id', label: 'menu_name' } },
      { name: 'menu_name', label: '名称', type: 'text', rules: [{ required: true }] },
      { name: 'menu_path', label: '路径', type: 'text', placeholder: '如 /module/users 或 /dashboard/learning' },
      { name: 'menu_icon', label: '图标', type: 'text', placeholder: '如 DashboardOutlined' },
      { name: 'menu_type', label: '类型', type: 'select', options: [{ value: 1, label: '分组' }, { value: 2, label: '叶子' }] },
      { name: 'sort', label: '排序', type: 'number' },
      { name: 'menu_status', label: '状态', type: 'select', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
    ],
  },

  dict_types: {
    biz: 'dict_types',
    title: '字典类型',
    searchable: ['dict_code', 'dict_name'],
    searchKey: 'dict_name',
    columns: [
      { title: 'ID', dataIndex: 'dict_id', key: 'dict_id', width: 80 },
      { title: '字典编码', dataIndex: 'dict_code', key: 'dict_code', width: 150, render: (v) => <Tag color="blue">{v}</Tag> },
      { title: '字典名称', dataIndex: 'dict_name', key: 'dict_name', width: 140 },
      { title: '状态', dataIndex: 'dict_status', key: 'dict_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } }} /> },
      { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150 },
    ],
    detailFields: [
      { name: 'dict_id', label: 'ID' },
      { name: 'dict_code', label: '字典编码' },
      { name: 'dict_name', label: '字典名称' },
      { name: 'dict_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } } },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'dict_code', label: '字典编码（如 subject）', type: 'text', rules: [{ required: true }] },
      { name: 'dict_name', label: '字典名称', type: 'text', rules: [{ required: true }] },
      { name: 'dict_status', label: '状态', type: 'select', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
    ],
  },

  dict_items: {
    biz: 'dict_items',
    title: '字典项',
    searchable: ['item_label', 'item_value'],
    searchKey: 'item_label',
    filters: [
      { name: 'dict_code', label: '字典', optionsSource: 'dict_types', optionsMap: { value: 'dict_code', label: 'dict_name' } },
      { name: 'item_status', label: '状态', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
    ],
    columns: [
      { title: 'ID', dataIndex: 'item_id', key: 'item_id', width: 80 },
      { title: '字典', dataIndex: 'dict_code', key: 'dict_code', width: 130, render: (v) => <Tag color="blue">{v}</Tag> },
      { title: '项值', dataIndex: 'item_value', key: 'item_value', width: 120 },
      { title: '项名称', dataIndex: 'item_label', key: 'item_label', width: 130 },
      { title: '排序', dataIndex: 'sort', key: 'sort', width: 70 },
      { title: '状态', dataIndex: 'item_status', key: 'item_status', width: 80, render: (v) => <StatusTag value={v} map={{ 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } }} /> },
      { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 150 },
    ],
    detailFields: [
      { name: 'item_id', label: 'ID' },
      { name: 'dict_code', label: '字典编码' },
      { name: 'item_value', label: '项值' },
      { name: 'item_label', label: '项名称' },
      { name: 'sort', label: '排序' },
      { name: 'item_status', label: '状态', type: 'tag', map: { 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } } },
      { name: 'created_at', label: '创建时间', type: 'date' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'dict_code', label: '所属字典', type: 'select', optionsSource: 'dict_types', optionsMap: { value: 'dict_code', label: 'dict_name' }, rules: [{ required: true }] },
      { name: 'item_value', label: '项值', type: 'text', rules: [{ required: true }] },
      { name: 'item_label', label: '项名称', type: 'text', rules: [{ required: true }] },
      { name: 'sort', label: '排序', type: 'number' },
      { name: 'item_status', label: '状态', type: 'select', options: [{ value: 1, label: '启用' }, { value: 0, label: '禁用' }] },
    ],
  },

  seqs: {
    biz: 'seqs',
    title: '序列管理',
    searchable: ['seq_key', 'seq_name'],
    searchKey: 'seq_key',
    rowDblClick: true,
    columns: [
      { title: '序列键', dataIndex: 'seq_key', key: 'seq_key', width: 130, render: (v) => <Tag color="blue">{v}</Tag> },
      { title: '序列名称', dataIndex: 'seq_name', key: 'seq_name', width: 160 },
      { title: '当前值', dataIndex: 'current_value', key: 'current_value', width: 100 },
      { title: '初始值', dataIndex: 'init_value', key: 'init_value', width: 100 },
      { title: '步长', dataIndex: 'step', key: 'step', width: 80 },
      { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 150 },
    ],
    detailFields: [
      { name: 'seq_key', label: '序列键' },
      { name: 'seq_name', label: '序列名称' },
      { name: 'current_value', label: '当前值（下次发放值）' },
      { name: 'init_value', label: '初始值' },
      { name: 'step', label: '步长' },
      { name: 'updated_at', label: '更新时间', type: 'date' },
    ],
    formFields: [
      { name: 'seq_key', label: '序列键（如 task_id）', type: 'text', span: 12, rules: [{ required: true }], placeholder: '如 task_id' },
      { name: 'seq_name', label: '序列名称', type: 'text', span: 12, placeholder: '如 任务ID' },
      { name: 'current_value', label: '当前值（下次发放值）', type: 'number', span: 12, placeholder: '当前值' },
      { name: 'init_value', label: '初始值', type: 'number', span: 12, placeholder: '初始值' },
      { name: 'step', label: '步长', type: 'number', span: 12, placeholder: '步长' },
    ],
  },
};
