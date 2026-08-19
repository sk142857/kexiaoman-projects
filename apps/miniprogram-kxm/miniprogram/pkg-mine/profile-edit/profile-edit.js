// pages/profile-edit/profile-edit.js
// 编辑个人资料：头像（原生 chooseAvatar 组件）+ 昵称；用户ID 只读展示
const { lp } = require('../../utils/api');
const { uploadImageFile, fileUrl } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');

Page({
  data: {
    nickname: '',
    avatar: '',            // 已保存头像相对路径
    avatarUrl: '',         // 已保存头像完整 URL
    tempAvatarPath: '',    // 本次选中的临时头像路径（未上传）
    avatarChar: '学',
    staffId: '',
    saving: false,
  },

  onLoad() {
    trackEvent('page_view', '编辑个人资料');
  },

  onShow() {
    this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const profile = await lp.profile();
      const s = (profile && profile.staff) || {};
      this.setData({
        nickname: s.nickname || '',
        avatar: s.avatar || '',
        avatarUrl: fileUrl(s.avatar || ''),
        tempAvatarPath: '',
        avatarChar: String(s.nickname || '学').charAt(0),
        staffId: String(s.staff_id || ''),
      });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
    wx.hideLoading();
  },

  // 原生头像选择组件：e.detail.avatarUrl 为临时文件路径
  onChooseAvatar(e) {
    const path = e.detail && e.detail.avatarUrl;
    if (!path) return;
    this.setData({ tempAvatarPath: path });
  },

  onNick(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onSave() {
    if (this.data.saving) return;
    const n = (this.data.nickname || '').trim();
    if (!n) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      let avatar = this.data.avatar;
      // 有新的临时头像则先上传（客户端压缩 + 直传云存储）
      if (this.data.tempAvatarPath) {
        avatar = await uploadImageFile(this.data.tempAvatarPath, 'avatar');
      }
      await lp.updateProfile({ nickname: n, avatar });
      const s = wx.getStorageSync('lp_staff') || {};
      wx.setStorageSync('lp_staff', { ...s, nickname: n, avatar });
      wx.hideLoading();
      wx.showToast({ title: '已更新', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },
});
