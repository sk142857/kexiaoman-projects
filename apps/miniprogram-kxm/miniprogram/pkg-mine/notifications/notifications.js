// pages/notifications/notifications.js
// 系统通知（站内信，与「订阅消息」完全隔离）：列表查询时后端即静默标记当前页已读，支持全部已读
const { lp } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const PAGE_SIZE = 20;

// 通知类型 → 标签文案/配色（任务模块风格：类型标签 + 左边框色）
const NOTIFY_TYPE = {
  checkin_approved: { text: '审核通过', color: '#16a87a', bg: '#e6faf4' },
  checkin_rejected: { text: '审核不通过', color: '#f6685d', bg: '#fdeeed' },
  content_violation: { text: '内容违规', color: '#f6685d', bg: '#fdeeed' },
  checkin_submitted: { text: '待审核', color: '#e37318', bg: '#fdf1e4' },
  task_assigned: { text: '新任务', color: '#2b6de0', bg: '#eef4ff' },
  task_done: { text: '任务完成', color: '#16a87a', bg: '#e6faf4' },
};

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    list: [],
    unread: 0,
    loading: false,
    page: 1,
    hasMore: true,
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
    if (!pages.length || pages[pages.length - 1].route !== 'pkg-mine/notifications/notifications') return;
    trackEvent('page_view', '系统通知');
    this.setData({ page: 1, hasMore: true });
    this._load(true);
  },

  async _load(reset) {
    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true });
    try {
      const res = await lp.notifications({ page, pageSize: PAGE_SIZE });
      const list = (res.list || []).map((n) => {
        const t = NOTIFY_TYPE[n.type] || {};
        return {
          ...n,
          timeText: n.created_at ? String(n.created_at).slice(5, 16).replace('T', ' ') : '',
          typeText: t.text || '',
          typeColor: t.color || '',
          typeBg: t.bg || '',
          // 左边框色与业务场景一致（审核通过/驳回/违规/新任务等），与已读未读无关
          barColor: t.color || '#8a919f',
        };
      });
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        unread: Number(res.unread) || 0,
        page: page + 1,
        hasMore: list.length >= PAGE_SIZE,
      });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this._load(false);
  },

  // 全部已读
  onReadAll() {
    if (this.data.unread <= 0) return;
    wx.showModal({
      title: '全部已读',
      content: `将 ${this.data.unread} 条未读通知全部标记为已读？`,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await lp.notificationsRead({ all: true });
        } catch (_) {}
        this.setData({
          list: this.data.list.map((n) => ({ ...n, is_read: 1, read_at: '' })),
          unread: 0,
        });
      },
    });
  },
});
