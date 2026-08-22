// pages/home/home.js
const { lp, getRole, getViewStudent } = require('../../utils/api');
const { fileUrl } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');
const { secBadgeMeta } = require('../../utils/display');
const { ensureDict, statusMeta } = require('../../utils/dict');

Page({
  data: {
    refreshing: false,
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    isAdmin: false,
    isManager: false,
    canManageChildren: false,   // 家长/管理员：可维护孩子档案
    needChildPrompt: false,     // 家长/管理员尚未创建孩子档案时，首页顶部引导创建
    viewStudentName: '',
    staff: {},
    level: null,
    streak: null,
    stats: null,
    days: [],
    weekCheckinCount: 0,
    reminders: [],
    recentCheckins: [],
    subjectDist: [],
    notifyUnread: 0,   // 系统通知未读数（今日提醒区入口角标）
  },

  async onShow() {
    // 每次展示页面滚动区复位到顶部（新打开的页面不受上一页面滚动位置影响）
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    // 等启动登录完成再进入业务逻辑（未绑定时会被 reLaunch 到身份选择页，本页已失效则直接返回）
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pages/home/home') return;

    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().sync('/pages/home/home');
    }
    trackEvent('page_view', '学习仪表盘');
    const role = getRole();
    const isManager = ['admin', 'parent', 'family'].includes(role);
    const canManageChildren = role === 'parent' || role === 'admin';
    this.setData({ isAdmin: role === 'admin', isManager, canManageChildren });
    if (isManager) await this._loadCurrentName();
    this._load();
  },

  _view() {
    // 优先使用已解析的默认孩子 id（未在本地显式设置默认孩子时，与「当前孩子」栏一致取第一个孩子）
    if (this._viewStudentId) return this._viewStudentId;
    return getViewStudent();
  },

  // 当前默认孩子名字：默认值存在本地（孩子档案页设置），未设置时取第一个孩子
  async _loadCurrentName() {
    try {
      const { list } = await lp.adminStudents();
      const students = list || [];
      let id = getViewStudent();
      if (!id && students.length > 0) id = students[0].staff_id;
      this._viewStudentId = id || '';
      const cur = students.find(s => s.staff_id === id) || students[0];
      this.setData({
        viewStudentName: cur ? cur.nickname : '',
        needChildPrompt: this.data.canManageChildren && students.length === 0,
      });
    } catch (_) {
      this._viewStudentId = '';
    }
  },

  // 首页引导：家长/管理员尚未创建孩子档案 → 前往孩子档案页创建
  goAddChild() {
    trackEvent('menu_click', '首页-引导创建孩子档案');
    wx.navigateTo({ url: '/pkg-family/children/children' });
  },

  // 前往孩子档案页切换默认孩子（切换孩子功能已迁移到孩子档案页）
  goChildren() {
    trackEvent('menu_click', '首页-前往孩子档案');
    wx.navigateTo({ url: '/pkg-family/children/children' });
  },

  async _load(silent) {
    if (!silent) wx.showLoading({ title: '加载中', mask: true });
    try {
      await ensureDict().catch(() => {});
      const [dash, profile] = await Promise.all([lp.dashboard(this._view()), lp.profile()]);
      const rawDays = dash.days || [];
      const maxV = rawDays.reduce((m, d) => Math.max(m, Number(d.value) || 0), 1);
      this.setData({
        level: dash.level || null,
        streak: dash.streak || null,
        stats: dash.stats || null,
        days: rawDays.map(d => ({
          date: d.date,
          value: Number(d.value) || 0,
          active: Number(d.value) > 0,
          h: Number(d.value) > 0 ? Math.round(24 + (Math.min(Number(d.value), maxV) / maxV) * 120) : 12,
        })),
        weekCheckinCount: rawDays.reduce((s, d) => s + (Number(d.value) || 0), 0),
        reminders: dash.reminders || [],
        recentCheckins: (dash.recentCheckinList || []).map(c => {
          const secMeta = secBadgeMeta(c);
          const checkinMeta = statusMeta('checkin_type', c.checkin_type);
          return {
            ...c,
            checkinTypeText: checkinMeta.label,
            checkinTypeStyle: checkinMeta.style,
            secBadge: secMeta ? secMeta.text : '',
            secTagTheme: secMeta ? secMeta.tagTheme : '',
            voiceUrl: c.voice_url ? fileUrl(c.voice_url) : '',
          };
        }),
        subjectDist: dash.subjectDist || [],
        // 抬头/分享使用被查看孩子本人（管理员/家长/家属看孩子 = 孩子；学生 = 本人），
        // 与 level/streak/stats 属于同一视角，避免把家长名字配在孩子等级上造成「家长是学习新手」的误解。
        staff: (dash && dash.staff) || (profile && profile.staff) || {},
      });
      this._loadNotifyUnread();
    } catch (e) {
      if (!silent) {
        wx.hideLoading();
        wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
        return;
      }
    }
    if (!silent) wx.hideLoading();
  },

  // 系统通知未读数（站内信角标；失败静默置 0，不影响主加载）
  async _loadNotifyUnread() {
    try {
      const res = await lp.notificationsUnread();
      this.setData({ notifyUnread: Number((res && res.count) || 0) });
    } catch (_) {
      this.setData({ notifyUnread: 0 });
    }
  },

  // 系统通知入口：今日提醒区 → 通知列表
  goNotifications() {
    trackEvent('menu_click', '首页-系统通知');
    wx.navigateTo({ url: '/pkg-mine/notifications/notifications' });
  },

  onRefresh() {
    this._load(true).finally(() => this.setData({ refreshing: false }));
  },

  goTaskDetail(e) {
    const id = e.currentTarget.dataset.id;
    trackEvent('menu_click', '首页-最近打卡跳转任务详情', { taskId: id });
    wx.navigateTo({ url: `/pkg-task/task-detail/task-detail?id=${id}` });
  },

  onShareAppMessage() {
    const staff = this.data.staff || {};
    const level = this.data.level || {};
    trackEvent('button_click', '分享-学习仪表盘', { level: level.level || '' });
    return {
      title: `${staff.nickname || '同学'} 在课小满已到 Lv.${level.level || 0}，一起打卡养成好习惯吧！`,
      path: '/pages/home/home',
      success: () => trackEvent('custom', '分享成功-学习仪表盘', { level: level.level || '' }),
      fail: () => trackEvent('custom', '分享取消-学习仪表盘', { level: level.level || '' }),
    };
  },

  onShareTimeline() {
    const staff = this.data.staff || {};
    const level = this.data.level || {};
    return {
      title: `${staff.nickname || '同学'} 在课小满已到 Lv.${level.level || 0}，一起打卡养成好习惯吧！`,
      query: '',
    };
  },
});
