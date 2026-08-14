// pages/badges/badges.js
const { lp } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    level: null,
    streak: null,
    badges: [],
    unlockedCount: 0,
    totalCount: 0,
    nextBadge: null,
  },

  async onLoad() {
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    trackEvent('page_view', '我的奖章');
    this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const dash = await lp.dashboard();
      const badges = dash.badges || [];
      this.setData({
        level: dash.level || null,
        streak: dash.streak || null,
        badges,
        unlockedCount: badges.filter((b) => b.unlocked).length,
        totalCount: badges.length,
        nextBadge: badges.find((b) => !b.unlocked) || null,
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      return;
    }
    wx.hideLoading();
  },
});
