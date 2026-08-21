// pages/home/home.js
const { lp, getRole, getViewStudent } = require('../../utils/api');
const { fileUrl } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');
const { secBadgeMeta } = require('../../utils/display');

// 打卡方式展示文案（最近打卡卡片标签）
const CHECKIN_TYPE_TEXT = { image: '图文打卡', voice: '语音打卡', video: '视频打卡' };

Page({
  data: {
    refreshing: false,
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    isAdmin: false,
    isManager: false,
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
    this.setData({ isAdmin: role === 'admin', isManager });
    if (isManager) await this._loadCurrentName();
    this._load();
  },

  _view() {
    return getViewStudent();
  },

  // 当前默认孩子名字：默认值存在本地（孩子档案页设置），未设置时取第一个孩子
  async _loadCurrentName() {
    try {
      const { list } = await lp.adminStudents();
      const students = list || [];
      let id = getViewStudent();
      if (!id && students.length > 0) id = students[0].staff_id;
      const cur = students.find(s => s.staff_id === id) || students[0];
      this.setData({ viewStudentName: cur ? cur.nickname : '' });
    } catch (_) {}
  },

  // 前往孩子档案页切换默认孩子（切换孩子功能已迁移到孩子档案页）
  goChildren() {
    trackEvent('menu_click', '首页-前往孩子档案');
    wx.navigateTo({ url: '/pkg-family/children/children' });
  },

  async _load(silent) {
    if (!silent) wx.showLoading({ title: '加载中', mask: true });
    try {
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
          return {
            ...c,
            checkinTypeText: CHECKIN_TYPE_TEXT[c.checkin_type] || '打卡',
            secBadge: secMeta ? secMeta.text : '',
            secTagTheme: secMeta ? secMeta.tagTheme : '',
            voiceUrl: c.voice_url ? fileUrl(c.voice_url) : '',
          };
        }),
        subjectDist: dash.subjectDist || [],
        staff: (profile && profile.staff) || {},
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
});
