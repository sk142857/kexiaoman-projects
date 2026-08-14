// pages/identity/identity.js
// 登录后单页完成：选择身份 + 邀请码绑定（家长自动建号；学生/家属同页输入邀请码；换绑直接输码）
const { lpAuth, clearViewStudent, getToken } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    locked: false,
    lockedMsg: '',
    rebind: false,
    identity: '',        // student / family（选中后同页展开邀请码输入）
    showCodeBox: false,
    focusInput: false,
    code: '',
    loading: false,
    submitting: false,
    errorMsg: '',
    placeholder: '6 位大写邀请码',
  },

  onLoad(options) {
    if (options && options.locked === '1') {
      const msg = wx.getStorageSync('lp_lock_msg') || '';
      wx.removeStorageSync('lp_lock_msg');
      this.setData({ locked: true, lockedMsg: msg || '您的绑定已解除，请重新选择身份并输入邀请码' });
    }
    if (options && options.rebind === '1') {
      this.setData({ rebind: true, showCodeBox: true, focusInput: true });
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

  // 家长：确认后自动建号 + 自动绑定 + 发共享码 + 下发后台账号
  onParent() {
    if (this.data.submitting) return;
    wx.showModal({
      title: '确认成为主家长？',
      content: '将自动为您创建家庭与后台登录账号，并生成家属共享码。孩子档案可在【我的】中维护。',
      confirmText: '确认',
      cancelText: '再想想',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ submitting: true });
        wx.showLoading({ title: '正在创建账号...', mask: true });
        try {
          const res = await lpAuth.registerParent();
          this._onParentReady(res);
        } catch (e) {
          wx.hideLoading();
          this.setData({ submitting: false });
          wx.showToast({ title: e.msg || '注册失败，请重试', icon: 'none' });
        }
      },
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
    wx.reLaunch({ url: '/pages/backend-account/backend-account?first=1' });
  },

  // 学生/家属：同页展开邀请码输入（再次点击同一张卡收起）
  onPickIdentity(e) {
    const idt = e.currentTarget.dataset.identity === 'family' ? 'family' : 'student';
    const show = !(this.data.identity === idt && this.data.showCodeBox);
    this.setData({
      identity: idt,
      showCodeBox: show,
      focusInput: show,
      code: show ? this.data.code : '',
      errorMsg: '',
      placeholder: idt === 'family' ? '请输入主家长提供的家属共享码' : '请输入家长提供的学生邀请码',
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
        content: '将更换当前绑定的账号并进入该邀请码对应的账号，确定继续吗？',
        success: (r) => { if (r.confirm) doBind(); },
      });
    } else {
      doBind();
    }
  },

  // 绑定成功：落库存 → 进首页
  _onBound(res) {
    wx.setStorageSync('lp_token', res.token);
    if (res.staff) wx.setStorageSync('lp_staff', res.staff);
    wx.setStorageSync('lp_role', res.role || (res.staff && res.staff.role) || 'student');
    clearViewStudent();
    trackEvent('button_click', '绑定邀请码', { role: res.role || 'student' });
    wx.showToast({ title: '绑定成功', icon: 'success' });
    this._startGuard();
    setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 600);
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
