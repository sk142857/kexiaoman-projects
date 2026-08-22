// pages/tasks/tasks.js
const { lp, getViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');
const { secBadgeMeta } = require('../../utils/display');
const { ensureDict, statusMeta } = require('../../utils/dict');

const STATUS_TABS = [
  { value: '', label: '全部' },
  { value: 'todo', label: '待完成' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

const STATUS_PROGRESS = { todo: 1, doing: 50, done: 100 };
// 发布来源：web（Web后台）/ miniprogram（小程序）
const SOURCE_TEXT = { web: 'Web后台', miniprogram: '小程序' };
const PAGE_SIZE = 20;

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    tabs: STATUS_TABS,
    active: 0,
    list: [],
    refreshing: false,
    page: 1,
    hasMore: true,
    loadingMore: false,
  },

  async onShow() {
    // 每次展示页面滚动区复位到顶部（新打开的页面不受上一页面滚动位置影响）
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
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
    this.setData({ active: Number(e.currentTarget.dataset.index), page: 1, hasMore: true, loadingMore: false });
    this._load();
  },

  // 任务行展示层派生（状态/进度/角标/来源），列表与滚动加载复用
  _decorate(t) {
    const meta = statusMeta('task_status', t.task_status);
    const secMeta = secBadgeMeta(t);
    return {
      ...t,
      // 内容安全角标（安全关闭/失败时无 display 字段 → 空，走旧逻辑）
      secBadge: secMeta ? secMeta.text : '',
      secTagTheme: secMeta ? secMeta.tagTheme : '',
      // 进度为独立字段（后端维护），缺失时按状态兜底（待完成默认 1%）
      progress: t.progress >= 0 ? Number(t.progress) : (STATUS_PROGRESS[t.task_status] || 1),
      statusText: meta.label,
      statusColor: meta.color,
      statusStyle: meta.style,
      scoreColor: t.score >= 8 ? '#16a87a' : t.score >= 5 ? '#67c23a' : '#b0b6c0',
      sourceText: SOURCE_TEXT[t.source] || (t.source === 'web' ? 'Web后台' : '小程序'),
    };
  },

  async _load(silent, append) {
    if (!silent) wx.showLoading({ title: '加载中', mask: true });
    try {
      await ensureDict().catch(() => {});
      const tab = STATUS_TABS[this.data.active];
      const page = append ? this.data.page : 1;
      const { list, hasMore } = await lp.tasks({ status: tab.value, page, pageSize: PAGE_SIZE }, getViewStudent());
      const rows = (list || []).map(t => this._decorate(t));
      this.setData({
        list: append ? this.data.list.concat(rows) : rows,
        page: page + 1,
        hasMore: !!hasMore,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loadingMore: false });
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

  onLoadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    this._load(true, true);
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    trackEvent('menu_click', '任务列表-打开详情', { taskId: id });
    wx.navigateTo({ url: `/pkg-task/task-detail/task-detail?id=${id}` });
  },

  goCreate() {
    trackEvent('menu_click', '任务列表-新建任务');
    wx.navigateTo({ url: '/pkg-task/task-edit/task-edit' });
  },
});
