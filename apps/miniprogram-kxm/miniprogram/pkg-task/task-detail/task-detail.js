// pages/task-detail/task-detail.js
const { lp, getViewStudent, getRole } = require('../../utils/api');
const { fileUrl } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');

const STATUS_TEXT = { todo: '待完成', doing: '进行中', done: '已完成' };
const REVIEW_TEXT = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const REVIEW_THEME = {
  pending: { color: '#e37318', bg: '#fdf1e4' },
  approved: { color: '#16a87a', bg: '#e6faf4' },
  rejected: { color: '#f6685d', bg: '#fdeeed' },
};

Page({
  data: {
    id: '',
    task: null,
    checkins: [],
    statusText: STATUS_TEXT,
    images: [],
    isAdmin: false,
    isManager: false,
    canManage: false,
    canCheckin: true,
    canCopy: false,
    isDone: false,
  },

  onLoad(options) {
    let staff = {};
    try { staff = wx.getStorageSync('lp_staff') || {}; } catch (_) {}
    const role = getRole();
    const isManager = ['admin', 'parent', 'family'].includes(role);
    this.setData({
      id: options.id || '',
      staffId: String(staff.staff_id || ''),
      isAdmin: role === 'admin',
      isManager,
      canCheckin: !isManager,
    });
  },

  onShow() {
    if (this.data.id) this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await lp.taskDetail(this.data.id, getViewStudent());
      const task = res.task || null;
      const isDone = !!(task && task.task_status === 'done');
      const own = !!(task && String(task.created_by) === this.data.staffId);
      const checkins = (res.checkins || []).map(c => {
        const st = c.review_status || 'approved';
        const theme = REVIEW_THEME[st] || REVIEW_THEME.approved;
        return {
          ...c,
          images: (c.images || []).map(fileUrl),
          reviewText: REVIEW_TEXT[st] || '已通过',
          reviewColor: theme.color,
          reviewBg: theme.bg,
          canDelete: !isDone || this.data.isManager,
          voiceUrl: c.voice_url ? fileUrl(c.voice_url) : '',
          videoUrl: c.video_url ? fileUrl(c.video_url) : '',
          videoCover: c.video_cover ? fileUrl(c.video_cover) : '',
        };
      });
      this.setData({
        task,
        checkins,
        images: ((task && task.images) || []).map(fileUrl),
        isDone,
        checkinType: (task && task.checkin_type) || 'image',
        // 已完成任务仅可查看：学生隐藏编辑/删除/打卡；家长/家属/管理员不受限
        canManage: this.data.isManager || (own && !isDone),
        canCheckin: !this.data.isManager && !isDone,
        // 复制：可见任务均可复制（后端按 myTaskIds 校验：派发给我/我创建）
        canCopy: !!task,
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      return;
    }
    wx.hideLoading();
  },

  preview(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({ urls: this.data.images, current: url });
  },

  previewCheckin(e) {
    const index = Number(e.currentTarget.dataset.index);
    const cid = String(e.currentTarget.dataset.cid);
    const item = this.data.checkins.find(c => String(c.checkin_id) === cid);
    const urls = (item && item.images) || [];
    const url = urls[index];
    if (!url) return;
    wx.previewImage({ urls, current: url });
  },

  onStart() {
    lp.taskStatus({ id: this.data.id, status: 'doing' }).then(() => {
      trackEvent('button_click', '开始任务', { taskId: this.data.id });
      wx.showToast({ title: '已开始', icon: 'success' });
      this._load();
    }).catch((e) => wx.showToast({ title: e.msg, icon: 'none' }));
  },

  onFinish() {
    wx.showModal({
      title: '确认完成？',
      content: '任务将标记为已完成（需至少打卡 1 次）',
      confirmText: '完成',
      cancelText: '再想想',
      success: (r) => {
        if (!r.confirm) return;
        lp.taskStatus({ id: this.data.id, status: 'done' })
          .then(() => { trackEvent('button_click', '完成任务', { taskId: this.data.id }); wx.showToast({ title: '太棒了！', icon: 'success' }); this._load(); })
          .catch((e) => wx.showToast({ title: e.msg, icon: 'none' }));
      },
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除任务？',
      content: '将一并删除该任务下的打卡记录与图片，不可恢复',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (!r.confirm) return;
        lp.taskDelete(this.data.id)
          .then(() => { wx.showToast({ title: '已删除', icon: 'success' }); setTimeout(() => wx.navigateBack(), 600); })
          .catch((e) => wx.showToast({ title: e.msg, icon: 'none' }));
      },
    });
  },

  onEdit() {
    wx.navigateTo({ url: `/pkg-task/task-edit/task-edit?id=${this.data.id}` });
  },

  onCheckin() {
    if (this.data.task.task_status === 'done') {
      wx.showToast({ title: '任务已完成，不能打卡', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pkg-task/checkin/checkin?taskId=${this.data.id}` });
  },

  onCopy() {
    // 克隆 = 把源任务内容带入新增任务表单，用户可修改后再创建
    trackEvent('button_click', '克隆任务', { taskId: this.data.id });
    wx.navigateTo({ url: `/pkg-task/task-edit/task-edit?id=${this.data.id}&clone=1` });
  },

  onDeleteCheckin(e) {
    const cid = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除打卡？',
      content: '删除后不可恢复',
      success: (r) => {
        if (!r.confirm) return;
        lp.checkinDelete(cid)
          .then(() => { wx.showToast({ title: '已删除', icon: 'success' }); this._load(); })
          .catch((e2) => wx.showToast({ title: e2.msg, icon: 'none' }));
      },
    });
  },
});
