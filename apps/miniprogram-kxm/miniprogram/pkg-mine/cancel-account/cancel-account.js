// pages/cancel-account/cancel-account.js
// 注销账号（仅家长/个人）：倒计时强制阅读说明 → 立即注销 / 7天注销（默认）
// 说明文案由后端系统参数 account_cancel_copy（JSON）维护，读取失败回退内置默认。
const { lp } = require('../../utils/api');
const { getRole } = require('../../utils/api');
const { stopSessionGuard } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const DEFAULT_COPY = {
  title: '注销账号',
  readTitle: '请仔细阅读注销说明',
  countdownSeconds: 10,
  notices: [
    '注销后，当前账号的绑定关系将立即解除，无法使用该账号登录课小满。',
    '注销后，该账号下的任务、打卡、积分、徽章等数据将被清除，且不可恢复。',
    '7天注销冷静期内将暂停使用业务功能，只能在本页撤销或等待生效；撤销后恢复正常。',
  ],
  risks: [
    '注销属于不可逆操作，请谨慎决定。',
    '若您是家长，您的孩子档案、家属关系与相关邀请码将一并作废。',
    '注销后即使重新绑定，也无法找回已清除的历史数据。',
  ],
  immediate: { label: '立即注销', desc: '立即解除绑定并清除账号数据，即刻生效，不可恢复。' },
  grace: { label: '7天注销', desc: '提交后有7天冷静期，期间暂停使用业务功能，可随时撤销，到期自动注销。' },
  pendingTitle: '注销申请待生效',
  pendingDesc: '冷静期内将暂停使用业务功能，您可随时撤销。',
  revokeBtn: '撤销注销申请',
  revokeModalContent: '撤销后账号可继续正常使用，确定撤销吗？',
};

Page({
  data: {
    copy: DEFAULT_COPY,
    countdown: 10,        // 剩余倒计时秒数
    canOperate: false,    // 倒计时结束后才允许操作
    submitting: false,
    role: '',
    // 待生效注销申请（7天冷静期内）
    pending: null,
    revoking: false,
  },

  onLoad() {
    const role = getRole();
    this.setData({ role });
    trackEvent('page_view', '注销账号');
    this._loadCopy();
    this._loadStatus();
    this._startCountdown();
  },

  async _loadCopy() {
    try {
      const res = await lp.params('account_cancel_copy');
      const c = (res && res.account_cancel_copy) || null;
      if (c && typeof c === 'object') {
        this.setData({
          copy: {
            title: c.title || DEFAULT_COPY.title,
            readTitle: c.readTitle || DEFAULT_COPY.readTitle,
            countdownSeconds: Number(c.countdownSeconds) > 0 ? Math.min(Number(c.countdownSeconds), 120) : DEFAULT_COPY.countdownSeconds,
            notices: Array.isArray(c.notices) ? c.notices : DEFAULT_COPY.notices,
            risks: Array.isArray(c.risks) ? c.risks : DEFAULT_COPY.risks,
            immediate: c.immediate || DEFAULT_COPY.immediate,
            grace: c.grace || DEFAULT_COPY.grace,
            pendingTitle: c.pendingTitle || DEFAULT_COPY.pendingTitle,
            pendingDesc: c.pendingDesc || DEFAULT_COPY.pendingDesc,
            revokeBtn: c.revokeBtn || DEFAULT_COPY.revokeBtn,
            revokeModalContent: c.revokeModalContent || DEFAULT_COPY.revokeModalContent,
          },
        });
        this._startCountdown();
      }
    } catch (_) {}
  },

  // 查询是否有待生效的 7 天注销申请
  async _loadStatus() {
    try {
      const res = await lp.accountCancelStatus();
      this.setData({ pending: res || null });
    } catch (_) {
      this.setData({ pending: null });
    }
  },

  // 倒计时强制阅读：结束后才开放操作按钮
  _startCountdown() {
    if (this._timer) clearInterval(this._timer);
    const total = this.data.copy.countdownSeconds;
    this.setData({ countdown: total, canOperate: total <= 0 });
    if (total <= 0) return;
    this._timer = setInterval(() => {
      const next = this.data.countdown - 1;
      if (next <= 0) {
        clearInterval(this._timer);
        this.setData({ countdown: 0, canOperate: true });
      } else {
        this.setData({ countdown: next });
      }
    }, 1000);
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
  },

  // 撤销 7 天注销申请
  onRevoke() {
    if (this.data.revoking) return;
    wx.showModal({
      title: this.data.copy.revokeBtn,
      content: this.data.copy.revokeModalContent,
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ revoking: true });
        lp.accountCancelRevoke()
          .then(() => {
            wx.showToast({ title: '已撤销注销申请', icon: 'success' });
            // 恢复业务访问后回到首页，并重启会话心跳
            try {
              const app = getApp();
              if (app && typeof app.startSessionGuard === 'function') app.startSessionGuard();
            } catch (_) {}
            setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 600);
          })
          .catch((e) => wx.showToast({ title: e.msg || '撤销失败', icon: 'none' }))
          .finally(() => this.setData({ revoking: false }));
      },
    });
  },

  // 立即注销
  onImmediate() {
    if (!this.data.canOperate || this.data.submitting) return;
    wx.showModal({
      title: '确认立即注销',
      content: '将立即解除绑定并清除账号数据，即刻生效且不可恢复。确定继续吗？',
      confirmText: '确认注销',
      confirmColor: '#d54941',
      success: (r) => {
        if (r.confirm) this._submit('immediate');
      },
    });
  },

  // 7 天注销（默认）
  onGrace() {
    if (!this.data.canOperate || this.data.submitting) return;
    wx.showModal({
      title: '确认7天注销',
      content: '提交申请后有7天冷静期，期间将暂停使用业务功能，只能在本页撤销或等待生效。确定提交吗？',
      confirmText: '提交申请',
      confirmColor: '#d54941',
      success: (r) => {
        if (r.confirm) this._submit('grace');
      },
    });
  },

  async _submit(mode) {
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中', mask: true });
    try {
      const res = await lp.accountCancel(mode);
      wx.hideLoading();
      trackEvent('button_click', mode === 'immediate' ? '注销-立即' : '注销-7天');
      if (mode === 'immediate') {
        wx.showToast({ title: '账号已注销', icon: 'success' });
        this._clearSession();
        setTimeout(() => wx.reLaunch({ url: '/pages/identity/identity' }), 800);
      } else {
        wx.showToast({ title: '已提交7天注销申请', icon: 'success' });
        // 冷静期内业务已被后端拦截，立即停掉会话心跳，用户只能停留在本页撤销/等待
        stopSessionGuard();
        this.setData({ pending: res || { mode: 'grace', status: 'pending' } });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  _clearSession() {
    ['lp_token', 'lp_staff', 'lp_role', 'lp_view_staff_id', 'lp_active_staff_id', 'lp_identities', 'lp_backend', 'lp_share_code']
      .forEach((k) => { try { wx.removeStorageSync(k); } catch (_) {} });
    try {
      const app = getApp();
      if (app && typeof app.stopSessionGuard === 'function') app.stopSessionGuard();
    } catch (_) {}
  },
});
