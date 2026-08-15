// pages/login/login.js
// 独立登录加载页：冷启动入口，在此完成鉴权判断后再分流入首页 / 身份选择页
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    text: '正在登录，请稍候...',
  },

  onLoad() {
    trackEvent('page_view', '登录加载');
  },

  async onShow() {
    const app = getApp();
    // 等待启动登录完成（app.js 中 lpReady 在 onLaunch 时已触发）
    let res = null;
    if (app && app.lpReady) {
      try { res = await app.lpReady; } catch (_) {}
    }
    // 已离开本页（如中途被 reLaunch）则不再处理
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pages/login/login') return;
    this._route(res);
  },

  // 鉴权结果分流：已绑定进首页，否则进身份选择页（锁定态带锁信息）
  _route(res) {
    if (res && res.bound && res.staff) {
      wx.reLaunch({ url: '/pages/home/home' });
    } else {
      const locked = res && res.locked;
      wx.reLaunch({ url: '/pages/identity/identity' + (locked ? '?locked=1' : '') });
    }
  },
});
