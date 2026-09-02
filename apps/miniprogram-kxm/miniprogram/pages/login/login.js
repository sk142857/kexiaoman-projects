// pages/login/login.js
// 独立登录加载页：冷启动入口，在此完成鉴权判断后再分流入首页 / 身份选择页
const { trackEvent } = require('../../utils/tracker');
const { hasPendingRequest } = require('../../utils/api');

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

  // 鉴权结果分流：注销流程中只能进注销页；已绑定进首页；否则进身份选择页（锁定态带锁信息）
  _route(res) {
    // 服务冷启动/暂不可用（如 -501000 / 5xx）：请求快照已保存，必须进入重试连接页。
    // 主动 reLaunch 而非返回，保证即使 api.js 的跳转被冷却/并发拦截，这里也能兜底到达重试页。
    if (hasPendingRequest()) {
      wx.reLaunch({ url: '/pages/service-error/service-error' });
      return;
    }
    if (res && (res.cancelPending || res.cancel_pending)) {
      wx.reLaunch({ url: '/pkg-mine/cancel-account/cancel-account' });
      return;
    }
    if (res && res.bound && res.staff) {
      wx.reLaunch({ url: '/pages/home/home' });
    } else {
      const locked = res && res.locked;
      wx.reLaunch({ url: '/pages/identity/identity' + (locked ? '?locked=1' : '') });
    }
  },
});
