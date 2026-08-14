// app.js
import { lpAuth, CLOUD_ENV } from './utils/api';
import { collectSession } from './utils/analytics';

App({
  globalData: {
    appId: 'learning-planet',
    appName: '课小满',
  },

  onLaunch: function () {
    if (wx.cloud) {
      wx.cloud.init({ env: CLOUD_ENV || undefined, traceUser: true });
    }
    // 暴露登录就绪 Promise，首页 onShow 等它完成后再加载，避免未绑定先请求业务接口被弹回
    this.lpReady = this.ensureLogin();
  },

  // 启动即登录：wx.login 拿会话 token → 已绑定（家长/家属/学生/管理员）进首页，未绑定进身份选择页
  async ensureLogin() {
    try {
      const res = await lpAuth.login();
      if (res && res.token) wx.setStorageSync('lp_token', res.token);
      if (res && res.bound && res.staff) {
        wx.setStorageSync('lp_staff', res.staff);
        wx.setStorageSync('lp_role', res.role || res.staff.role || 'student');
        // 冷启动静默采集会话画像（失败不影响）
        collectSession();
        this._go('/pages/home/home');
      } else {
        this._go('/pages/identity/identity' + (res && res.locked ? '?locked=1' : ''));
      }
    } catch (e) {
      this._go('/pages/identity/identity');
    }
  },

  // 已停留在目标页则跳过 reLaunch，避免冷启动闪屏/重复加载
  _go(url) {
    const pages = getCurrentPages();
    const cur = pages.length ? '/' + pages[pages.length - 1].route : '';
    if (cur === url || cur === url.split('?')[0]) return;
    wx.reLaunch({ url });
  },

  // 供页面调用的重新登录（token 失效/被锁定后回到绑定页）
  reAuth() {
    wx.removeStorageSync('lp_token');
    wx.removeStorageSync('lp_staff');
    wx.removeStorageSync('lp_role');
    wx.removeStorageSync('lp_view_staff_id');
    this.ensureLogin();
  },
});
