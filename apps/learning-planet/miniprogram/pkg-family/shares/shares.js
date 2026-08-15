// pages/shares/shares.js
// 家属共享管理（主家长）：生成/作废共享码，查看已绑定家属
const { family } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    loading: true,
    list: [],
    availableCode: '',
  },

  onShow() {
    trackEvent('page_view', '家属共享');
    this._load();
  },

  async _load() {
    try {
      const res = await family.shares();
      const list = (res.list || []).map(r => ({
        ...r,
        statusText: r.status === 'available' ? '待绑定' : r.status === 'bound' ? '已绑定' : '已作废',
      }));
      const available = (res.list || []).find(r => r.status === 'available') || null;
      this.setData({ list, availableCode: available ? available.invite_code : '', loading: false });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // 生成共享码（单次使用）
  onGenerate() {
    wx.showModal({
      title: '生成家属共享码',
      content: '将生成一个仅能绑定一位家属的共享码，发给家属后其输入该码即可加入查看。',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await family.shareGenerate();
          trackEvent('button_click', '家属共享-生成码');
          wx.setClipboardData({
            data: res.invite_code,
            success: () => wx.showToast({ title: `已生成并复制：${res.invite_code}`, icon: 'none' }),
          });
          this._load();
        } catch (e) {
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },

  onCopy(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
  },

  onRevoke(e) {
    const inviteId = e.currentTarget.dataset.id;
    const bound = e.currentTarget.dataset.bound;
    const content = bound
      ? '作废后对应家属将立即失去查看权限，需重新绑定新码。确定作废？'
      : '作废后该码不可再用。确定作废？';
    wx.showModal({
      title: '作废共享码',
      content,
      confirmColor: '#ff4d4f',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await family.shareRevoke(inviteId);
          trackEvent('button_click', '家属共享-作废码', { inviteId });
          wx.showToast({ title: '已作废', icon: 'success' });
          this._load();
        } catch (e) {
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
