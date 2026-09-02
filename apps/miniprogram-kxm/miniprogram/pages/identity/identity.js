// pages/identity/identity.js
// 绑定流程（步骤条 + 底部固定按钮）：选择身份 → 绑定账号 → 完成
// 身份：家长（自动建号）/ 个人（自动建号）/ 我有邀请码（孩子、家属、家长邀请码统一输入，按 kind 自动识别）
// 孩子与家属逻辑完全一致（都是输入邀请码），合并为一张「我有邀请码」卡片。
// 绑定文案由后端系统参数 identity_bind_copy（JSON）维护，前端读取失败时回退内置默认文案。
const { lpAuth, clearViewStudent, getToken, persistLogin, setActiveStaffId, setIdentities } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

// 内置默认绑定文案（后端未配置/读取失败时兜底；正常以后端 identity_bind_copy 为准）
const DEFAULT_COPY = {
  parent: { name: '我是家长', desc: '创建家庭档案，管理孩子任务与打卡' },
  personal: { name: '我是个人', desc: '创建个人账号，自己发布任务、自己打卡' },
  invite: { name: '我有邀请码', desc: '输入家长或管理员提供的邀请码，绑定孩子或家属身份' },
};

Page({
  data: {
    locked: false,
    lockedMsg: '',
    lockInfo: null,          // { reason, lockedAt, unlockAt } 账号锁定详情
    rebind: false,
    step: 0,               // 0 选择身份 / 1 绑定账号 / 2 完成
    identity: '',          // parent / personal / invite
    focusInput: false,
    code: '',
    loading: false,
    submitting: false,
    errorMsg: '',
    placeholder: '请输入邀请码',
    riskPrompt: false,   // 共用微信：绑定后形成多身份且家长未设 PIN → 提示开启 PIN
    copy: DEFAULT_COPY,  // 绑定文案（后端维护）
  },

  onLoad(options) {
    if (options && options.locked === '1') {
      const msg = wx.getStorageSync('lp_lock_msg') || '';
      const info = wx.getStorageSync('lp_lock_info') || null;
      wx.removeStorageSync('lp_lock_msg');
      wx.removeStorageSync('lp_lock_info');
      this.setData({
        locked: true,
        lockedMsg: msg || '您的账号已被管理员锁定，请联系管理员处理',
        lockInfo: info,
      });
    }
    if (options && options.rebind === '1') {
      // 重新绑定：绑定关系已在「设置→重新绑定」确认时立即解除，此处仅重新选择身份换绑
      this.setData({ rebind: true, step: 0 });
    }
    trackEvent('page_view', (options && options.rebind === '1') ? '重新绑定' : '身份选择');
    this._loadCopy();
  },

  // 加载绑定文案（后端系统参数维护；失败回退内置默认）
  async _loadCopy() {
    try {
      const { lp } = require('../../utils/api');
      const res = await lp.params('identity_bind_copy');
      const c = (res && res.identity_bind_copy) || null;
      if (c && typeof c === 'object') {
        this.setData({
          copy: {
            parent: c.parent || DEFAULT_COPY.parent,
            personal: c.personal || DEFAULT_COPY.personal,
            invite: c.invite || DEFAULT_COPY.invite,
          },
        });
      }
    } catch (_) { /* 读取失败用默认文案 */ }
  },

  onShow() {
    // 无会话 token（如中途 401 被清）时静默重新登录：已绑定则直接回首页。
    // 重新绑定（rebind=1）场景：已解除绑定，即使仍有其它身份，也停留本页重新选择身份，不自动回首页。
    if (!getToken() && !this._loginBusy) {
      this._loginBusy = true;
      lpAuth.login()
        .then((res) => {
          persistLogin(res);
          if (res.identities) setIdentities(res.identities);
          if (res.activeStaffId) setActiveStaffId(res.activeStaffId);
          if (res && res.cancel_pending) {
            // 注销流程中：只能停留在注销页撤销/等待，不允许回到业务系统
            wx.reLaunch({ url: '/pkg-mine/cancel-account/cancel-account' });
          } else if (!this.data.rebind && res && res.bound && res.staff) {
            wx.setStorageSync('lp_staff', res.staff);
            wx.setStorageSync('lp_role', res.role || res.staff.role || 'student');
            wx.reLaunch({ url: '/pages/home/home' });
          } else {
            // 未绑定（留在本页选身份）：登录拿到会话 token 后再加载后端维护的身份卡片文案
            this._loadCopy();
          }
        })
        .catch(() => {})
        .finally(() => { this._loginBusy = false; });
    }
  },

  // 选择身份：仅记录选中态，交由「下一步」进入绑定
  onPickIdentity(e) {
    const idt = e.currentTarget.dataset.identity;
    if (idt === this.data.identity) return;
    this.setData({
      identity: idt,
      code: '',
      errorMsg: '',
      focusInput: false,
    });
    this._syncCopy();
  },

  // 同步邀请码输入框占位文案（invite=输入任意邀请码，由后端按 kind 识别孩子/家属/家长）
  _syncCopy() {
    const identity = this.data.identity;
    let placeholder = '请输入邀请码';
    if (identity === 'invite') placeholder = '请输入邀请码';
    this.setData({ placeholder });
  },

  // 步骤一 → 步骤二
  onNext() {
    if (!this.data.identity) {
      this.setData({ errorMsg: '请先选择您的身份' });
      return;
    }
    this.setData({ step: 1, errorMsg: '' });
    this._syncFocus();
  },

  _syncFocus() {
    const needInput = this.data.identity === 'invite';
    this.setData({ focusInput: needInput });
  },

  // 步骤二 → 步骤一
  onPrev() {
    this.setData({ step: 0, focusInput: false, errorMsg: '' });
  },

  // 步骤二 主操作：家长/个人自动建号；我有邀请码走邀请码绑定（后端按 kind 识别孩子/家属/家长）
  onPrimary() {
    if (this.data.identity === 'parent') {
      this.onParent();
    } else if (this.data.identity === 'personal') {
      this.onPersonal();
    } else {
      this.onBind();
    }
  },

  // 家长：确认创建 = 自动建号 + 自动绑定 + 发共享码 + 下发后台账号
  onParent() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '正在创建账号...', mask: true });
    lpAuth.registerParent()
      .then((res) => this._onParentReady(res))
      .catch((e) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: e.msg || '注册失败，请重试', icon: 'none' });
      });
  },

  // 个人：确认创建 = 自动建号 + 自动绑定（最简单身份，无共享码/无后台账号）
  onPersonal() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '正在创建账号...', mask: true });
    lpAuth.registerPersonal()
      .then((res) => this._onBound(res))
      .catch((e) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: e.msg || '注册失败，请重试', icon: 'none' });
      });
  },

  // 家长注册成功：保存共享码与后台账号（密码点击查看），跳后台账号页展示
  _onParentReady(res) {
    persistLogin(res);
    if (res.identities) setIdentities(res.identities);
    if (res.activeStaffId) setActiveStaffId(res.activeStaffId);
    wx.removeStorageSync('lp_share_code');
    wx.setStorageSync('lp_share_code', res.share_code || '');
    wx.removeStorageSync('lp_backend');
    if (res.backend) wx.setStorageSync('lp_backend', res.backend);
    trackEvent('button_click', '选择身份-主家长');
    wx.hideLoading();
    this._startGuard();
    // 共用微信：注册家长后若已绑定孩子（多身份）且家长未设 PIN → 完成步提示风险
    const identities = res.identities || [];
    const hasParent = identities.some(it => it.role === 'parent');
    const parentNoPin = identities.some(it => it.role === 'parent' && !it.pin_enabled);
    this.setData({
      step: 2,
      submitting: false,
      riskPrompt: identities.length > 1 && hasParent && parentNoPin,
    });
  },

  onInput(e) {
    const v = String(e.detail.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    this.setData({ code: v, errorMsg: '' });
  },

  onBind() {
    const code = this.data.code;
    if (code.length !== 6) {
      this.setData({ errorMsg: '请输入 6 位邀请码' });
      return;
    }
    this.setData({ loading: true, errorMsg: '' });
    lpAuth.bind(code, false)
      .then((res) => this._onBound(res))
      .catch((e) => this._checkBoundThen(e))
      .finally(() => this.setData({ loading: false }));
  },

  // 绑定成功：落库存 → 进入完成步
  _onBound(res) {
    persistLogin(res);
    if (res.identities) setIdentities(res.identities);
    if (res.activeStaffId) setActiveStaffId(res.activeStaffId);
    clearViewStudent();
    // 个人注册走本流程（onPersonal 先 showLoading），必须先隐藏 loading，否则 toast 一直存在且 mask 拦截点击
    wx.hideLoading();
    // 换绑成功后旧账号的后台凭据与共享码不再有效，立即清除
    wx.removeStorageSync('lp_backend');
    wx.removeStorageSync('lp_share_code');
    trackEvent('button_click', '绑定身份', { role: res.role || '' });
    this._startGuard();
    // 共用微信：绑定后形成多身份（含家长）且家长未设 PIN → 完成步提示风险
    const identities = res.identities || [];
    const hasParent = identities.some(it => it.role === 'parent');
    const parentNoPin = identities.some(it => it.role === 'parent' && !it.pin_enabled);
    this.setData({
      step: 2,
      loading: false,
      submitting: false,
      riskPrompt: identities.length > 1 && hasParent && parentNoPin,
    });
  },

  // 完成步：统一进入首页
  onFinish() {
    wx.reLaunch({ url: '/pages/home/home' });
  },

  // 绑定成功后启动全局会话心跳（后台解除邀请码时前端即时被踢出）
  _startGuard() {
    try {
      const app = getApp();
      if (app && typeof app.startSessionGuard === 'function') app.startSessionGuard();
    } catch (_) {}
  },

  // 绑定失败兜底：若实际已绑定（服务端成功但响应丢失），仍进入首页
  _checkBoundThen(e) {
    lpAuth.login()
      .then((res) => {
        if (res && res.bound && res.staff && res.token) {
          this._onBound(res);
        } else {
          this.setData({ errorMsg: e.msg || '绑定失败，请重试' });
        }
      })
      .catch(() => this.setData({ errorMsg: e.msg || '绑定失败，请重试' }));
  },

  goHome() {
    wx.reLaunch({ url: '/pages/home/home' });
  },

  // 风险提示 → 去设置页开启身份 PIN 保护
  goPin() {
    trackEvent('button_click', '绑定完成-开启PIN');
    wx.navigateTo({ url: '/pkg-mine/settings/settings' });
  },
});
