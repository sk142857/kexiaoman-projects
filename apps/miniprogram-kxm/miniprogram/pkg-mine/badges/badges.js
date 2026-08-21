// pages/badges/badges.js
const { lp } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    level: null,
    streak: null,
    badges: [],
    unlockedCount: 0,
    totalCount: 0,
    nextBadge: null,
  },

  async onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    // 等待期间可能被 reLaunch 到身份页，页面已失效则直接返回
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pkg-mine/badges/badges') return;
    trackEvent('page_view', '我的奖章');
    this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const dash = await lp.dashboard();
      const badges = (dash.badges || []).map((b) => ({
        ...b,
        // 解锁时间截取到日期（WXML 不支持 slice）
        unlocked_date: b.unlocked_at ? String(b.unlocked_at).slice(0, 10) : '',
      }));
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
