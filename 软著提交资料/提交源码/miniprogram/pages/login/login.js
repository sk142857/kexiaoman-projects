/**
 * 登录页面
 * 支持账号密码登录与注册切换。
 */
const api = require('../../utils/api');

Page({
  data: {
    mode: 'login',
    account: '',
    password: '',
    name: '',
    loading: false
  },

  onAccount(e) {
    this.setData({ account: e.detail.value });
  },

  onPassword(e) {
    this.setData({ password: e.detail.value });
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },

  switchMode() {
    this.setData({ mode: this.data.mode === 'login' ? 'register' : 'login' });
  },

  async onSubmit() {
    const { mode, account, password, name } = this.data;
    if (!account || !password) {
      wx.showToast({ title: '请填写账号和密码', icon: 'none' });
      return;
    }
    if (mode === 'register' && !name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const fn = mode === 'login' ? api.login : api.register;
      const data = await fn({ account, password, name });
      getApp().setSession(data.token, data);
      wx.switchTab({ url: '/pages/index/index' });
    } catch (e) {
      // 已在封装层提示
    } finally {
      this.setData({ loading: false });
    }
  }
});
