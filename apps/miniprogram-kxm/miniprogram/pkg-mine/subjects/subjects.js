// pages/subjects/subjects.js
// 科目管理：列表 / 新建（预置科目可选创建 + 自定义）/ 编辑 / 删除（按 staff_id 归属，主家长/个人管理）
const { lp, getRole } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const COLORS = ['', '#1677ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2'];
const CAN_MANAGE_ROLES = ['admin', 'parent', 'family', 'personal'];

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    list: [],
    presets: [],
    loading: false,
    canManage: false,   // 主家长/家属/管理员/个人 可管理科目（学生仅查看使用）
    showModal: false,
    editingId: '',
    name: '',
    selectedPreset: '',
    selectedColor: '',
    colors: COLORS,
    submitting: false,
  },

  async onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pkg-mine/subjects/subjects') return;
    trackEvent('page_view', '科目管理');
    this.setData({ canManage: CAN_MANAGE_ROLES.includes(getRole()) });
    this._load();
    this._loadPresets();
  },

  async _load() {
    this.setData({ loading: true });
    try {
      const res = await lp.subjects();
      this.setData({ list: (res && res.list) || [] });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  async _loadPresets() {
    try {
      const res = await lp.subjectPresets();
      this.setData({ presets: (res && res.list) || [] });
    } catch (_) {
      this.setData({ presets: [] });
    }
  },

  openCreate() {
    this.setData({ showModal: true, editingId: '', name: '', selectedPreset: '', selectedColor: '' });
  },

  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.list[index] || {};
    this.setData({
      showModal: true,
      editingId: String(id),
      name: item.name || '',
      selectedPreset: '',
      selectedColor: item.color || '',
    });
  },

  closeModal() { this.setData({ showModal: false }); },
  noop() {},
  onName(e) { this.setData({ name: e.detail.value }); },
  onPickPreset(e) {
    const n = e.currentTarget.dataset.name;
    this.setData({ name: n, selectedPreset: n });
  },
  onPickColor(e) { this.setData({ selectedColor: e.currentTarget.dataset.color }); },

  submit() {
    if (this.data.submitting) return;
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '请输入科目名称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const payload = { name, color: this.data.selectedColor || '' };
    const req = this.data.editingId
      ? lp.subjectUpdate({ id: this.data.editingId, ...payload })
      : lp.subjectCreate(payload);
    req
      .then(() => {
        trackEvent('button_click', this.data.editingId ? '编辑科目' : '创建科目');
        wx.showToast({ title: '已保存', icon: 'success' });
        this.setData({ showModal: false });
        this._load();
      })
      .catch((e) => wx.showToast({ title: e.msg || '保存失败', icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '该科目';
    wx.showModal({
      title: '删除科目？',
      content: `删除「${name}」后，任务将不再展示该科目标签（历史任务不受影响）。`,
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (!r.confirm) return;
        lp.subjectDelete(id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' });
            this._load();
          })
          .catch((e2) => wx.showToast({ title: e2.msg || '删除失败', icon: 'none' }));
      },
    });
  },
});
