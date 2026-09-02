/**
 * 徽章墙页面
 * 展示全部成就徽章及解锁状态。
 */
const api = require('../../utils/api');

Page({
  data: {
    badges: [],
    loading: true
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const badges = await api.myBadges();
      this.setData({ badges, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  goBack() {
    wx.navigateBack();
  }
});
