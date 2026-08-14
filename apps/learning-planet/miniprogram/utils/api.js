/**
 * 课小满 - API 封装（环境内直调 wx.cloud.callContainer）
 *
 * 认证分两层：
 *   1. 登录：wx.login 换 code → /api/lp/login 签发「小程序会话 token」（仅含 openid），与微信授权无关，打开即得。
 *   2. 业务身份：输入 6 位邀请码 → /api/lp/bind 绑定学生/管理员身份；有码能进业务页，无码进绑定页。
 * 业务请求带 X-LP-Token: <token>；邀请码被作废时后端返回 403（访问已锁定）。
 *
 * 传输方式：小程序已绑定云环境，直接经 wx.cloud.callContainer 调用云托管服务，
 * 请求头 X-WX-SERVICE 指定服务名，X-WX-OPENID / X-WX-APPID 由云托管网关自动注入。
 */
// 云开发环境 ID 与云托管服务名（与共享后端一致）
export const CLOUD_ENV = 'cloud1-d6gddqzrsda16338f';
export const CLOUD_SERVICE = 'kxm-service';

/** 会话 token 读取 */
function getToken() {
  try { return wx.getStorageSync('lp_token') || ''; } catch (_) { return ''; }
}

/** 当前角色（student / admin） */
function getRole() {
  try { return wx.getStorageSync('lp_role') || 'student'; } catch (_) { return 'student'; }
}

/** 管理员当前切换查看的学生（空串=看自己） */
function getViewStudent() {
  try { return wx.getStorageSync('lp_view_staff_id') || ''; } catch (_) { return ''; }
}
function setViewStudent(id) {
  try { wx.setStorageSync('lp_view_staff_id', String(id || '')); } catch (_) {}
}
function clearViewStudent() { setViewStudent(''); }

/**
 * 统一请求（环境内直调云托管）
 * @param {string} path 如 /api/lp/dashboard
 * @param {object} opts { method, data, auth }
 */
function request(path, opts = {}) {
  const { method = 'GET', data = {}, auth = true } = opts;
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path,
      method,
      data,
      header: {
        'X-WX-SERVICE': CLOUD_SERVICE,
        'X-LP-Token': auth ? getToken() : '',
      },
      success: (res) => {
        const body = (res && res.data) || {};
        if (body.code === 0) {
          resolve(body.data);
        } else if (body.code === 401) {
          wx.removeStorageSync('lp_token');
          wx.removeStorageSync('lp_staff');
          wx.removeStorageSync('lp_role');
          wx.removeStorageSync('lp_view_staff_id');
          wx.reLaunch({ url: '/pages/bind/bind' });
          reject({ code: 401, msg: body.msg || '登录已过期' });
        } else if (body.code === 403) {
          // 邀请码已作废 / 访问被锁定
          wx.removeStorageSync('lp_token');
          wx.removeStorageSync('lp_staff');
          wx.removeStorageSync('lp_role');
          wx.removeStorageSync('lp_view_staff_id');
          wx.reLaunch({ url: '/pages/bind/bind?locked=1' });
          reject({ code: 403, msg: body.msg || '访问已锁定' });
        } else {
          reject({ code: body.code, msg: body.msg || '操作失败' });
        }
      },
      fail: (err) => {
        console.error('[lp] callContainer fail', path, err);
        reject({ code: -1, msg: '网络异常，请稍后重试' });
      },
    });
  });
}

/** wx.login 换登录 code */
function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({ success: (r) => (r.code ? resolve(r.code) : reject(new Error('login 无 code'))), fail: () => reject(new Error('wx.login 失败')) });
  });
}

// ==================== 认证 API ====================
export const lpAuth = {
  /** 登录：wx.login 换小程序会话 token → { token, bound, locked?, role?, staff? } */
  login: async () => {
    const code = await wxLoginCode();
    return request('/api/lp/login', { method: 'POST', data: { code }, auth: false });
  },
  /** 绑定邀请码：{ code, rebind }（openid 取自会话 token）→ { token, role, staff }；rebind=true 表示换绑新邀请码 */
  bind: async (code, rebind) => {
    // 确保已有会话 token（未登录时先登录拿 token）
    if (!getToken()) {
      try {
        const res = await lpAuth.login();
        if (res && res.token) wx.setStorageSync('lp_token', res.token);
      } catch (_) {}
    }
    return request('/api/lp/bind', { method: 'POST', data: { code, rebind: !!rebind } });
  },
  /** 家长注册：身份选择「我是家长」确认后自动建号/自动绑定/发共享码/下发后台账号
   *  → { token, bound, role, staff, share_code, backend: { username, password } } */
  registerParent: async (nickname) => {
    if (!getToken()) {
      try {
        const res = await lpAuth.login();
        if (res && res.token) wx.setStorageSync('lp_token', res.token);
      } catch (_) {}
    }
    return request('/api/lp/registerParent', { method: 'POST', data: { nickname } });
  },
};

// ==================== 家庭 / 家长 API ====================
export const family = {
  /** 我的家庭上下文 → { role, children[], member_of?, parent_account? } */
  context: () => request('/api/lp/family/context'),
  /** 新增孩子档案 { child_name, gender, birth_date, school_name, grade, class_no } → 孩子 + 学生码 */
  childCreate: (data) => request('/api/lp/family/children/create', { method: 'POST', data }),
  /** 更新孩子档案 { child_id, ... } */
  childUpdate: (data) => request('/api/lp/family/children/update', { method: 'POST', data }),
  /** 删除孩子档案 { child_id } */
  childDelete: (id) => request('/api/lp/family/children/delete', { method: 'POST', data: { child_id: id } }),
  /** 生成/重生成学生邀请码 { child_id } → { invite_code } */
  childInvite: (id) => request('/api/lp/family/children/invite', { method: 'POST', data: { child_id: id } }),
  /** 作废学生邀请码 { child_id } */
  childInviteRevoke: (id) => request('/api/lp/family/children/invite/revoke', { method: 'POST', data: { child_id: id } }),
  /** 生成家属共享码 → { invite_code } */
  shareGenerate: () => request('/api/lp/family/share/generate', { method: 'POST', data: {} }),
  /** 作废家属共享码 { invite_id } */
  shareRevoke: (inviteId) => request('/api/lp/family/share/revoke', { method: 'POST', data: { invite_id: inviteId } }),
  /** 我的共享记录（主家长）→ { list[] } */
  shares: () => request('/api/lp/family/shares'),
  /** 重置后台登录密码 → { password }（明文仅展示一次） */
  passwordReset: () => request('/api/lp/family/password/reset', { method: 'POST', data: {} }),
};

// ==================== 业务 API ====================
// 读接口支持 asStaffId：管理员切换查看某学生的任务/仪表盘；学生传空即可
export const lp = {
  profile: () => request('/api/lp/profile'),
  updateProfile: (data) => request('/api/lp/profile', { method: 'POST', data }),

  dashboard: (asStaffId) => request('/api/lp/dashboard', { data: asStaffId ? { asStaffId } : {} }),

  tasks: (params, asStaffId) => request('/api/lp/tasks', { data: { ...(params || {}), ...(asStaffId ? { asStaffId } : {}) } }),
  taskDetail: (id, asStaffId) => request('/api/lp/tasks/detail', { data: { id, ...(asStaffId ? { asStaffId } : {}) } }),
  taskCreate: (data) => request('/api/lp/tasks/create', { method: 'POST', data }),
  taskCopy: (id) => request('/api/lp/tasks/copy', { method: 'POST', data: { id } }),
  taskUpdate: (data) => request('/api/lp/tasks/update', { method: 'POST', data }),
  taskStatus: (data) => request('/api/lp/tasks/status', { method: 'POST', data }),
  taskDelete: (id) => request('/api/lp/tasks/delete', { method: 'POST', data: { id } }),

  checkins: (params, asStaffId) => request('/api/lp/checkins', { data: { ...(params || {}), ...(asStaffId ? { asStaffId } : {}) } }),
  checkinCreate: (data) => request('/api/lp/checkins/create', { method: 'POST', data }),
  checkinDelete: (id) => request('/api/lp/checkins/delete', { method: 'POST', data: { id } }),

  collections: () => request('/api/lp/collections'),
  collectionCreate: (data) => request('/api/lp/collections/create', { method: 'POST', data }),
  collectionUpdate: (data) => request('/api/lp/collections/update', { method: 'POST', data }),
  collectionDelete: (id) => request('/api/lp/collections/delete', { method: 'POST', data: { id } }),

  /** 管理员：学生列表（用于切换查看学生任务） */
  adminStudents: () => request('/api/lp/admin/students'),

  /** 待办（角色差异化：学生=待打卡任务；管理员=待审核打卡） */
  todos: () => request('/api/lp/todos'),
  /** 管理员审核打卡 { checkinId, action: 'approve'|'reject', score?, note? } */
  todosReview: (data) => request('/api/lp/todos/review', { method: 'POST', data }),

  /** 订阅消息状态（可用次数/模板配置/授权记录） */
  subscribeStatus: () => request('/api/lp/subscribe/status'),
  /** 记录订阅授权 { tmplIds, grantCount, remark? } */
  subscribeGrant: (data) => request('/api/lp/subscribe/grant', { method: 'POST', data }),

  /** 批量图片上传（base64 JSON，逐张直调后端，避开单次请求体过大） → 相对路径列表 */
  upload: (biz, files) => request('/api/lp/upload', { method: 'POST', data: { biz, files } }),
};

// ==================== 数据上报 API ====================
export const analytics = {
  /** 会话画像采集（user_sessions） */
  collectSession: (session) => request('/api/lp/collectSession', { method: 'POST', data: { session } }),
  /** 用户操作事件（user_events） */
  collectEvent: (payload) => request('/api/lp/collectEvent', { method: 'POST', data: payload }),
};

export { getToken, getRole, getViewStudent, setViewStudent, clearViewStudent, CLOUD_ENV, CLOUD_SERVICE };
