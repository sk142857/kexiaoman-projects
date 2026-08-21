// pages/child-edit/child-edit.js
// 孩子档案新增/编辑（主家长）：步骤式表单（基本信息 → 年级班级 → 确认保存），字典选项用卡片风格
const { family } = require('../../utils/api');
const { trackEvent } = require('../../utils/tracker');

const GRADES = [
  { value: 1, label: '一年级' }, { value: 2, label: '二年级' },
  { value: 3, label: '三年级' }, { value: 4, label: '四年级' },
  { value: 5, label: '五年级' }, { value: 6, label: '六年级' },
];
const CLASSES = Array.from({ length: 35 }, (_, i) => ({ value: i + 1, label: `${i + 1}班` }));
const GENDERS = [
  { value: 0, label: '保密' },
  { value: 1, label: '男生' },
  { value: 2, label: '女生' },
];
const GENDER_TEXT = { 0: '保密', 1: '男生', 2: '女生' };

Page({
  data: {
    mode: 'add',
    childId: '',
    step: 0,               // 0 基本信息 / 1 年级班级 / 2 确认保存
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
    genders: GENDERS,
    genderText: '未知',
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
      const gi = GRADES.findIndex(g => g.value === Number(child.grade));
      const ci = CLASSES.findIndex(c => c.value === Number(child.class_no));
      this.setData({
        form: {
          child_name: child.child_name || '',
          gender: child.gender || 0,
          birth_date: child.birth_date || '',
          school_name: child.school_name || '',
          grade: child.grade || 0,
          class_no: child.class_no || 0,
        },
        genderText: GENDER_TEXT[child.gender] || '未知',
        gradeIndex: gi,
        classIndex: ci,
      });
      this._updatePreview(gi, ci);
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
    }
  },

  onName(e) { this.setData({ 'form.child_name': e.detail.value }); },
  onSchool(e) { this.setData({ 'form.school_name': e.detail.value }); },
  onGender(e) {
    const v = Number(e.currentTarget.dataset.v);
    this.setData({ 'form.gender': v, genderText: GENDER_TEXT[v] || '未知' });
  },
  onBirth(e) { this.setData({ 'form.birth_date': e.detail.value }); },
  onGrade(e) {
    const v = Number(e.currentTarget.dataset.value);
    const idx = GRADES.findIndex(g => g.value === v);
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

  // 下一步校验
  onNext() {
    if (this.data.step === 0) {
      if (!(this.data.form.child_name || '').trim()) {
        wx.showToast({ title: '请填写孩子姓名', icon: 'none' });
        return;
      }
      this.setData({ step: 1 });
      return;
    }
    if (this.data.step === 1) {
      const f = this.data.form;
      if (!Number.isInteger(Number(f.grade)) || Number(f.grade) < 1 || Number(f.grade) > 6) {
        wx.showToast({ title: '请选择年级', icon: 'none' });
        return;
      }
      if (!Number.isInteger(Number(f.class_no)) || Number(f.class_no) < 1 || Number(f.class_no) > 35) {
        wx.showToast({ title: '请选择班级', icon: 'none' });
        return;
      }
      this.setData({ step: 2 });
    }
  },

  onPrev() {
    this.setData({ step: Math.max(0, this.data.step - 1) });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const f = this.data.form;
    const name = (f.child_name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写孩子姓名', icon: 'none' });
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
