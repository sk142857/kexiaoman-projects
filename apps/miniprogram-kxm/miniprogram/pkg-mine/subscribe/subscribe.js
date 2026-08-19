// pages/subscribe/subscribe.js
// 订阅消息（第一阶段）：查看订阅状态/次数 + 用户主动「增加订阅次数」授权流程
// 数据流：点按钮 → wx.requestSubscribeMessage 授权 → 上报 grant → 记录次数 → 刷新状态
const { lp } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    available: 0,
    total: 0,
    used: 0,
    hasTmpl: false,
    tmplIds: [],
    tmplCount: 0,
    grants: [],
    loaded: false,
    loading: false,
    granting: false,
  },

  async onShow() {
    const app = getApp();
    if (app && app.lpReady) {
      try { await app.lpReady; } catch (_) {}
    }
    // 等待期间可能被 reLaunch 到身份页，页面已失效则直接返回
    const pages = getCurrentPages();
    if (!pages.length || pages[pages.length - 1].route !== 'pkg-mine/subscribe/subscribe') return;
    trackEvent('page_view', '订阅消息');
    this._load();
  },

  async _load() {
    this.setData({ loading: true });
    try {
      const res = await lp.subscribeStatus();
      this.setData({
        available: res.available || 0,
        total: res.total || 0,
        used: res.used || 0,
        hasTmpl: !!res.has_tmpl,
        tmplIds: res.tmpl_ids || [],
        tmplCount: res.tmpl_count || 0,
        grants: res.grants || [],
        loaded: true,
      });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  /** 增加订阅次数：发起微信订阅授权 */
  requestSubscribe() {
    const tmplIds = this.data.tmplIds;
    if (!tmplIds.length) {
      trackEvent('button_click', '订阅-模板未配置');
      wx.showToast({ title: '订阅模板尚未配置，请联系管理员', icon: 'none' });
      return;
    }
    trackEvent('button_click', '订阅-发起授权');
    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => {
        const accepted = [];
        let denied = 0;
        tmplIds.forEach((id) => {
          const v = res[id];
          if (v === 'accept') accepted.push(id);
          else if (v === 'reject') denied += 1;
          // 'ban'：用户之前勾选「总是保持以上选择」且选拒绝，不再弹窗
        });
        if (accepted.length > 0) {
          this._saveGrant(accepted);
        } else if (denied > 0) {
          wx.showToast({ title: '已拒绝订阅授权', icon: 'none' });
        } else {
          wx.showToast({ title: '未授权订阅', icon: 'none' });
        }
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('cancel') >= 0) {
          wx.showToast({ title: '已取消订阅', icon: 'none' });
        } else {
          console.error('[subscribe] requestSubscribeMessage fail', err);
          wx.showToast({ title: '订阅授权失败，请重试', icon: 'none' });
        }
      },
    });
  },

  _saveGrant(accepted) {
    this.setData({ granting: true });
    lp.subscribeGrant({ tmplIds: accepted, grantCount: 1 })
      .then(() => {
        trackEvent('button_click', '订阅-授权成功', { count: accepted.length });
        wx.showToast({ title: `订阅成功 +${accepted.length} 次`, icon: 'success' });
        this._load();
      })
      .catch((e) => {
        wx.showToast({ title: e.msg || '记录订阅失败', icon: 'none' });
      })
      .finally(() => this.setData({ granting: false }));
  },
});
