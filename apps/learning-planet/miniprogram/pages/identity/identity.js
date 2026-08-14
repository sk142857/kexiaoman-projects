// pages/identity/identity.js
// 首次静默登录后的身份选择：我是家长 / 我是学生 / 我是家属
const { lpAuth } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    locked: false,
    lockedMsg: '',
    submitting: false,
  },

  onLoad(options) {
    if (options && options.locked === '1') {
      this.setData({ locked: true, lockedMsg: '您的绑定已解除，请重新选择身份并输入邀请码' });
    }
    trackEvent('page_view', '身份选择');
  },

  // 家长：确认后自动建号 + 自动绑定 + 发共享码 + 下发后台账号
  onParent() {
    if (this.data.submitting) return;
    wx.showModal({
      title: '确认成为主家长？',
      content: '将自动为您创建家庭与后台登录账号，并生成家属共享码。孩子档案可在【我的】中维护。',
      confirmText: '确认',
      cancelText: '再想想',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ submitting: true });
        wx.showLoading({ title: '正在创建账号...', mask: true });
        try {
          const res = await lpAuth.registerParent();
          this._onParentReady(res);
        } catch (e) {
          wx.hideLoading();
          this.setData({ submitting: false });
          wx.showToast({ title: e.msg || '注册失败，请重试', icon: 'none' });
        }
      },
    });
  },

  // 家长注册成功：保存共享码与后台账号（密码点击查看），跳后台账号页展示
  _onParentReady(res) {
    wx.setStorageSync('lp_token', res.token);
    if (res.staff) wx.setStorageSync('lp_staff', res.staff);
    wx.setStorageSync('lp_role', 'parent');
    wx.setStorageSync('lp_share_code', res.share_code || '');
    if (res.backend) wx.setStorageSync('lp_backend', res.backend);
    trackEvent('button_click', '选择身份-主家长');
    wx.hideLoading();
    wx.reLaunch({ url: '/pages/backend-account/backend-account?first=1' });
  },

  // 学生：需输入学生码
  onStudent() {
    trackEvent('button_click', '选择身份-学生');
    wx.navigateTo({ url: '/pages/bind/bind?identity=student' });
  },

  // 家属：需输入家长提供的共享码
  onFamily() {
    trackEvent('button_click', '选择身份-家属');
    wx.navigateTo({ url: '/pages/bind/bind?identity=family' });
  },
});
