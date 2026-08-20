// pages/todo/todo.js
// 待办主菜单：信息筛选 + 快速处理，不做任务管理
// - Student：展示所有未完成任务（待完成 todo + 进行中 doing），点击直接去处理
// - 家长/家属/管理员：展示本家庭待审核打卡，快速「通过 / 驳回」，处理后立即从待办移除
const { lp, getRole, setViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');
const { fileUrl, previewUrl } = require('../../utils/image');

const MANAGER_ROLES = ['admin', 'parent', 'family'];
// 来源：web（Web后台）/ miniprogram（小程序）
const SOURCE_TEXT = { web: 'Web后台', miniprogram: '小程序' };

Page({
  data: {
    isAdmin: false,
    isManager: false,
    type: 'student',
    list: [],
    count: 0,
    loading: false,
    refreshing: false,
    // 审核不通过弹层
    rejectVisible: false,
    rejectItem: null,
    rejectScore: '0',
    rejectNote: '',
    submitting: false,
  },

  async onShow() {
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

  async _load(silent) {
    if (!silent) this.setData({ loading: true });
    try {
      const res = await lp.todos();
      const list = (res.list || []).map(it => {
        const nickname = (it.student && it.student.nickname) || '';
        return {
          ...it,
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
      });
      this.setData({ type: res.type || 'student', list, count: res.count || 0 });
    } catch (e) {
      if (!silent) wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
    if (!silent) this.setData({ loading: false });
  },

  onRefresh() {
    this._load(true).finally(() => this.setData({ refreshing: false }));
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
    const url = e.currentTarget.dataset.url;
    const cid = e.currentTarget.dataset.cid;
    const item = this.data.list.find(x => Number(x.checkin_id) === Number(cid));
    const urls = (item && item.previewImages && item.previewImages.length) ? item.previewImages : [url];
    wx.previewImage({ urls, current: url });
  },

  onApprove(e) {
    const cid = Number(e.currentTarget.dataset.id);
    const item = this.data.list.find(x => Number(x.checkin_id) === cid);
    if (!item) return;
    wx.showModal({
      title: '审核通过',
      content: `确认通过「${item.task_title}」的打卡？任务将自动标记为已完成并得 10 分。`,
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
