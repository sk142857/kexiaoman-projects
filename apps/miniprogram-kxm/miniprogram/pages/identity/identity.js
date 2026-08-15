// pages/identity/identity.js
// 绑定流程（步骤条 + 底部固定按钮）：选择身份 → 绑定账号 → 完成
const { lpAuth, clearViewStudent, getToken } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    locked: false,
    lockedMsg: '',
    lockInfo: null,          // { reason, lockedAt, unlockAt } 账号锁定详情
    rebind: false,
    step: 0,               // 0 选择身份 / 1 绑定账号 / 2 完成
    identity: '',          // parent / student / family
    parentMode: 'create',  // 家长：create 自动创建新账号 / bind 输入邀请码绑定后台已有账号
    focusInput: false,
    code: '',
    loading: false,
    submitting: false,
    errorMsg: '',
    placeholder: '请输入邀请码',
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
      // 重新绑定 = 走完整绑定流程：第一步重新选择身份，再输入新邀请码/创建账号换绑
      this.setData({ rebind: true, step: 0 });
    }
    trackEvent('page_view', (options && options.rebind === '1') ? '重新绑定' : '身份选择');
  },

  onShow() {
    // 无会话 token（如中途 401 被清）时静默重新登录：已绑定则直接回首页
    if (!getToken()) {
      lpAuth.login()
        .then((res) => {
          if (res && res.token) wx.setStorageSync('lp_token', res.token);
          if (res && res.bound && res.staff) {
            wx.setStorageSync('lp_staff', res.staff);
            wx.setStorageSync('lp_role', res.role || res.staff.role || 'student');
            wx.reLaunch({ url: '/pages/home/home' });
          }
        })
        .catch(() => {});
    }
  },

  // 选择身份：仅记录选中态，交由「下一步」进入绑定
  onPickIdentity(e) {
    const idt = e.currentTarget.dataset.identity;
    if (idt === this.data.identity) return;
    this.setData({
      identity: idt,
      parentMode: idt === 'parent' ? 'create' : 'bind',
      code: '',
      errorMsg: '',
      focusInput: false,
    });
    this._syncCopy();
  },

  // 同步邀请码输入框占位文案（按身份/家长模式区分）
  _syncCopy() {
    const { identity, parentMode } = this.data;
    let placeholder = '请输入邀请码';
    if (identity === 'student') placeholder = '请输入学生邀请码';
    else if (identity === 'family') placeholder = '请输入家属共享码';
    else if (identity === 'parent' && parentMode === 'bind') placeholder = '请输入家长邀请码';
    this.setData({ placeholder });
  },

  // 家长：创建新账号 与 输入邀请码绑定已有账号 两种模式切换
  onPickParentMode(e) {
    const m = e.currentTarget.dataset.mode;
    if (m === this.data.parentMode) return;
    this.setData({ parentMode: m, code: '', errorMsg: '', focusInput: m === 'bind' });
    this._syncCopy();
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
    const needInput = this.data.identity !== 'parent' || this.data.parentMode === 'bind';
    this.setData({ focusInput: needInput });
  },

  // 步骤二 → 步骤一
  onPrev() {
    this.setData({ step: 0, focusInput: false, errorMsg: '' });
  },

  // 步骤二 主操作：家长自动创建 / 其余（含家长绑定已有账号）走邀请码绑定
  onPrimary() {
    if (this.data.identity === 'parent' && this.data.parentMode === 'create') {
      this.onParent();
    } else {
      this.onBind();
    }
  },

  // 家长：确认创建 = 自动建号 + 自动绑定 + 发共享码 + 下发后台账号
  onParent() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '正在创建账号...', mask: true });
    lpAuth.registerParent({ rebind: this.data.rebind })
      .then((res) => this._onParentReady(res))
      .catch((e) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: e.msg || '注册失败，请重试', icon: 'none' });
      });
  },

  // 家长注册成功：保存共享码与后台账号（密码点击查看），跳后台账号页展示
  _onParentReady(res) {
    wx.setStorageSync('lp_token', res.token);
    if (res.staff) wx.setStorageSync('lp_staff', res.staff);
    wx.setStorageSync('lp_role', 'parent');
    wx.setStorageSync('lp_share_code', res.share_code || '');
    if (res.backend) wx.setStorageSync('lp_backend', res.backend);
    trackEvent('button_click', '选择身份-主家长');
    wx.hideLoading();
    this._startGuard();
    this.setData({ step: 2, submitting: false });
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
    const doBind = () => {
      this.setData({ loading: true, errorMsg: '' });
      lpAuth.bind(code, this.data.rebind)
        .then((res) => this._onBound(res))
        .catch((e) => this._checkBoundThen(e))
        .finally(() => this.setData({ loading: false }));
    };
    if (this.data.rebind) {
      wx.showModal({
        title: '确认重新绑定',
        content: '将解除当前绑定，并重新绑定到所选身份对应的账号，确定继续吗？',
        success: (r) => { if (r.confirm) doBind(); },
      });
    } else {
      doBind();
    }
  },

  // 绑定成功：落库存 → 进入完成步
  _onBound(res) {
    wx.setStorageSync('lp_token', res.token);
    if (res.staff) wx.setStorageSync('lp_staff', res.staff);
    wx.setStorageSync('lp_role', res.role || (res.staff && res.staff.role) || 'student');
    clearViewStudent();
    trackEvent('button_click', '绑定邀请码', { role: res.role || 'student' });
    this._startGuard();
    this.setData({ step: 2, loading: false });
  },

  // 完成步：家长去创建孩子档案（后台账号可在「我的→设置」随时查看），其余进首页
  onFinish() {
    if (this.data.identity === 'parent') {
      wx.reLaunch({ url: '/pkg-family/children/children' });
    } else {
      wx.reLaunch({ url: '/pages/home/home' });
    }
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

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
  },
});
