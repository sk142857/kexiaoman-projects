// pages/settings/settings.js
// 设置：系统通知 / 后台账号（仅主家长）/ 订阅消息 / 身份 PIN（家长自选保护）/ 重新绑定 / 注销账号（家长、个人）
const { getRole, lpAuth, lp } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    isParent: false,
    canCancel: false,   // 家长/个人：支持注销账号
    pinEnabled: false,   // 当前家长身份是否已开 PIN
    appVersion: 'v1.0.3',   // 小程序版本号（关于版本展示；无值时兜底）
    notifyUnread: 0,      // 系统通知未读数（菜单徽标）
  },

  onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    const role = getRole();
    const isParent = role === 'parent' || role === 'admin';
    this.setData({
      isParent,
      canCancel: role === 'parent' || role === 'personal',
      appVersion: this._appVersion(),
    });
    if (isParent) this._loadPinState();
    this._loadNotifyUnread();
    trackEvent('page_view', '设置');
  },

  // 系统通知未读数（菜单徽标；失败静默置 0）
  async _loadNotifyUnread() {
    try {
      const res = await lp.notificationsUnread();
      this.setData({ notifyUnread: Number((res && res.count) || 0) });
    } catch (_) {
      this.setData({ notifyUnread: 0 });
    }
  },

  // 系统通知（站内信）
  goNotifications() {
    trackEvent('menu_click', '设置-系统通知');
    wx.navigateTo({ url: '/pkg-mine/notifications/notifications' });
  },

  // 当前小程序版本号（发布版/体验版/开发版一致；开发工具中可能为空，兜底 v1.0.0）
  _appVersion() {
    try {
      const acct = wx.getAccountInfoSync();
      const v = acct && acct.miniProgram && acct.miniProgram.version;
      return v ? `v${v}` : 'v1.0.0';
    } catch (_) {
      return 'v1.0.0';
    }
  },

  // 查询当前身份的 PIN 状态（t_staff.pin_hash 是否已设置）
  async _loadPinState() {
    try {
      const res = await lpAuth.pin('verify', '');
      this.setData({ pinEnabled: !!(res && res.enabled) });
    } catch (_) {
      this.setData({ pinEnabled: false });
    }
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

  // 家属共享（仅主家长）
  goShares() {
    trackEvent('menu_click', '设置-家属共享');
    wx.navigateTo({ url: '/pkg-family/shares/shares' });
  },

  // 身份 PIN：开启 / 修改 / 关闭（家长自选保护，防止孩子切换家长模式）
  onPin() {
    if (this.data.pinEnabled) {
      wx.showActionSheet({
        itemList: ['修改 PIN', '关闭 PIN 保护'],
        success: (r) => {
          if (r.tapIndex === 0) this._askSetPin();
          else if (r.tapIndex === 1) this._confirmRemovePin();
        },
      });
    } else {
      this._askSetPin();
    }
  },

  // 设置 / 修改 PIN：先说明风险，再输入 4-6 位数字
  _askSetPin() {
    wx.showModal({
      title: '开启身份 PIN 锁',
      content: '设置后，孩子在同一手机上切换到「家长」身份时需输入 PIN。未设置时孩子可一键切换家长模式，存在隐私风险。是否开启？',
      success: (r) => {
        if (!r.confirm) return;
        wx.showModal({
          title: '设置 PIN',
          editable: true,
          placeholderText: '4-6 位数字',
          success: async (r2) => {
            if (!r2.confirm) return;
            const pin = String(r2.content || '').trim();
            if (!/^\d{4,6}$/.test(pin)) {
              wx.showToast({ title: 'PIN 需为 4-6 位数字', icon: 'none' });
              return;
            }
            wx.showLoading({ title: '保存中', mask: true });
            try {
              await lpAuth.pin('set', pin);
              this.setData({ pinEnabled: true });
              wx.hideLoading();
              wx.showToast({ title: '身份 PIN 已开启', icon: 'success' });
              trackEvent('button_click', '设置-开启PIN');
            } catch (e) {
              wx.hideLoading();
              wx.showToast({ title: e.msg || '保存失败', icon: 'none' });
            }
          },
        });
      },
    });
  },

  // 关闭 PIN：需正确 PIN + 二次确认风险
  _confirmRemovePin() {
    wx.showModal({
      title: '确认关闭 PIN 锁',
      content: '关闭后，孩子可一键切换到「家长」身份，查看家庭信息、后台账号等敏感内容，确定关闭吗？',
      success: (r) => {
        if (!r.confirm) return;
        wx.showModal({
          title: '验证 PIN',
          editable: true,
          placeholderText: '当前 PIN',
          success: async (r2) => {
            if (!r2.confirm) return;
            const pin = String(r2.content || '').trim();
            if (!pin) {
              wx.showToast({ title: '请输入 PIN', icon: 'none' });
              return;
            }
            wx.showLoading({ title: '保存中', mask: true });
            try {
              await lpAuth.pin('remove', pin);
              this.setData({ pinEnabled: false });
              wx.hideLoading();
              wx.showToast({ title: '已关闭 PIN 保护', icon: 'success' });
              trackEvent('button_click', '设置-关闭PIN');
            } catch (e) {
              wx.hideLoading();
              wx.showToast({ title: e.msg || 'PIN 错误或操作失败', icon: 'none' });
            }
          },
        });
      },
    });
  },

  onRebind() {
    wx.showModal({
      title: '重新绑定',
      content: '将立即解除当前绑定（清除绑定关系，不影响任务/打卡等数据），然后重新进入身份选择流程。确定继续吗？',
      success: (r) => {
        if (!r.confirm) return;
        trackEvent('menu_click', '设置-重新绑定');
        // 第一步：立即解除当前绑定（后台清除绑定关系）；随后即使中断换绑，解绑已生效
        wx.showLoading({ title: '解除绑定中', mask: true });
        lpAuth.unbind()
          .then(() => {
            wx.hideLoading();
            // 清除本地登录态与身份缓存，回身份页重新选择身份
            this._clearSession();
            wx.reLaunch({ url: '/pages/identity/identity?rebind=1' });
          })
          .catch((e) => {
            wx.hideLoading();
            wx.showToast({ title: e.msg || '解除绑定失败', icon: 'none' });
          });
      },
    });
  },

  // 清除本地登录态与身份缓存（解绑/注销后回身份页）
  _clearSession() {
    ['lp_token', 'lp_staff', 'lp_role', 'lp_view_staff_id', 'lp_active_staff_id', 'lp_identities', 'lp_backend', 'lp_share_code']
      .forEach((k) => { try { wx.removeStorageSync(k); } catch (_) {} });
    try {
      const app = getApp();
      if (app && typeof app.stopSessionGuard === 'function') app.stopSessionGuard();
    } catch (_) {}
  },

  // 注销账号（仅家长/个人）
  goCancelAccount() {
    trackEvent('menu_click', '设置-注销账号');
    wx.navigateTo({ url: '/pkg-mine/cancel-account/cancel-account' });
  },
});
