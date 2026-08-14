// pages/child-edit/child-edit.js
// 孩子档案新增/编辑（主家长）
const { family } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const GRADES = [
  { value: 1, label: '一年级' }, { value: 2, label: '二年级' },
  { value: 3, label: '三年级' }, { value: 4, label: '四年级' },
  { value: 5, label: '五年级' }, { value: 6, label: '六年级' },
];
const CLASSES = Array.from({ length: 35 }, (_, i) => ({ value: i + 1, label: `${i + 1}班` }));

Page({
  data: {
    mode: 'add',
    childId: '',
    loading: false,
    submitting: false,
    form: {
      child_name: '',
      gender: 0,
      birth_date: '',
      school_name: '',
      grade: 0,
      class_no: 0,
    },
    grades: GRADES,
    classes: CLASSES,
    gradeIndex: -1,
    classIndex: -1,
    today: '',
    previewText: '',
  },

  onLoad(options) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    this.setData({ today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` });
    const mode = options && options.mode === 'edit' ? 'edit' : 'add';
    const childId = (options && options.id) || '';
    this.setData({ mode, childId });
    wx.setNavigationBarTitle({ title: mode === 'edit' ? '编辑孩子' : '添加孩子' });
    if (mode === 'edit' && childId) this._loadDetail(childId);
    trackEvent('page_view', mode === 'edit' ? '编辑孩子档案' : '添加孩子档案');
  },

  async _loadDetail(childId) {
    try {
      const ctx = await family.context();
      const child = (ctx.children || []).find(c => c.child_id === String(childId));
      if (!child) {
        wx.showToast({ title: '未找到孩子档案', icon: 'none' });
        return;
      }
      this.setData({
        form: {
          child_name: child.child_name || '',
          gender: child.gender || 0,
          birth_date: child.birth_date || '',
          school_name: child.school_name || '',
          grade: child.grade || 0,
          class_no: child.class_no || 0,
        },
        gradeIndex: GRADES.findIndex(g => g.value === Number(child.grade)),
        classIndex: CLASSES.findIndex(c => c.value === Number(child.class_no)),
      });
      const gi = GRADES.findIndex(g => g.value === Number(child.grade));
      const ci = CLASSES.findIndex(c => c.value === Number(child.class_no));
      this._updatePreview(gi, ci);
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
  },

  onName(e) { this.setData({ 'form.child_name': e.detail.value }); },
  onSchool(e) { this.setData({ 'form.school_name': e.detail.value }); },
  onGender(e) { this.setData({ 'form.gender': Number(e.currentTarget.dataset.v) }); },
  onBirth(e) { this.setData({ 'form.birth_date': e.detail.value }); },
  onGrade(e) {
    const idx = Number(e.detail.value);
    this._updatePreview(idx, this.data.classIndex);
  },
  onClass(e) {
    const idx = Number(e.detail.value);
    this._updatePreview(this.data.gradeIndex, idx);
  },

  _updatePreview(gradeIdx, classIdx) {
    const g = gradeIdx >= 0 && gradeIdx < GRADES.length ? GRADES[gradeIdx] : null;
    const c = classIdx >= 0 && classIdx < CLASSES.length ? CLASSES[classIdx] : null;
    this.setData({
      gradeIndex: gradeIdx,
      classIndex: classIdx,
      'form.grade': g ? g.value : 0,
      'form.class_no': c ? c.value : 0,
      previewText: g && c ? `${g.label.replace(/年级$/, '')}（${c.value}）` : '',
    });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const f = this.data.form;
    const name = (f.child_name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写孩子姓名', icon: 'none' });
      return;
    }
    if (!Number.isInteger(Number(f.grade)) || Number(f.grade) < 1 || Number(f.grade) > 6) {
      wx.showToast({ title: '请选择年级', icon: 'none' });
      return;
    }
    if (!Number.isInteger(Number(f.class_no)) || Number(f.class_no) < 1 || Number(f.class_no) > 35) {
      wx.showToast({ title: '请选择班级', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const payload = {
        child_name: name,
        gender: Number(f.gender) || 0,
        birth_date: f.birth_date || '',
        school_name: f.school_name || '',
        grade: Number(f.grade),
        class_no: Number(f.class_no),
      };
      if (this.data.mode === 'edit') {
        await family.childUpdate({ child_id: this.data.childId, ...payload });
        trackEvent('button_click', '孩子档案-保存编辑', { childId: this.data.childId });
        wx.showToast({ title: '已保存', icon: 'success' });
      } else {
        const res = await family.childCreate(payload);
        trackEvent('button_click', '孩子档案-添加');
        wx.showToast({ title: `已添加，邀请码 ${res.invite_code || ''}`, icon: 'none' });
      }
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '保存失败', icon: 'none' });
    }
    wx.hideLoading();
    this.setData({ submitting: false });
  },
});
