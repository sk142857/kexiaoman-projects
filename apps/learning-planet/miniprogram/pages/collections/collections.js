// pages/collections/collections.js
const { lp, getRole } = require('../../utils/api');

Page({
  data: {
    list: [],
    showCreate: false,
    name: '',
    description: '',
    submitting: false,
    isAdmin: false,
  },

  async onShow() {
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    this.setData({ isAdmin: getRole() === 'admin' });
    this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await lp.collections();
      const list = Array.isArray(res) ? res : (res && res.list) || [];
      this.setData({ list });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      return;
    }
    wx.hideLoading();
  },

  openCreate() { this.setData({ showCreate: true, name: '', description: '' }); },
  closeCreate() { this.setData({ showCreate: false }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },

  submitCreate() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '请输入合集名称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    lp.collectionCreate({ name, description: this.data.description })
      .then(() => {
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
        lp.collectionDelete(id)
          .then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this._load(); })
          .catch((e2) => wx.showToast({ title: e2.msg, icon: 'none' }));
      },
    });
  },
});
