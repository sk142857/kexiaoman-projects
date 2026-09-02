/**
 * 打卡提交页
 * 支持文字与图片打卡，家长可代孩子打卡。
 */
const api = require('../../utils/api');

Page({
  data: {
    taskId: null,
    note: '',
    images: [],
    submitting: false
  },

  onLoad(options) {
    this.setData({ taskId: options.taskId });
  },

  onNote(e) {
    this.setData({ note: e.detail.value });
  },

  async onChooseImage() {
    const res = await wx.chooseMedia({
      count: 9 - this.data.images.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera']
    });
    const images = this.data.images.concat(res.tempFiles.map((f) => f.tempFilePath));
    this.setData({ images: images.slice(0, 9) });
  },

  onPreview(e) {
    const idx = e.currentTarget.dataset.index;
    wx.previewImage({
      current: this.data.images[idx],
      urls: this.data.images
    });
  },

  onRemove(e) {
    const idx = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(idx, 1);
    this.setData({ images });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.note.trim() && this.data.images.length === 0) {
      wx.showToast({ title: '请填写内容或选择图片', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await api.createCheckin({
        taskId: this.data.taskId,
        note: this.data.note,
        images: this.data.images,
        checkinDate: require('../../utils/util').todayKey()
      });
      wx.showToast({ title: '打卡成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      // 已在封装层提示
    } finally {
      this.setData({ submitting: false });
    }
  }
});
