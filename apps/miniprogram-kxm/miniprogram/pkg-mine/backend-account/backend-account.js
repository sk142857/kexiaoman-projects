// pages/backend-account/backend-account.js
// 主家长后台登录账号：展示账号、密码点击查看（明文仅首次/重置时下发）、重置密码
const { family } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    username: '',
    password: '',
    showPassword: false,
    hasPassword: false,
    loading: false,
  },

  onLoad(options) {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    // 后台凭据处理：本地仅缓存公开登录账号 username；明文密码不落盘（审计 A2）。
    // 历史版本曾把 password 写入 lp_backend，此处读取即作一次性收敛清理，仅保留 username 供展示。
    let backend = {};
    try { backend = wx.getStorageSync('lp_backend') || {}; } catch (_) {}
    if (backend.password) {
      try { wx.setStorageSync('lp_backend', { username: backend.username || '' }); } catch (_) {}
      backend.password = '';
    }
    this.setData({
      username: backend.username || '',
      password: '',
      showPassword: false,
      hasPassword: false,
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
    if (this.data.loading) return;
    wx.showModal({
      title: '重置后台密码',
      content: '将生成新的后台登录密码（仅展示一次），原密码立即失效。确定重置？',
      confirmColor: '#ff4d4f',
      success: async (r) => {
        if (!r.confirm) return;
        if (this.data.loading) return;
        this.setData({ loading: true });
        try {
          const res = await family.passwordReset();
          trackEvent('button_click', '后台账号-重置密码');
          // 新密码仅在本页内存展示一次，不写入 storage（审计 A2：避免明文密码长期落盘/跨身份残留）
          this.setData({ password: res.password, showPassword: true, hasPassword: true, loading: false });
          wx.showToast({ title: '已重置，请妥善保存', icon: 'none' });
        } catch (e) {
          this.setData({ loading: false });
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
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
