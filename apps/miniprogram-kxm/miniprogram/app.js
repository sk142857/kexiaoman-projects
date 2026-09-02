// app.js
import { lpAuth, CLOUD_ENV, persistLogin, getActiveStaffId, setActiveStaffId, setIdentities } from './utils/api';
import { collectSession } from './utils/analytics';

// 会话心跳间隔：后台解除/作废邀请码后，最多在此延迟内把用户踢出登录态
const SESSION_GUARD_INTERVAL = 20000;

App({
  globalData: {
    appId: 'miniprogram-kxm',
    appName: '课小满',
    sessionTimer: null,
  },

  onLaunch: function () {
    if (wx.cloud) {
      wx.cloud.init({ env: CLOUD_ENV || undefined, traceUser: true });
    }
    // 暴露登录就绪 Promise，登录加载页等它完成后按绑定状态分流入首页 / 身份选择页
    this.lpReady = this.ensureLogin();
  },

  onShow: function () {
    // 回到前台立即校验一次会话（后台解除邀请码后，切回小程序即刻生效）
    if (this.globalData.sessionTimer) this.heartbeat();
  },

  // 启动即登录：wx.login 拿会话 token → 已绑定（家长/家属/学生/管理员）进首页，未绑定进身份选择页
  async ensureLogin() {
    try {
      const res = await lpAuth.login();
      if (res && res.token) {
        persistLogin(res);
        // 多身份（共用微信）：活动身份跟随上次选择；storage 中有效则保持，否则后端已给默认
        if (res.identities && res.identities.length > 0) {
          setIdentities(res.identities);
          const cur = getActiveStaffId();
          const stillValid = res.identities.some(s => String(s.staff_id) === cur);
          if (!stillValid) setActiveStaffId(res.activeStaffId || res.identities[0].staff_id);
        }
      }
      if (res && res.bound && res.staff) {
        wx.setStorageSync('lp_staff', res.staff);
        wx.setStorageSync('lp_role', res.role || res.staff.role || 'student');
        // 注销流程中（7天冷静期）：不采集/不启用心跳（业务已被后端 460 拦截），
        // 由登录加载页分流到注销页，用户只能停留在注销页撤销/等待（如抖音/公众号注销流程）
        if (res.cancel_pending) {
          this.stopSessionGuard();
          return { ...res, bound: true, cancelPending: res.cancel_pending };
        }
        // 冷启动静默采集会话画像（失败不影响）
        collectSession();
        this.startSessionGuard();
        return { ...res, bound: true };
      }
      // 锁定/未绑定提示带给身份页展示（账号被后台锁定）
      if (res && res.locked && res.msg) wx.setStorageSync('lp_lock_msg', res.msg);
      if (res && res.locked && res.lockInfo) wx.setStorageSync('lp_lock_info', res.lockInfo);
      return res || { bound: false };
    } catch (e) {
      return { bound: false };
    }
  },

  // 会话心跳：轮询后端实时复核绑定状态。
  // 403/401 时 request 内部已清除登录态并跳回身份页，这里只需停止轮询
  heartbeat() {
    lpAuth.sessionCheck()
      .then(() => {})
      .catch(() => this.stopSessionGuard());
  },

  startSessionGuard() {
    this.stopSessionGuard();
    this.heartbeat();
    this.globalData.sessionTimer = setInterval(() => this.heartbeat(), SESSION_GUARD_INTERVAL);
  },

  stopSessionGuard() {
    if (this.globalData.sessionTimer) {
      clearInterval(this.globalData.sessionTimer);
      this.globalData.sessionTimer = null;
    }
  },

  // 已停留在目标页则跳过 reLaunch，避免冷启动闪屏/重复加载
  _go(url) {
    const pages = getCurrentPages();
    const cur = pages.length ? '/' + pages[pages.length - 1].route : '';
    if (cur === url || cur === url.split('?')[0]) return;
    wx.reLaunch({ url });
  },

  // 供页面调用的重新登录（token 失效/被锁定后回到登录加载页重新鉴权）
  reAuth() {
    this.stopSessionGuard();
    wx.removeStorageSync('lp_token');
    wx.removeStorageSync('lp_staff');
    wx.removeStorageSync('lp_role');
    wx.removeStorageSync('lp_view_staff_id');
    wx.removeStorageSync('lp_active_staff_id');
    wx.removeStorageSync('lp_identities');
    // 一并清除上一账号的后台登录凭据与共享码
    wx.removeStorageSync('lp_backend');
    wx.removeStorageSync('lp_share_code');
    this.lpReady = this.ensureLogin();
    this._go('/pages/login/login');
  },
});
