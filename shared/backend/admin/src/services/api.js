import axios from 'axios';
import { message } from 'antd';

// axios 实例：baseURL 为空（同源，admin 构建产物与 API 同服务）
const api = axios.create({ timeout: 30000 });

// 跳转登录（统一处理：清空凭证 + 强制跳转）
function toLogin() {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
  if (window.location.pathname !== '/admin/login') {
    window.location.href = '/admin/login';
  }
}

// 请求拦截：附加 token + 当前选中的小程序（app_id）
// 多小程序共享后台：后端 requireAppAccess 按 app 维度隔离数据，未携带时默认第一个可管理的小程序
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  const appId = localStorage.getItem('admin_app');
  if (appId) {
    if ((config.method || 'get').toLowerCase() === 'get') {
      config.params = { ...(config.params || {}), app: appId };
    } else {
      config.data = { ...(config.data || {}), app: appId };
    }
  }
  return config;
});

// 响应拦截：统一处理 code
api.interceptors.response.use(
  (res) => {
    const data = res.data || {};
    if (data.code === 0) return data;
    if (data.code === 401) {
      toLogin();
      return Promise.reject(data);
    }
    message.error(data.msg || '请求失败');
    return Promise.reject(data);
  },
  (err) => {
    // HTTP 级错误：401（token 过期/无效）强制跳转登录
    if (err.response && err.response.status === 401) {
      toLogin();
      return Promise.reject(err);
    }
    if (err.response && err.response.data && err.response.data.msg) {
      message.error(err.response.data.msg);
    } else {
      message.error(err.message || '网络异常');
    }
    return Promise.reject(err);
  }
);

// ==================== 鉴权 API ====================
export const authApi = {
  login: (username, password) => api.post('/admin/login', { username, password }),
  me: () => api.get('/admin/me'),
  // 当前管理员可管理的小程序（后台小程序切换器数据源）
  myApps: () => api.get('/admin/myApps'),
};

// ==================== 操作审计 API ====================
// 退出登录留痕 + 菜单点击/页面访问等事件上报（写入 staff_events 审计表）
export const auditApi = {
  logout: () => api.post('/admin/logout'),
  report: (data) => api.post('/admin/api/audit/report', data),
};

// ==================== 通用 CRUD API ====================
// biz: users/monitors/traces/sessions/staff/file_uploads/user_events/tasks/task_checkins/task_collections/menus
export const crudApi = {
  list: (biz, params) => api.get(`/admin/api/${biz}/list`, { params }),
  detail: (biz, id) => api.get(`/admin/api/${biz}/detail`, { params: { id } }),
  create: (biz, data) => api.post(`/admin/api/${biz}/create`, data),
  update: (biz, id, data) => api.post(`/admin/api/${biz}/update`, { id, ...data }),
  remove: (biz, id) => api.post(`/admin/api/${biz}/delete`, { id }),
  // 批量删除（file_uploads：物理删除腾讯云存储对象 + 登记记录）
  batchDelete: (biz, ids) => api.post(`/admin/api/${biz}/batchDelete`, { ids }),
  // 内容审核：action = approve / reject（endpoint 默认 review，用户资料审核为 reviewProfile）
  review: (biz, id, action, endpoint = 'review') => api.post(`/admin/api/${biz}/${endpoint}`, { id, action }),
  // 用户账号锁定/解锁（按 user_id，含时效；操作写入 staff_events 审计）
  userLock: (id, data) => api.post('/admin/api/users/lock', { id, ...data }),
  userUnlock: (id) => api.post('/admin/api/users/unlock', { id }),
  // 任务打卡
  taskCheckin: (data) => api.post('/admin/api/tasks/checkin', data),
  // 待办任务（学生卡片视图数据源）
  todoTasks: (params) => api.get('/admin/api/todo_tasks/list', { params }),
  // 打卡审核（管理员审核学生打卡）：待审核列表 / 通过·驳回
  checkinReviewList: (params) => api.get('/admin/api/checkin_reviews/list', { params }),
  checkinReview: (data) => api.post('/admin/api/checkin_reviews/review', data),
  // 任务时间轴（任务/打卡全生命周期事件，审计用；taskId 或 checkinId 二选一）
  taskTimeline: (params) => api.get('/admin/api/tasks/timeline', { params }),
  // 删除任务前统计（关联打卡数 / 图片数），供删除确认弹窗展示级联删除提醒
  taskDeleteStats: (taskId) => api.get('/admin/api/tasks/deleteStats', { params: { taskId } }),
  // 上传图片（base64 → 云存储）
  upload: (biz, file) => api.post('/admin/api/upload', { biz, file }),
  // 课小满邀请码独立管理（t_lp_invites，仅管理员）：作废 / 重新生成
  lpInviteRevoke: (id) => api.post('/admin/api/lp_invites/revoke', { id }),
  lpInviteRegenerate: (id) => api.post('/admin/api/lp_invites/regenerate', { id }),
  // 课小满绑定关系管理（openid ↔ 学生账号）：列表 / 详情 / 解除绑定 / 变更绑定
  lpStudentList: (params) => api.get('/admin/api/lp_students/list', { params }),
  lpStudentDetail: (id) => api.get('/admin/api/lp_students/detail', { params: { id } }),
  lpStudentUnbind: (id) => api.post('/admin/api/lp_students/unbind', { id }),
  lpStudentRebind: (id, staffId) => api.post('/admin/api/lp_students/rebind', { id, staffId }),
  // 订阅消息：后台给学生赠送订阅次数 { staffId, tmplId, count, remark }
  subscribeGrant: (data) => api.post('/admin/api/subscribe_grants/grant', data),
};

// 独立上传 API（供 ImageUploader 等组件使用）
export const uploadApi = {
  upload: (biz, file) => api.post('/admin/api/upload', { biz, file }),
};

// ==================== 动态菜单 API ====================
export const menuApi = {
  list: () => api.get('/admin/menus'),
  all: () => api.get('/admin/menus/all'),
};

// ==================== 仪表盘 API ====================
export const dashboardApi = {
  monitor: () => api.get('/admin/dashboard/monitor'),
  learning: () => api.get('/admin/dashboard/learning'),
};
