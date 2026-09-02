/**
 * 首页
 * 展示今日概览：连续打卡、积分余额、待办任务与快捷入口。
 */
const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    profile: null,
    todayTask: null,
    streak: 0,
    xp: 0,
    badges: [],
    todoCount: 0
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const [profile, balance, badges, tasks] = await Promise.all([
        api.getProfile(),
        api.pointBalance(),
        api.myBadges(),
        api.listTask({ status: 'doing', pageSize: 5 })
      ]);
      const unlockedCount = badges.filter((b) => b.unlocked).length;
      const todoCount = (tasks.list || []).length;
      this.setData({
        profile,
        streak: profile.streak || 0,
        xp: balance.xp || 0,
        badges,
        todoCount,
        todayTask: this.buildTodayLine(tasks.list || []),
        loading: false
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  // 生成今日打卡建议文案
  buildTodayLine(tasks) {
    const now = new Date();
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const unfinished = tasks.filter((t) => t.status !== 'done');
    if (unfinished.length === 0) {
      return '今日任务已全部完成，太棒了！';
    }
    return `今日还有 ${unfinished.length} 项任务待完成，加油！`;
  },

  goTask(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/task/task?id=${id}` });
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/task-edit/task-edit' });
  }
});
