// pages/service-error/service-error.js
// 云托管冷启动/服务暂不可用提示页：自动重连（倒计时）+ 手动重试，成功后返回原页面
const { retryPendingRequest, hasPendingRequest } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const AUTO_COUNTDOWN = 5;       // 每次自动重连前的倒计时（秒）
const MAX_AUTO_ATTEMPTS = 6;    // 自动重连上限，超出后转手动

Page({
  data: {
    status: 'counting',   // counting=倒计时自动重连 / connecting=重试请求中 / idle=等待手动重试
    countdown: AUTO_COUNTDOWN,
    attempts: 0,
    msg: '',
  },

  onLoad() {
    trackEvent('page_view', '服务唤醒提示');
    if (!hasPendingRequest()) {
      this.setData({ status: 'idle', msg: '服务暂时不可用，请稍后重试' });
      return;
    }
    this._startAutoRetry();
  },

  onUnload() {
    this._clearTimers();
  },

  _clearTimers() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  // 自动重连：倒计时归零自动重试一次，失败且未超上限则进入下一轮
  _startAutoRetry() {
    this._clearTimers();
    this.setData({ countdown: AUTO_COUNTDOWN, status: 'counting' });
    this._countdownTimer = setInterval(() => {
      const next = this.data.countdown - 1;
      this.setData({ countdown: next });
      if (next <= 0) {
        this._clearTimers();
        this._doRetry(true);
      }
    }, 1000);
  },

  onManualRetry() {
    if (this.data.status === 'connecting') return;
    this._clearTimers();
    this._doRetry(false);
  },

  async _doRetry(isAuto) {
    const attempts = this.data.attempts + 1;
    this.setData({ attempts, status: 'connecting', msg: '' });
    try {
      await retryPendingRequest();
      this._onSuccess();
    } catch (e) {
      if (isAuto && attempts < MAX_AUTO_ATTEMPTS) {
        this._startAutoRetry();
      } else {
        this.setData({ status: 'idle', msg: (e && e.msg) || '连接失败，请重试' });
      }
    }
  },

  // 重试成功：返回原页面（redirectTo 保留了页面栈），无上级则回首页
  _onSuccess() {
    this._clearTimers();
    wx.showToast({ title: '连接成功', icon: 'success' });
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: '/pages/home/home' });
      }
    }, 600);
  },

  goHome() {
    this._clearTimers();
    wx.switchTab({ url: '/pages/home/home' });
  },
});
