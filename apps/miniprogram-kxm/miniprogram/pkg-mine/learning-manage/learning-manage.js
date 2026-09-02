// pages/learning-manage/learning-manage.js
// 学习管理：合集管理 / 科目管理（主家长/个人维护，家庭共享）
const { lp } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    collectionCount: -1,
    subjectCount: -1,
  },

  async onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pkg-mine/learning-manage/learning-manage') return;
    trackEvent('page_view', '学习管理');
    this._load();
  },

  async _load() {
    try {
      const [colRes, subRes] = await Promise.all([lp.collections({ page: 1, pageSize: 1 }), lp.subjects()]);
      this.setData({
        collectionCount: Number((colRes && colRes.total) || (colRes && colRes.list && colRes.list.length) || 0),
        subjectCount: Number((subRes && subRes.list && subRes.list.length) || 0),
      });
    } catch (_) {
      this.setData({ collectionCount: -1, subjectCount: -1 });
    }
  },

  goCollections() {
    trackEvent('menu_click', '学习管理-合集管理');
    wx.navigateTo({ url: '/pkg-mine/collections/collections' });
  },

  goSubjects() {
    trackEvent('menu_click', '学习管理-科目管理');
    wx.navigateTo({ url: '/pkg-mine/subjects/subjects' });
  },
});
