// pages/collections/collections.js
const { lp, getRole } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const PAGE_SIZE = 20;
const CAN_MANAGE_ROLES = ['admin', 'parent', 'family', 'personal'];

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    list: [],
    showCreate: false,
    name: '',
    description: '',
    submitting: false,
    canManage: false,   // 主家长/家属/管理员/个人 可管理合集（学生仅查看）
    page: 1,
    hasMore: true,
    loadingMore: false,
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
    if (!pages.length || pages[pages.length - 1].route !== 'pkg-mine/collections/collections') return;
    trackEvent('page_view', '合集管理');
    this.setData({ canManage: CAN_MANAGE_ROLES.includes(getRole()) });
    this._load();
  },

  async _load(silent, append) {
    if (!silent) wx.showLoading({ title: '加载中', mask: true });
    try {
      const page = append ? this.data.page : 1;
      const res = await lp.collections({ page, pageSize: PAGE_SIZE });
      const list = (Array.isArray(res) ? res : (res && res.list) || []);
      this.setData({
        list: append ? this.data.list.concat(list) : list,
        page: page + 1,
        hasMore: !!res.hasMore,
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

  onLoadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    this._load(true, true);
  },

  openCreate() { this.setData({ showCreate: true, name: '', description: '' }); },
  closeCreate() { this.setData({ showCreate: false }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },

  submitCreate() {
    if (this.data.submitting) return;
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '请输入合集名称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    lp.collectionCreate({ name, description: this.data.description })
      .then(() => {
        trackEvent('button_click', '创建合集');
        wx.showToast({ title: '创建成功', icon: 'success' });
        this.setData({ showCreate: false });
        this._load();
      })
      .catch((e) => wx.showToast({ title: e.msg, icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除合集？',
      content: '合集下的任务将解除归属（任务保留）',
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (!r.confirm) return;
        trackEvent('button_click', '删除合集');
        lp.collectionDelete(id)
          .then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this._load(); })
          .catch((e2) => wx.showToast({ title: e2.msg, icon: 'none' }));
      },
    });
  },
});
