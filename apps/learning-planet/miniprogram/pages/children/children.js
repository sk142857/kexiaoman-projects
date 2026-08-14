// pages/children/children.js
// 孩子档案列表（主家长）：维护孩子档案 + 学生邀请码
const { family } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const GRADE_CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };

Page({
  data: {
    loading: true,
    children: [],
  },

  onShow() {
    trackEvent('page_view', '孩子档案');
    this._load();
  },

  async _load() {
    try {
      const ctx = await family.context();
      const children = (ctx.children || []).map(c => ({
        ...c,
        avatarChar: String(c.child_name || '孩').charAt(0),
        gradeText: GRADE_CN[c.grade] ? `${GRADE_CN[c.grade]}（${c.class_no}）` : (c.grade ? `${c.grade}（${c.class_no}）` : ''),
        genderText: c.gender === 1 ? '男' : c.gender === 2 ? '女' : '未知',
      }));
      this.setData({ children, loading: false });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  goAdd() {
    trackEvent('menu_click', '孩子档案-新增');
    wx.navigateTo({ url: '/pages/child-edit/child-edit?mode=add' });
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    trackEvent('menu_click', '孩子档案-编辑', { childId: id });
    wx.navigateTo({ url: `/pages/child-edit/child-edit?mode=edit&id=${id}` });
  },

  onCopy(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制，可发给孩子绑定', icon: 'none' }),
    });
  },

  // 重新生成学生邀请码
  onRegen(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '该孩子';
    wx.showModal({
      title: '重新生成邀请码',
      content: `将为「${name}」生成新的学生邀请码，旧码作废。若孩子已绑定，重新绑定需用新码。`,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await family.childInvite(id);
          trackEvent('button_click', '孩子档案-重生成邀请码', { childId: id });
          wx.showToast({ title: `新邀请码：${res.invite_code}`, icon: 'none' });
          this._load();
        } catch (e) {
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '该孩子';
    wx.showModal({
      title: '删除孩子档案',
      content: `删除「${name}」的档案后，其学生账号与邀请码将作废，孩子需重新绑定。确定删除？`,
      confirmColor: '#ff4d4f',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await family.childDelete(id);
          trackEvent('button_click', '孩子档案-删除', { childId: id });
          wx.showToast({ title: '已删除', icon: 'success' });
          this._load();
        } catch (e) {
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
