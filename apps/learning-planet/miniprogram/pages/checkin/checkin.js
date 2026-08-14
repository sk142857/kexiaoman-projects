// pages/checkin/checkin.js
const { lp } = require('../../utils/api');
const { chooseAndUploadImages, fileUrl, relPath } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    taskId: '',
    taskTitle: '',
    date: todayStr(),
    note: '',
    images: [],
    submitting: false,
  },

  onLoad(options) {
    this.setData({ taskId: options.taskId || '' });
    this._loadTitle(options.taskId);
  },

  async _loadTitle(taskId) {
    try {
      const res = await lp.taskDetail(taskId);
      if (res.task) this.setData({ taskTitle: res.task.title });
    } catch (_) {}
  },

  onDate(e) { this.setData({ date: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },

  addImages() {
    chooseAndUploadImages(9, 'tasks', this.data.images)
      .then((paths) => this.setData({ images: [...this.data.images, ...paths.map(fileUrl)] }))
      .catch(() => {});
  },
  removeImage(e) {
    const i = Number(e.currentTarget.dataset.index);
    this.setData({ images: this.data.images.filter((_, idx) => idx !== i) });
  },

  onSubmit() {
    if (!this.data.date) {
      wx.showToast({ title: '请选择日期', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    lp.checkinCreate({
      taskId: this.data.taskId,
      date: this.data.date,
      note: this.data.note,
      images: this.data.images.map(relPath),
    })
      .then(() => {
        trackEvent('button_click', '任务打卡', { taskId: this.data.taskId });
        wx.showToast({ title: '打卡成功，等待老师审核', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      })
      .catch((e) => wx.showToast({ title: e.msg || '打卡失败', icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },
});
