/**
 * 我的页面
 * 展示个人信息、积分等级、徽章墙，并提供登出入口。
 */
const api = require('../../utils/api');

Page({
  data: {
    profile: null,
    level: 0,
    xp: 0,
    nextXp: 0,
    badges: []
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    try {
      const profile = await api.getProfile();
      const balance = await api.pointBalance();
      const badges = await api.myBadges();
      const next = (balance.level && balance.level.xp) || 0;
      this.setData({
        profile,
        level: balance.level ? balance.level.level : 1,
        xp: balance.xp || 0,
        nextXp: next,
        badges
      });
    } catch (e) {
      // 登录态失效时跳转登录
    }
  },

  onLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  onLogout() {
    wx.showModal({
      title: '提示',
      content: '确认退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          const app = getApp();
          app.clearSession();
          this.refresh();
        }
      }
    });
  },

  goBadges() {
    wx.navigateTo({ url: '/pages/badge/badge' });
  }
});
