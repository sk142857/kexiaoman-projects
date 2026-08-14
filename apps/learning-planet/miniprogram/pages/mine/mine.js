// pages/mine/mine.js
const { lp, getRole } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const ROLE_TEXT = { admin: '管理员', parent: '主家长', family: '家属', student: '学生' };

Page({
  data: {
    nickname: '',
    avatarChar: '学',
    username: '',
    staffId: '',
    appId: 'learning-planet',
    role: 'student',
    roleText: '学生',
    isAdmin: false,
    isParent: false,    // 主家长（可维护孩子档案/共享）
    isManager: false,   // 家长/家属/管理员（可审核）
    editing: false,
    saving: false,
    stats: { totalTasks: 0, totalCheckins: 0 },
    level: null,
    streak: { current: 0 },
  },

  async onShow() {
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pages/mine/mine') return;

    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().sync('/pages/mine/mine');
    }
    trackEvent('page_view', '我的');
    const role = getRole();
    this.setData({
      role,
      roleText: ROLE_TEXT[role] || '学生',
      isAdmin: role === 'admin',
      isParent: role === 'parent' || role === 'admin',
      isManager: ['admin', 'parent', 'family'].includes(role),
    });
    this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      let staff = {};
      try { staff = wx.getStorageSync('lp_staff') || {}; } catch (_) {}
      const [profile, dash] = await Promise.all([lp.profile(), lp.dashboard()]);
      const s = (profile && profile.staff) || {};
      const nickname = s.nickname || staff.nickname || '同学';
      this.setData({
        nickname,
        avatarChar: String(nickname).charAt(0) || '学',
        username: s.username || staff.username || '',
        staffId: String(s.staff_id || staff.staff_id || ''),
        appId: (profile && profile.app) || 'learning-planet',
        stats: (dash && dash.stats) || { totalTasks: 0, totalCheckins: 0 },
        level: (dash && dash.level) || null,
        streak: (dash && dash.streak) || { current: 0 },
      });
      wx.setStorageSync('lp_staff', s);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      return;
    }
    wx.hideLoading();
  },

  startEdit() { this.setData({ editing: true }); },
  onNick(e) { this.setData({ nickname: e.detail.value }); },
  saveNick() {
    const n = this.data.nickname.trim();
    if (!n) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    lp.updateProfile({ nickname: n })
      .then(() => {
        const s = wx.getStorageSync('lp_staff') || {};
        wx.setStorageSync('lp_staff', { ...s, nickname: n });
        this.setData({ editing: false });
        wx.showToast({ title: '已更新', icon: 'success' });
      })
      .catch((e) => wx.showToast({ title: e.msg, icon: 'none' }))
      .finally(() => this.setData({ saving: false }));
  },
  cancelEdit() {
    this._load();
    this.setData({ editing: false });
  },

  goBadges() {
    trackEvent('menu_click', '点击我的奖章');
    wx.navigateTo({ url: '/pages/badges/badges' });
  },
  goSubscribe() {
    trackEvent('menu_click', '点击订阅消息');
    wx.navigateTo({ url: '/pages/subscribe/subscribe' });
  },

  // 孩子档案（仅主家长）
  goChildren() {
    trackEvent('menu_click', '点击孩子档案');
    wx.navigateTo({ url: '/pages/children/children' });
  },

  // 家属共享（仅主家长）
  goShares() {
    trackEvent('menu_click', '点击家属共享');
    wx.navigateTo({ url: '/pages/shares/shares' });
  },

  // 后台登录账号（仅主家长）
  goBackendAccount() {
    trackEvent('menu_click', '点击后台账号');
    wx.navigateTo({ url: '/pages/backend-account/backend-account' });
  },

  onRebind() {
    wx.showModal({
      title: '解除绑定',
      content: '将进入绑定界面，使用新邀请码可更换当前绑定的账号',
      success: (r) => {
        if (!r.confirm) return;
        trackEvent('menu_click', '点击解除绑定');
        wx.navigateTo({ url: '/pages/identity/identity?rebind=1' });
      },
    });
  },
});
