// pages/children/children.js
// 孩子档案列表：点卡片弹出原生 action-sheet 提供操作菜单（设为默认/编辑/复制码/重新生成/删除）
const { family, getViewStudent, setViewStudent } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const GRADE_CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    loading: true,
    children: [],
    canManage: false,   // 主家长/管理员：可编辑/邀请码/删除；家属仅查看 + 切换默认
    currentId: '',
    sheetVisible: false,
    sheetItems: [],
    sheetChild: null,
  },

  onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    trackEvent('page_view', '孩子档案');
    this._load();
  },

  async _load() {
    const currentId = getViewStudent();
    this.setData({ currentId });
    try {
      const ctx = await family.context();
      const role = ctx.role;
      const children = (ctx.children || []).map((c, idx) => {
        // 默认值展示逻辑：无显式默认孩子时，首个孩子即为有效默认（与首页展示保持一致）
        const effectiveCurrent = currentId || ((ctx.children || [])[0] && (ctx.children || [])[0].student_staff_id);
        return {
          ...c,
          avatarChar: String(c.child_name || '孩').charAt(0),
          gradeText: GRADE_CN[c.grade] ? `${GRADE_CN[c.grade]}（${c.class_no}）` : (c.grade ? `${c.grade}（${c.class_no}）` : ''),
          genderText: c.gender === 1 ? '男生' : c.gender === 2 ? '女生' : '保密',
          isCurrent: !!c.student_staff_id && String(c.student_staff_id) === String(effectiveCurrent),
        };
      });
      this.setData({ children, canManage: role === 'parent' || role === 'admin', loading: false });
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // 右下角悬浮按钮：新增孩子
  goAdd() {
    trackEvent('menu_click', '孩子档案-新增');
    wx.navigateTo({ url: '/pkg-family/child-edit/child-edit?mode=add' });
  },

  // 点击卡片 → 弹出操作菜单（底部弹层，复制邀请码选项右侧展示邀请码）
  onCardTap(e) {
    const childId = String(e.currentTarget.dataset.id);
    const child = this.data.children.find(c => c.child_id === childId);
    if (!child) return;

    const items = [];
    const actions = [];

    if (!child.isCurrent && child.student_staff_id) {
      items.push({ label: '设为默认孩子' });
      actions.push(() => this._setCurrent(child));
    }
    if (this.data.canManage) {
      items.push({ label: '编辑档案' });
      actions.push(() => this._edit(child));
      const codeText = child.invite_code ? `（${child.invite_code}）` : '（暂无邀请码）';
      items.push({ label: `复制邀请码${codeText}` });
      actions.push(() => this._copyCode(child));
      items.push({ label: '重新生成邀请码' });
      actions.push(() => this._regen(child));
      items.push({ label: '删除档案', danger: true });
      actions.push(() => this._delete(child));
    }

    if (!items.length) return;
    this._sheetActions = actions;
    this.setData({ sheetVisible: true, sheetItems: items, sheetChild: child });
  },

  onSheetItem(e) {
    const idx = Number(e.currentTarget.dataset.index);
    this.setData({ sheetVisible: false });
    const fn = (this._sheetActions || [])[idx];
    if (fn) fn();
  },

  closeSheet() {
    this.setData({ sheetVisible: false });
  },

  noop() {},

  // 设为默认孩子（只支持一个默认，首页展示该孩子数据）
  _setCurrent(child) {
    setViewStudent(child.student_staff_id);
    trackEvent('menu_click', '孩子档案-设为默认', { staffId: child.student_staff_id });
    this.setData({ currentId: String(child.student_staff_id) });
    wx.showToast({ title: `已将「${child.child_name}」设为默认孩子`, icon: 'none' });
  },

  // 编辑档案 → 跳转新增/编辑孩子页完成编辑
  _edit(child) {
    trackEvent('menu_click', '孩子档案-编辑', { childId: child.child_id });
    wx.navigateTo({ url: `/pkg-family/child-edit/child-edit?mode=edit&id=${child.child_id}` });
  },

  _copyCode(child) {
    if (!child.invite_code) {
      wx.showToast({ title: '暂无邀请码，可重新生成', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: child.invite_code,
      success: () => wx.showToast({ title: '已复制，可发给孩子绑定', icon: 'none' }),
    });
  },

  // 重新生成学生邀请码
  _regen(child) {
    wx.showModal({
      title: '重新生成邀请码',
      content: `将为「${child.child_name}」生成新的孩子邀请码，旧码作废。若孩子已绑定，重新绑定需用新码。`,
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await family.childInvite(child.child_id);
          trackEvent('button_click', '孩子档案-重生成邀请码', { childId: child.child_id });
          wx.showToast({ title: `新邀请码：${res.invite_code}`, icon: 'none' });
          this._load();
        } catch (e) {
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },

  // 删除孩子档案
  _delete(child) {
    wx.showModal({
      title: '删除孩子档案',
      content: `删除「${child.child_name}」的档案后，其孩子账号与邀请码将作废，孩子需重新绑定。确定删除？`,
      confirmColor: '#ff4d4f',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await family.childDelete(child.child_id);
          trackEvent('button_click', '孩子档案-删除', { childId: child.child_id });
          if (String(child.student_staff_id) === String(this.data.currentId)) {
            setViewStudent('');
            this.setData({ currentId: '' });
          }
          wx.showToast({ title: '已删除', icon: 'success' });
          this._load();
        } catch (e) {
          wx.showToast({ title: e.msg || '操作失败', icon: 'none' });
        }
      },
    });
  },
});
