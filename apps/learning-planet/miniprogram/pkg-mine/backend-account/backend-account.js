// pages/backend-account/backend-account.js
// 主家长后台登录账号：展示账号、密码点击查看（明文仅首次/重置时下发）、重置密码
const { family } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    first: false,
    username: '',
    password: '',
    showPassword: false,
    hasPassword: false,
    loading: false,
  },

  onLoad(options) {
    const first = options && options.first === '1';
    this.setData({ first });
    // 从注册流程带过来的明文密码（仅注册/重置后存在，正常打开为空）
    let backend = {};
    try { backend = wx.getStorageSync('lp_backend') || {}; } catch (_) {}
    this.setData({
      username: backend.username || '',
      password: backend.password || '',
      hasPassword: !!backend.password,
    });
    trackEvent('page_view', '后台账号');
  },

  togglePassword() {
    if (!this.data.showPassword && !this.data.password) {
      wx.showToast({ title: '密码仅注册或重置时展示一次', icon: 'none' });
      return;
    }
    this.setData({ showPassword: !this.data.showPassword });
  },

  onReset() {
    wx.showModal({
      title: '重置后台密码',
      content: '将生成新的后台登录密码（仅展示一次），原密码立即失效。确定重置？',
      confirmColor: '#ff4d4f',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ loading: true });
        try {
          const res = await family.passwordReset();
          trackEvent('button_click', '后台账号-重置密码');
          wx.setStorageSync('lp_backend', { ...this._backend(), password: res.password });
          this.setData({ password: res.password, showPassword: true, hasPassword: true, loading: false });
          wx.showToast({ title: '已重置，请妥善保存', icon: 'none' });
        } catch (e) {
          this.setData({ loading: false });
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },

  _backend() {
    try { return wx.getStorageSync('lp_backend') || {}; } catch (_) { return {}; }
  },

  onCopyUsername() {
    if (!this.data.username) return;
    wx.setClipboardData({
      data: this.data.username,
      success: () => wx.showToast({ title: '已复制账号', icon: 'none' }),
    });
  },

  onCopyPassword() {
    if (!this.data.password) return;
    wx.setClipboardData({
      data: this.data.password,
      success: () => wx.showToast({ title: '已复制密码', icon: 'none' }),
    });
  },
});
