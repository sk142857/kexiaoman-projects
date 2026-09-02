// pages/todo/todo.js
// 待办主菜单：信息筛选 + 快速处理，不做任务管理
// - Student：展示所有未完成任务（待完成 todo + 进行中 doing），点击直接去处理
// - 家长/家属/管理员：展示本家庭待审核打卡，快速「通过 / 驳回」，处理后立即从待办移除
const { lp, getRole, setViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');
const { fileUrl, previewUrl } = require('../../utils/image');
const { secBadgeMeta } = require('../../utils/display');
const { ensureDict, statusMeta } = require('../../utils/dict');

const MANAGER_ROLES = ['admin', 'parent', 'family'];
// t-tag 无法使用 style，任务状态改用 theme 属性区分
const STATUS_THEME = { todo: 'danger', doing: 'primary', done: 'success' };
// 来源：web（Web后台）/ miniprogram（小程序）
const SOURCE_TEXT = { web: 'Web后台', miniprogram: '小程序' };
const PAGE_SIZE = 20;

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    isAdmin: false,
    isManager: false,
    type: 'student',
    list: [],
    count: 0,
    total: 0,   // 待审核打卡总条数（管理员统计卡片用）
    todayStats: { todayCheckins: 0, todayTasksDone: 0, todayReviewed: 0 },
    loading: false,
    refreshing: false,
    page: 1,
    hasMore: true,
    loadingMore: false,
    // 审核不通过弹层
    rejectVisible: false,
    rejectItem: null,
    rejectScore: '0',
    rejectNote: '',
    submitting: false,
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
    if (!pages.length || pages[pages.length - 1].route !== 'pages/todo/todo') return;

    const tab = this.getTabBar();
    if (tab) tab.sync('/pages/todo/todo');
    trackEvent('page_view', '待办');
    const role = getRole();
    this.setData({ isAdmin: role === 'admin', isManager: MANAGER_ROLES.includes(role) });
    this._load();
  },

  // 待办行展示层派生（学生/审核两种形态共用字段），列表与滚动加载复用
  _decorate(it) {
    const nickname = (it.student && it.student.nickname) || '';
    const secMeta = secBadgeMeta(it);
    const taskMeta = statusMeta('task_status', it.task_status);
    const checkinMeta = statusMeta('checkin_type', it.checkin_type);
    return {
      ...it,
      // 任务状态/打卡方式统一取色（数据字典）
      statusText: taskMeta.label,
      statusStyle: taskMeta.style,
      statusTheme: STATUS_THEME[it.task_status] || 'default',
      checkinText: checkinMeta.label,
      checkinStyle: checkinMeta.style,
      // 内容安全角标（安全关闭/失败时无 display 字段 → 空，走旧逻辑）
      secBadge: secMeta ? secMeta.text : '',
      secTagTheme: secMeta ? secMeta.tagTheme : '',
      // 逐张图片内容安全状态（后端派生）：reviewing=检测中→磨砂加锁，ok=正常
      imageStates: (it.images || []).map((p, i) => (it.images_states && it.images_states[i]) || 'ok'),
      // 列表展示用预览图缩略（省流量），lightbox 用原图
      images: (it.images || []).map(p => previewUrl(p)),
      previewImages: (it.images || []).map(fileUrl),
      voiceUrl: it.voice_url ? fileUrl(it.voice_url) : '',
      videoUrl: it.video_url ? fileUrl(it.video_url) : '',
      videoCover: it.video_cover ? fileUrl(it.video_cover) : '',
      studentAvatar: String(nickname).charAt(0) || '生',
      submitTime: String(it.created_at || '').slice(0, 16),
      sourceText: SOURCE_TEXT[it.source] || (it.source === 'web' ? 'Web后台' : '小程序'),
    };
  },

  async _load(silent, append) {
    if (!silent) this.setData({ loading: true });
    try {
      await ensureDict().catch(() => {});
      const page = append ? this.data.page : 1;
      const res = await lp.todos({ page, pageSize: PAGE_SIZE });
      const rows = (res.list || []).map(it => this._decorate(it));
      this.setData({
        type: res.type || 'student',
        list: append ? this.data.list.concat(rows) : rows,
        count: res.count || 0,
        total: res.total || res.count || 0,
        todayStats: res.todayStats || { todayCheckins: 0, todayTasksDone: 0, todayReviewed: 0 },
        page: page + 1,
        hasMore: !!res.hasMore,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loadingMore: false });
      if (!silent) wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
    if (!silent) this.setData({ loading: false });
  },

  onRefresh() {
    this._load(true).finally(() => this.setData({ refreshing: false }));
  },

  onLoadMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.loading) return;
    this.setData({ loadingMore: true });
    this._load(true, true);
  },

  goTask(e) {
    const id = e.currentTarget.dataset.id;
    // 家长/家属/管理员从待办点开任务：切换视角到提交该打卡的学生，便于查看其打卡记录
    if (this.data.isManager) {
      const item = this.data.list.find(x => Number(x.task_id) === Number(id));
      if (item && item.student && item.student.staff_id) setViewStudent(item.student.staff_id);
    }
    trackEvent('menu_click', '待办-点击任务', { taskId: id });
    wx.navigateTo({ url: `/pkg-task/task-detail/task-detail?id=${id}` });
  },

  preview(e) {
    const index = Number(e.currentTarget.dataset.index);
    const cid = e.currentTarget.dataset.cid;
    const item = this.data.list.find(x => Number(x.checkin_id) === Number(cid));
    if ((item && (item.imageStates || [])[index]) === 'reviewing') {
      wx.showToast({ title: '内容安全检测中，通过后可查看原图', icon: 'none' });
      return;
    }
    const url = e.currentTarget.dataset.url;
    const urls = (item && item.previewImages && item.previewImages.length) ? item.previewImages : [url];
    wx.previewImage({ urls, current: url });
  },

  onApprove(e) {
    const cid = Number(e.currentTarget.dataset.id);
    const item = this.data.list.find(x => Number(x.checkin_id) === cid);
    if (!item) return;
    wx.showModal({
      title: '审核通过',
      content: `确认通过「${item.task_title}」的打卡？审核通过后该打卡得 10 分。`,
      confirmText: '通过',
      cancelText: '再想想',
      success: (r) => {
        if (!r.confirm) return;
        this._review(cid, 'approve');
      },
    });
  },

  onReject(e) {
    const cid = Number(e.currentTarget.dataset.id);
    const item = this.data.list.find(x => Number(x.checkin_id) === cid);
    if (!item) return;
    this.setData({ rejectVisible: true, rejectItem: item, rejectScore: '0', rejectNote: '' });
  },
  onRejectScore(e) { this.setData({ rejectScore: e.detail.value }); },
  onRejectNote(e) { this.setData({ rejectNote: e.detail.value }); },
  cancelReject() { this.setData({ rejectVisible: false, rejectItem: null }); },
  submitReject() {
    const item = this.data.rejectItem;
    if (!item) return;
    const score = Number(this.data.rejectScore);
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      wx.showToast({ title: '评分需在 0-10 之间', icon: 'none' });
      return;
    }
    this._review(item.checkin_id, 'reject', score, this.data.rejectNote);
  },

  async _review(cid, action, score, note) {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await lp.todosReview({
        checkinId: cid,
        action,
        ...(action === 'reject' ? { score, note: note || '' } : {}),
      });
      trackEvent('button_click', action === 'approve' ? '待办-审核通过' : '待办-审核驳回', { checkinId: cid });
      wx.showToast({ title: action === 'approve' ? '已通过 +10 分' : '已驳回', icon: 'success' });
      this.setData({ rejectVisible: false, rejectItem: null });
      this._load(true);
    } catch (e) {
      wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
    }
    this.setData({ submitting: false });
  },
});
