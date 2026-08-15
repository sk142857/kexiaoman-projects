// pages/tasks/tasks.js
const { lp, getViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const STATUS_TABS = [
  { value: '', label: '全部' },
  { value: 'todo', label: '未开始' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

const STATUS_THEME = {
  todo: { text: '未开始', color: '#f6685d', bg: '#fdeeed', border: '#fbc6c1' },
  doing: { text: '进行中', color: '#e37318', bg: '#fdf1e4', border: '#f6cda8' },
  done: { text: '已完成', color: '#16a87a', bg: '#e6faf4', border: '#b3eedd' },
};
const STATUS_PROGRESS = { todo: 0, doing: 50, done: 100 };

Page({
  data: {
    tabs: STATUS_TABS,
    active: 0,
    list: [],
    refreshing: false,
  },

  async onShow() {
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pages/tasks/tasks') return;

    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().sync('/pages/tasks/tasks');
    }
    trackEvent('page_view', '任务列表');
    this._load();
  },

  onTab(e) {
    this.setData({ active: Number(e.currentTarget.dataset.index) });
    this._load();
  },

  async _load(silent) {
    if (!silent) wx.showLoading({ title: '加载中', mask: true });
    try {
      const tab = STATUS_TABS[this.data.active];
      const { list } = await lp.tasks({ status: tab.value }, getViewStudent());
      this.setData({
        list: (list || []).map(t => {
          const theme = STATUS_THEME[t.task_status] || STATUS_THEME.todo;
          return {
            ...t,
            progress: STATUS_PROGRESS[t.task_status] || 0,
            statusText: theme.text,
            statusColor: theme.color,
            statusBg: theme.bg,
            statusBorder: theme.border,
            scoreColor: t.score >= 8 ? '#16a87a' : t.score >= 5 ? '#67c23a' : '#b0b6c0',
          };
        }),
      });
    } catch (e) {
      if (!silent) {
        wx.hideLoading();
        wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
        return;
      }
    }
    if (!silent) wx.hideLoading();
  },

  onRefresh() {
    this._load(true).finally(() => this.setData({ refreshing: false }));
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pkg-task/task-detail/task-detail?id=${id}` });
  },

  goCreate() {
    wx.navigateTo({ url: '/pkg-task/task-edit/task-edit' });
  },
});
