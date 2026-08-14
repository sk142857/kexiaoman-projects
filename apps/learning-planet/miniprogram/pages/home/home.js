// pages/home/home.js
const { lp, getRole, getViewStudent, setViewStudent, clearViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    refreshing: false,
    isAdmin: false,
    isManager: false,
    students: [],
    viewStudentId: '',
    viewStudentIndex: -1,
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
  },

  async onShow() {
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
    if (isManager) await this._loadStudents();
    this._load();
  },

  _view() {
    return getViewStudent();
  },

  async _loadStudents() {
    try {
      const { list } = await lp.adminStudents();
      const students = list || [];
      let viewStudentId = getViewStudent();
      let idx = students.findIndex(s => s.staff_id === viewStudentId);
      // 管理员默认查看排列第一的学生，避免首次进入页面空渲染
      if (idx < 0 && students.length > 0) {
        viewStudentId = students[0].staff_id;
        idx = 0;
        setViewStudent(viewStudentId);
      }
      this.setData({
        students,
        viewStudentId,
        viewStudentIndex: idx,
        viewStudentName: idx >= 0 ? students[idx].nickname : '',
      });
    } catch (_) {}
  },

  onPickStudent(e) {
    const s = this.data.students[Number(e.detail.value)];
    if (!s) return;
    setViewStudent(s.staff_id);
    trackEvent('menu_click', '管理员切换学生', { staffId: s.staff_id });
    this.setData({ viewStudentId: s.staff_id, viewStudentIndex: Number(e.detail.value), viewStudentName: s.nickname });
    this._load();
  },

  exitView() {
    clearViewStudent();
    this.setData({ viewStudentId: '', viewStudentIndex: -1, viewStudentName: '' });
    this._load();
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
          h: Number(d.value) > 0 ? Math.round(12 + (Math.min(Number(d.value), maxV) / maxV) * 76) : 8,
        })),
        weekCheckinCount: rawDays.reduce((s, d) => s + (Number(d.value) || 0), 0),
        reminders: dash.reminders || [],
        recentCheckins: dash.recentCheckinList || [],
        subjectDist: dash.subjectDist || [],
        staff: (profile && profile.staff) || {},
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

  goTaskDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${id}` });
  },
});
