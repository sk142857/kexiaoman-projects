/**
 * 任务编辑页
 * 支持创建与编辑学习任务。
 */
const api = require('../../utils/api');

const SUBJECTS = ['语文', '数学', '英语', '阅读', '运动', '音乐', '美术', '其他'];

Page({
  data: {
    id: null,
    form: {
      title: '',
      subject: '',
      description: '',
      score: 0,
      deadline: ''
    },
    subjects: SUBJECTS,
    saving: false
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ id: options.id });
      this.load(options.id);
    }
  },

  async load(id) {
    try {
      const task = await api.taskDetail(id);
      this.setData({
        form: {
          title: task.title || '',
          subject: task.subject || '',
          description: task.description || '',
          score: task.score || 0,
          deadline: task.deadline || ''
        }
      });
    } catch (e) {
      // 已在封装层提示
    }
  },

  onTitle(e) {
    this.setData({ 'form.title': e.detail.value });
  },

  onSubject(e) {
    this.setData({ 'form.subject': e.detail.value });
  },

  onDesc(e) {
    this.setData({ 'form.description': e.detail.value });
  },

  onScore(e) {
    this.setData({ 'form.score': e.detail.value });
  },

  onDeadline(e) {
    this.setData({ 'form.deadline': e.detail.value });
  },

  async onSave() {
    const { id, form } = this.data;
    if (!form.title.trim()) {
      wx.showToast({ title: '请填写任务标题', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      if (id) {
        await api.updateTask(id, form);
      } else {
        await api.createTask(form);
      }
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      // 已在封装层提示
    } finally {
      this.setData({ saving: false });
    }
  }
});
