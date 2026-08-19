// pages/settings/settings.js
// 设置：后台账号（仅主家长）/ 订阅消息 / 身份 PIN（家长自选保护）/ 重新绑定
const { getRole, lpAuth } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    isParent: false,
    pinEnabled: false,   // 当前家长身份是否已开 PIN
  },

  onShow() {
    const role = getRole();
    const isParent = role === 'parent' || role === 'admin';
    this.setData({ isParent });
    if (isParent) this._loadPinState();
    trackEvent('page_view', '设置');
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
      content: '将解除当前绑定，重新进入身份选择流程，选择身份后输入新的邀请码即可换绑。确定继续吗？',
      success: (r) => {
        if (!r.confirm) return;
        trackEvent('menu_click', '设置-重新绑定');
        wx.navigateTo({ url: '/pages/identity/identity?rebind=1' });
      },
    });
  },
});
