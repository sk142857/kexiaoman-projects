// pages/settings/settings.js
// 设置：后台账号（仅主家长）/ 订阅消息 / 解除绑定
const { getRole } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    isParent: false,
  },

  onShow() {
    const role = getRole();
    this.setData({ isParent: role === 'parent' || role === 'admin' });
    trackEvent('page_view', '设置');
  },

  // 后台登录账号（仅主家长）
  goBackendAccount() {
    trackEvent('menu_click', '设置-后台账号');
    wx.navigateTo({ url: '/pkg-mine/backend-account/backend-account' });
  },

  goSubscribe() {
    trackEvent('menu_click', '设置-订阅消息');
    wx.navigateTo({ url: '/pkg-mine/subscribe/subscribe' });
  },

  onRebind() {
    wx.showModal({
      title: '解除绑定',
      content: '将进入绑定界面，使用新邀请码可更换当前绑定的账号',
      success: (r) => {
        if (!r.confirm) return;
        trackEvent('menu_click', '设置-解除绑定');
        wx.navigateTo({ url: '/pages/identity/identity?rebind=1' });
      },
    });
  },
});
