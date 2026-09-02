/**
 * 任务详情页
 * 展示任务信息、打卡记录，支持提交打卡与状态流转。
 */
const api = require('../../utils/api');

Page({
  data: {
    id: null,
    task: null,
    checkins: [],
    loading: true,
    checkinText: ''
  },

  onLoad(options) {
    this.setData({ id: options.id });
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const task = await api.taskDetail(this.data.id);
      const checkins = await api.listCheckin({ taskId: this.data.id });
      this.setData({ task, checkins, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  // 提交打卡
  async onSubmitCheckin() {
    const content = this.data.checkinText.trim();
    if (!content) {
      wx.showToast({ title: '请填写打卡内容', icon: 'none' });
      return;
    }
    try {
      await api.createCheckin({
        taskId: this.data.id,
        note: content,
        checkinDate: this.today()
      });
      wx.showToast({ title: '打卡成功', icon: 'success' });
      this.setData({ checkinText: '' });
      this.load();
    } catch (e) {
      // 已在封装层提示
    }
  },

  // 完成任务
  async onFinish() {
    try {
      await api.changeTaskStatus(this.data.id, 'done');
      wx.showToast({ title: '任务已完成', icon: 'success' });
      this.load();
    } catch (e) {
      // 已在封装层提示
    }
  },

  onInput(e) {
    this.setData({ checkinText: e.detail.value });
  },

  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
});
