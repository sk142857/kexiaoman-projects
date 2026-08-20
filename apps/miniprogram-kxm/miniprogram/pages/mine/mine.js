// pages/mine/mine.js
const { lp, getRole, getIdentities, setIdentities, getActiveStaffId } = require('../../utils/api');
const { fileUrl } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');

// 角色代码不变（student），界面统一展示为「孩子」
const ROLE_TEXT = { admin: '管理员', parent: '主家长', family: '家属', student: '孩子' };

Page({
  data: {
    nickname: '',
    avatarChar: '学',
    avatarUrl: '',
    username: '',
    staffId: '',
    userId: '',
    appId: 'miniprogram-kxm',
    role: 'student',
    roleText: '孩子',
    isAdmin: false,
    isParent: false,    // 主家长（可维护孩子档案/共享）
    isManager: false,   // 家长/家属/管理员（可审核）
    stats: { totalTasks: 0, totalCheckins: 0 },
    level: null,
    streak: { current: 0 },
    identities: [],       // 共用微信多身份（家长 + 孩子 + 家属）
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
      roleText: ROLE_TEXT[role] || '孩子',
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
      // 多身份：从 profile 刷新 identities（含 pin_enabled 状态）
      let identities = (profile && profile.identities) || getIdentities();
      if (Array.isArray(identities) && identities.length > 0) {
        identities = identities.map(it => ({
          ...it,
          isCurrent: String(it.staff_id) === String(getActiveStaffId() || this.data.staffId),
        }));
        setIdentities(identities);
      }
      const activeId = getActiveStaffId();
      this.setData({
        nickname,
        avatarChar: String(nickname).charAt(0) || '学',
        avatarUrl: fileUrl(s.avatar || ''),
        username: s.username || staff.username || '',
        staffId: String(s.staff_id || staff.staff_id || activeId || ''),
        userId: String(profile.userId || ''),
        appId: (profile && profile.app) || 'miniprogram-kxm',
        stats: (dash && dash.stats) || { totalTasks: 0, totalCheckins: 0 },
        level: (dash && dash.level) || null,
        streak: (dash && dash.streak) || { current: 0 },
        identities,
      });
      wx.setStorageSync('lp_staff', s);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      return;
    }
    wx.hideLoading();
  },

  // 去身份切换页（独立一级菜单：切换子菜单 + 提示文案）
  goIdentitySwitch() {
    trackEvent('menu_click', '点击身份切换');
    wx.navigateTo({ url: '/pages/identity-switch/identity-switch' });
  },

  // 编辑个人资料（头像 / 昵称）
  goProfileEdit() {
    trackEvent('menu_click', '点击编辑资料');
    wx.navigateTo({ url: '/pkg-mine/profile-edit/profile-edit' });
  },

  goBadges() {
    trackEvent('menu_click', '点击我的奖章');
    wx.navigateTo({ url: '/pkg-mine/badges/badges' });
  },

  // 孩子档案（仅主家长）
  goChildren() {
    trackEvent('menu_click', '点击孩子档案');
    wx.navigateTo({ url: '/pkg-family/children/children' });
  },

  // 家属共享（仅主家长）
  goShares() {
    trackEvent('menu_click', '点击家属共享');
    wx.navigateTo({ url: '/pkg-family/shares/shares' });
  },

  // 设置（后台账号 / 订阅消息 / 解除绑定）
  goSettings() {
    trackEvent('menu_click', '点击设置');
    wx.navigateTo({ url: '/pkg-mine/settings/settings' });
  },
});
