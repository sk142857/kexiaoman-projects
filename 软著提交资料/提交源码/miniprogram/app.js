/**
 * 小程序入口
 * 初始化云开发环境并加载全局配置。
 */
App({
  globalData: {
    userInfo: null,
    token: '',
    envId: 'cloud-env-0001'
  },

  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: this.globalData.envId,
        traceUser: true
      });
    }
    this.restoreSession();
  },

  // 恢复本地登录态
  restoreSession() {
    const token = wx.getStorageSync('token');
    const userInfo = wx.getStorageSync('userInfo');
    if (token) {
      this.globalData.token = token;
      this.globalData.userInfo = userInfo || null;
    }
  },

  // 设置登录态
  setSession(token, userInfo) {
    this.globalData.token = token;
    this.globalData.userInfo = userInfo;
    wx.setStorageSync('token', token);
    wx.setStorageSync('userInfo', userInfo);
  },

  // 清除登录态
  clearSession() {
    this.globalData.token = '';
    this.globalData.userInfo = null;
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
  }
});
