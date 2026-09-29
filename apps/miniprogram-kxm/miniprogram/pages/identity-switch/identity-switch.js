// pages/identity-switch/identity-switch.js
// 身份切换（独立一级菜单）：展示提示文案 + 全部身份子菜单（点击切换）+ 身份保护 PIN 设置 + 底部操作栏
const { lp, lpAuth, getRole, getIdentities, setIdentities, getActiveStaffId, setActiveStaffId, persistLogin, clearViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

// 角色代码不变（student），界面统一展示为「孩子」
const ROLE_TEXT = { admin: '管理员', parent: '主家长', family: '家属', student: '孩子', personal: '个人' };

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    identities: [],
    currentStaffId: '',
    parentNoPin: false,
    isParent: false,     // 当前身份为家长/管理员（可设置身份 PIN）
    pinEnabled: false,   // 当前家长身份是否已开 PIN
  },

  onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    trackEvent('page_view', '身份切换');
    const app = getApp();
    const ready = app && app.lpReady;
    if (ready && typeof ready.then === 'function') {
      ready.catch(() => {}).then(() => this._load());
    } else {
      this._load();
    }
  },

  // 加载本机已绑定的全部身份（含 PIN 状态）
  async _load() {
    const role = getRole();
    const isParent = role === 'parent' || role === 'admin';
    this.setData({ isParent });
    try {
      const profile = await lp.profile();
      let identities = (profile && profile.identities) || getIdentities();
      const curId = String(getActiveStaffId() || (profile && profile.staff && profile.staff.staff_id) || '');
      if (Array.isArray(identities) && identities.length > 0) {
        identities = identities.map(it => ({
          ...it,
          isCurrent: String(it.staff_id) === curId,
        }));
        setIdentities(identities);
      }
      const list = Array.isArray(identities) ? identities : [];
      // 当前身份 PIN 状态由 identities[].pin_enabled 推导（不再空 PIN 探活，
      // 空 PIN 会被后端记为失败尝试累计致自锁，见审计 A3）
      const me = list.find(it => String(it.staff_id) === curId) || list[0] || {};
      this.setData({
        identities: list,
        currentStaffId: curId,
        parentNoPin: list.some(it => it.role === 'parent' && !it.pin_enabled),
        pinEnabled: isParent && !!(me && me.pin_enabled),
      });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
  },

  // 身份 PIN：开启 / 修改 / 关闭（家长自选保护，防止孩子切换家长模式）
  onPin() {
    trackEvent('menu_click', '身份切换-身份保护');
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

  // 开启 / 修改 PIN：未开启直接设置；已开启时修改必须先验证当前 PIN（审计 B2）
  _askSetPin() {
    wx.showModal({
      title: '开启身份 PIN 锁',
      content: '设置后，孩子在同一手机上切换到「家长」身份时需输入 PIN。未设置时孩子可一键切换家长模式，存在隐私风险。是否开启？',
      success: (r) => {
        if (!r.confirm) return;
        if (!this.data.pinEnabled) {
          this._inputNewPin('');
          return;
        }
        wx.showModal({
          title: '验证当前 PIN',
          content: '修改 PIN 前需先验证当前 PIN',
          editable: true,
          placeholderText: '当前 PIN',
          success: async (r0) => {
            if (!r0.confirm) return;
            const old = String(r0.content || '').trim();
            if (!/^\d{4,6}$/.test(old)) {
              wx.showToast({ title: 'PIN 需为 4-6 位数字', icon: 'none' });
              return;
            }
            wx.showLoading({ title: '验证中', mask: true });
            try {
              const chk = await lpAuth.pin('verify', old);
              wx.hideLoading();
              if (!chk || !chk.valid) {
                wx.showToast({ title: '原 PIN 错误，请重试', icon: 'none' });
                return;
              }
              this._inputNewPin(old);
            } catch (e) {
              wx.hideLoading();
              wx.showToast({ title: e.msg || '验证失败', icon: 'none' });
            }
          },
        });
      },
    });
  },

  // 输入新 PIN 并保存（oldPin 非空 = 修改模式，提交时带原 PIN 供后端校验）
  _inputNewPin(oldPin) {
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
          await lpAuth.pin('set', pin, oldPin);
          this.setData({ pinEnabled: true, parentNoPin: false });
          wx.hideLoading();
          wx.showToast({ title: oldPin ? 'PIN 已更新' : '身份 PIN 已开启', icon: 'success' });
          trackEvent('button_click', oldPin ? '身份切换-修改PIN' : '身份切换-开启PIN');
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: e.msg || '保存失败', icon: 'none' });
        }
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
              this.setData({ pinEnabled: false, parentNoPin: true });
              wx.hideLoading();
              wx.showToast({ title: '已关闭 PIN 保护', icon: 'success' });
              trackEvent('button_click', '身份切换-关闭PIN');
            } catch (e) {
              wx.hideLoading();
              wx.showToast({ title: e.msg || 'PIN 错误或操作失败', icon: 'none' });
            }
          },
        });
      },
    });
  },

  roleText(role) {
    return ROLE_TEXT[role] || '孩子';
  },

  // 切换到指定身份（家长/管理员身份需 PIN 弹窗）
  onSwitchIdentity(e) {
    const target = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.staffId;
    if (!target) return;
    if (String(target) === String(this.data.currentStaffId)) {
      wx.showToast({ title: '已是当前身份', icon: 'none' });
      return;
    }
    const identity = this.data.identities.find(it => String(it.staff_id) === String(target));
    const needPin = identity && ['parent', 'admin'].includes(identity.role) && identity.pin_enabled;
    if (needPin) {
      this._askPin(target);
      return;
    }
    this._doSwitch(target, '');
  },

  // 家长/管理员身份需 PIN：弹输入框
  _askPin(target) {
    wx.showModal({
      title: '切换家长身份',
      editable: true,
      placeholderText: '4-6 位数字',
      success: (r) => {
        if (!r.confirm) return;
        const pin = String(r.content || '').trim();
        if (!/^\d{4,6}$/.test(pin)) {
          wx.showToast({ title: 'PIN 需为 4-6 位数字', icon: 'none' });
          return;
        }
        this._doSwitch(target, pin);
      },
    });
  },

  async _doSwitch(staffId, pin) {
    wx.showLoading({ title: '切换中', mask: true });
    try {
      const res = await lp.switchIdentity(staffId, pin);
      persistLogin(res);
      if (res.identities) setIdentities(res.identities.map(it => ({
        ...it,
        isCurrent: String(it.staff_id) === String(res.activeStaffId || staffId),
      })));
      if (res.activeStaffId) setActiveStaffId(res.activeStaffId);
      // 切换身份后清除「查看某学生」残留，回首页按新身份加载
      clearViewStudent();
      trackEvent('button_click', '切换身份', { staffId, role: res.role || '' });
      wx.hideLoading();
      wx.showToast({ title: '已切换身份', icon: 'success' });
      setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 400);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '切换失败', icon: 'none' });
    }
  },

  // 底部「进入首页」：以当前身份直接进入首页
  goHome() {
    wx.reLaunch({ url: '/pages/home/home' });
  },
});
