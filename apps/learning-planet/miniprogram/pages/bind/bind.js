// pages/bind/bind.js
const { lpAuth, clearViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    code: '',
    loading: false,
    locked: false,
    lockedMsg: '',
    errorMsg: '',
    rebind: false,
    identity: '',      // student / family（来自身份选择页）
    placeholder: '6 位大写邀请码',
  },

  onLoad(options) {
    if (options && options.locked === '1') {
      this.setData({ locked: true, lockedMsg: '您的绑定已解除，请输入新的邀请码重新绑定' });
    }
    if (options && options.rebind === '1') {
      this.setData({ rebind: true });
    }
    if (options && options.identity) {
      const idt = options.identity === 'family' ? 'family' : 'student';
      this.setData({
        identity: idt,
        placeholder: idt === 'family' ? '请输入主家长提供的家属共享码' : '请输入家长提供的学生邀请码',
      });
    }
  },

  onInput(e) {
    const v = String(e.detail.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    this.setData({ code: v, errorMsg: '' });
  },

  onBind() {
    const code = this.data.code;
    if (code.length !== 6) {
      this.setData({ errorMsg: '请输入 6 位邀请码' });
      return;
    }
    const doBind = () => {
      this.setData({ loading: true, errorMsg: '' });
      lpAuth.bind(code, this.data.rebind)
        .then((res) => this._onBound(res))
        .catch((e) => {
          // 网络异常时后端可能已绑定成功：复查一次登录态，已绑定则直接进首页
          this._checkBoundThen(e);
        })
        .finally(() => this.setData({ loading: false }));
    };
    if (this.data.rebind) {
      wx.showModal({
        title: '确认重新绑定',
        content: '将更换当前绑定的账号并进入该邀请码对应的账号，确定继续吗？',
        success: (r) => { if (r.confirm) doBind(); },
      });
    } else {
      doBind();
    }
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
  },

  // 绑定成功：落库存 → 进首页
  _onBound(res) {
    wx.setStorageSync('lp_token', res.token);
    if (res.staff) wx.setStorageSync('lp_staff', res.staff);
    wx.setStorageSync('lp_role', res.role || (res.staff && res.staff.role) || 'student');
    clearViewStudent();
    trackEvent('button_click', '绑定邀请码', { role: res.role || 'student' });
    wx.showToast({ title: '绑定成功', icon: 'success' });
    setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 600);
  },

  // 绑定失败兜底：若实际已绑定（服务端成功但响应丢失），仍进入首页
  _checkBoundThen(e) {
    lpAuth.login()
      .then((res) => {
        if (res && res.bound && res.staff && res.token) {
          this._onBound(res);
        } else {
          this.setData({ errorMsg: e.msg || '绑定失败，请重试' });
        }
      })
      .catch(() => this.setData({ errorMsg: e.msg || '绑定失败，请重试' }));
  },
});
