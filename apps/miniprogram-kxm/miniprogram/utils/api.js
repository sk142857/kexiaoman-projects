/**
 * 课小满 - API 封装（环境内直调 wx.cloud.callContainer）
 *
 * 认证分两层：
 *   1. 登录：wx.login 换 code → /api/lp/login 签发「小程序会话 token」（仅含 openid），与微信授权无关，打开即得。
 *   2. 业务身份：输入 6 位邀请码 → /api/lp/bind 绑定学生/管理员身份；有码能进业务页，无码进绑定页。
 * 业务请求带 X-LP-Token: <token>；绑定被解除时后端返回 401（回身份页重新绑定），账号被锁定返回 403（访问已锁定）。
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

/** 当前活动身份 staff_id（共用微信多身份切换） */
function getActiveStaffId() {
  try { return wx.getStorageSync('lp_active_staff_id') || ''; } catch (_) { return ''; }
}
function setActiveStaffId(id) {
  try { wx.setStorageSync('lp_active_staff_id', String(id || '')); } catch (_) {}
}

/** 当前 openid 已绑定的全部身份（家长 + 孩子 + 家属） */
function getIdentities() {
  try { return wx.getStorageSync('lp_identities') || []; } catch (_) { return []; }
}
function setIdentities(list) {
  try { wx.setStorageSync('lp_identities', Array.isArray(list) ? list : []); } catch (_) {}
}

/** 生成请求链路 UUID（X-Request-Id，接口链路追踪关联键） */
function genRequestId() {
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
}

/** 异步上报前端耗时（fire-and-forget，不阻塞回调；失败静默） */
function reportClientCost(requestId, clientCostMs) {
  try {
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path: '/api/lp/reportTrace',
      method: 'POST',
      data: { requestId, clientCostMs },
      header: {
        'X-WX-SERVICE': CLOUD_SERVICE,
        'X-LP-Token': getToken(),
      },
      success: () => {},
      fail: () => {},
    });
  } catch (_) {}
}

/** 停止全局会话心跳（登录被解除/失效后避免重复轮询与重复跳页） */
function stopSessionGuard() {
  try {
    const app = getApp();
    if (app && typeof app.stopSessionGuard === 'function') app.stopSessionGuard();
  } catch (_) {}
}

/** 最近一次因 401/403 被踢回身份页的时间（短时冷却，兜底防止异常环境下 reLaunch 死循环） */
let lastAuthRedirectAt = 0;

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
 * @param {object} opts { method, data, auth, redirect }
 *  redirect=false：登录过期/被锁定时不跳页（用于上报等「即发即忘」接口，避免把用户从身份选择页弹走）
 */
function request(path, opts = {}) {
  const { method = 'GET', data = {}, auth = true, redirect = true } = opts;
  const requestId = genRequestId();
  const startAt = Date.now();
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path,
      method,
      data,
      header: {
        'X-WX-SERVICE': CLOUD_SERVICE,
        'X-LP-Token': auth ? getToken() : '',
        'X-Request-Id': requestId,
      },
      success: (res) => {
        reportClientCost(requestId, Date.now() - startAt);
        const body = (res && res.data) || {};
        if (body.code === 0) {
          resolve(body.data);
        } else if (body.code === 401 || body.code === 403) {
          // 401：登录/绑定状态失效 → 回身份页重新绑定（不展示锁定态）
          // 403：账号被后台锁定 → 回身份页展示锁定提示 + 联系管理员
          const isLocked = body.code === 403;
          wx.removeStorageSync('lp_token');
          wx.removeStorageSync('lp_staff');
          wx.removeStorageSync('lp_role');
          wx.removeStorageSync('lp_view_staff_id');
          wx.removeStorageSync('lp_active_staff_id');
          wx.removeStorageSync('lp_identities');
          // 一并清除上一账号的后台登录凭据与共享码，避免同设备换绑后残留
          wx.removeStorageSync('lp_backend');
          wx.removeStorageSync('lp_share_code');
          stopSessionGuard();
          // 冷却兜底：同一短窗口内多次 401/403 只跳一次，避免（尤其登录失败时）反复重建身份页造成 reload 死循环
          if (redirect && Date.now() - lastAuthRedirectAt > 3000) {
            lastAuthRedirectAt = Date.now();
            if (isLocked && body.msg) wx.setStorageSync('lp_lock_msg', body.msg);
            if (isLocked && body.lockInfo) wx.setStorageSync('lp_lock_info', body.lockInfo);
            wx.reLaunch({ url: '/pages/identity/identity' + (isLocked ? '?locked=1' : '') });
          }
          reject({ code: body.code, msg: body.msg || (isLocked ? '访问已锁定' : '登录已过期') });
        } else {
          reject({ code: body.code, msg: body.msg || '操作失败' });
        }
      },
      fail: (err) => {
        reportClientCost(requestId, Date.now() - startAt);
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
/** 登录响应落库存（token/staff/role/identities/activeStaffId），供各绑定/切换流程复用 */
export function persistLogin(res) {
  if (!res) return;
  if (res.token) wx.setStorageSync('lp_token', res.token);
  if (res.identities) setIdentities(res.identities);
  if (res.activeStaffId) setActiveStaffId(res.activeStaffId);
  if (res.staff) wx.setStorageSync('lp_staff', res.staff);
  if (res.role) wx.setStorageSync('lp_role', res.role || res.staff.role || 'student');
}

export const lpAuth = {
  /** 登录：wx.login 换小程序会话 token → { token, bound, locked?, role?, staff?, identities?, activeStaffId? }
   *  redirect=false：登录失败（含 code2session 401）不触发全局「清会话 + reLaunch 身份页」，
   *  避免在身份页/登录页 onShow 自登录时把自己反复重建（reload 死循环）；路由由各页面自行决定。 */
  login: async () => {
    const code = await wxLoginCode();
    const activeStaffId = getActiveStaffId();
    return request('/api/lp/login', {
      method: 'POST',
      data: { code, ...(activeStaffId ? { activeStaffId } : {}) },
      auth: false,
      redirect: false,
    });
  },
  /** 绑定邀请码：{ code, rebind }（openid 取自会话 token）→ { token, role, staff, identities, activeStaffId } */
  bind: async (code, rebind) => {
    // 确保已有会话 token（未登录时先登录拿 token）
    if (!getToken()) {
      try {
        const res = await lpAuth.login();
        if (res && res.token) wx.setStorageSync('lp_token', res.token);
      } catch (_) {}
    }
    return request('/api/lp/bind', { method: 'POST', data: { code, rebind: !!rebind }, redirect: false });
  },
  /** 家长注册：身份选择「我是家长」确认后自动建号/自动绑定/发共享码/下发后台账号
   *  data: { nickname?, rebind? }（rebind=true 表示换绑到主家长身份）
   *  → { token, bound, role, staff, share_code, backend, identities, activeStaffId } */
  registerParent: async (data = {}) => {
    if (!getToken()) {
      try {
        const res = await lpAuth.login();
        if (res && res.token) wx.setStorageSync('lp_token', res.token);
      } catch (_) {}
    }
    const opts = data && typeof data === 'object' ? data : { nickname: data };
    return request('/api/lp/registerParent', { method: 'POST', data: opts, redirect: false });
  },
  /** 切换身份（共用微信家长↔孩子↔家属）{ staffId, pin? } → { token, role, staff, identities, activeStaffId } */
  switch: (staffId, pin) => request('/api/lp/switch', {
    method: 'POST',
    data: { staffId: String(staffId), ...(pin ? { pin: String(pin) } : {}) },
    redirect: false,
  }),
  /** 身份 PIN 管理：set 设置/修改（4-6 位数字）/ verify 校验 / remove 关闭（需正确 PIN） */
  pin: (action, pin) => request('/api/lp/pin', {
    method: 'POST',
    data: { action, pin: String(pin || '') },
    redirect: false,
  }),
  /** 会话心跳：实时复核绑定状态（后台解除邀请码后立即收到 403 → 前端清登录态回绑定页） */
  sessionCheck: () => request('/api/lp/session'),
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

  /** 切换身份（共用微信家长↔孩子↔家属），需 PIN 时后端校验 */
  switchIdentity: (staffId, pin) => lpAuth.switch(staffId, pin),

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

  /** 语音打卡：录音 + 直传云存储 + 登记走 utils/voice.js（uploadVoice），打卡提交带 voiceUrl/voiceDuration */
};

// ==================== 数据上报 API ====================
// 上报为「即发即忘」：登录过期/未绑定被锁定时不跳页（redirect:false）
export const analytics = {
  /** 会话画像采集（user_sessions） */
  collectSession: (session) => request('/api/lp/collectSession', { method: 'POST', data: { session }, redirect: false }),
  /** 用户操作事件（user_events） */
  collectEvent: (payload) => request('/api/lp/collectEvent', { method: 'POST', data: payload, redirect: false }),
};

export { getToken, getRole, getViewStudent, setViewStudent, clearViewStudent, getActiveStaffId, setActiveStaffId, getIdentities, setIdentities };
