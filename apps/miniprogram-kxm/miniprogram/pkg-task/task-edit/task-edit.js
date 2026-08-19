// pages/task-edit/task-edit.js
// 新增/编辑任务（步骤式表单）：标题 → 时间 → 设置 → 描述 → 确认预览
const { lp, family, getRole, getViewStudent } = require('../../utils/api');
const { fileToBase64, fileUrl, relPath } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');

const SUBJECTS = ['语文', '数学', '英语', '阅读', '作业', '运动'];
const MANAGER_ROLES = ['admin', 'parent', 'family'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    id: '',
    editing: false,
    clone: false,             // 克隆模式：预填源任务内容，提交时创建新任务
    isAdmin: false,
    isManager: false,
    role: 'student',
    childCount: -1,           // 家庭孩子档案数（-1=未加载；家长/家属无孩子档案时禁止派发任务）
    step: 0,               // 0 标题 / 1 时间 / 2 设置 / 3 描述 / 4 确认
    title: '',
    subject: '',
    subjectIndex: -1,
    subjectOptions: SUBJECTS,
    deadline: '',
    startDate: '',
    tagText: '',
    tags: [],
    description: '',
    images: [],
    files: [],
    uploadGrid: { column: 3, width: 200, height: 200 },
    uploadConfig: { sizeType: ['original'] }, // 默认选原图，压缩由后端完成
    checkinType: 'image',
    checkinTypeIndex: 0,
    checkinTypeOptions: [
      { value: 'image', label: '图文打卡', desc: '学生提交图片与文字' },
      { value: 'voice', label: '语音打卡', desc: '学生录制一段语音' },
      { value: 'video', label: '视频打卡', desc: '学生上传一段视频（≤1GB，自动压缩）' },
    ],
    collections: [],
    collectionIndex: -1,
    students: [],
    assigneeIds: [],
    assigneeMap: {},
    previewImages: [],
    assigneeNames: '',
    submitting: false,
  },

  onLoad(options) {
    const id = options.id || '';
    const clone = options.clone === '1';
    const role = getRole();
    const isManager = MANAGER_ROLES.includes(role);
    const today = todayStr();
    this.setData({
      id,
      editing: !!id && !clone,
      clone,
      isAdmin: role === 'admin',
      isManager,
      role,
      // 新增任务时开始/截止日期默认当天
      ...(id && !clone ? {} : { startDate: today, deadline: today }),
    });
    if (isManager) {
      this._loadStudents();
      if (role !== 'admin') this._loadFamilyCheck();
    }
    if (id) this._loadTask(id);
    else this._loadCollections();
  },

  async _loadStudents() {
    try {
      const { list } = await lp.adminStudents();
      this.setData({ students: list || [] });
    } catch (_) {}
  },

  // 完整性核验：家长/家属派发任务前必须已有孩子档案
  async _loadFamilyCheck() {
    try {
      const ctx = await family.context();
      const children = (ctx && ctx.children) || [];
      this.setData({ childCount: children.length });
    } catch (_) {
      this.setData({ childCount: -1 });
    }
  },

  _promptCreateChild() {
    const isParent = this.data.role === 'parent';
    if (isParent) {
      wx.showModal({
        title: '请先创建孩子档案',
        content: '派发任务前需要先创建至少一个孩子档案，现在去创建吗？',
        confirmText: '去创建',
        cancelText: '暂不',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pkg-family/child-edit/child-edit' });
        },
      });
    } else {
      wx.showModal({
        title: '暂无孩子档案',
        content: '家庭中还没有孩子档案，请先请主家长创建孩子档案后再来派发任务。',
        showCancel: false,
        confirmText: '知道了',
      });
    }
  },

  async _loadTask(id) {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await lp.taskDetail(id, getViewStudent());
      const t = res.task || {};
      // 已完成任务仅可查看：学生禁止编辑（家长/家属/管理员不受限）；克隆模式除外（可基于已完成任务新建）
      if (t.task_status === 'done' && !this.data.isManager && !this.data.clone) {
        wx.hideLoading();
        wx.showToast({ title: '任务已完成，仅可查看，禁止编辑', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.setData({
        title: t.title || '',
        subject: t.subject || '',
        subjectIndex: SUBJECTS.indexOf(t.subject),
        deadline: t.deadline || '',
        startDate: t.start_date || '',
        tags: t.tags || [],
        description: t.description || '',
        images: (t.images || []).map(fileUrl),
        files: (t.images || []).map(p => ({ url: fileUrl(p), name: String(p).split('/').pop() || 'img', type: 'image', status: 'done' })),
        checkinType: t.checkin_type || 'image',
        checkinTypeIndex: Math.max(0, this.data.checkinTypeOptions.findIndex(o => o.value === (t.checkin_type || 'image'))),
        assigneeIds: this.data.isManager ? (t.assignee_ids || []).map(x => String(x)) : [],
        assigneeMap: this.data.isManager ? (t.assignee_ids || []).reduce((m, x) => { m[String(x)] = true; return m; }, {}) : {},
      });
      this._loadCollections(t.collection_id);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg, icon: 'none' });
      return;
    }
    wx.hideLoading();
  },

  async _loadCollections(selected) {
    try {
      const res = await lp.collections();
      const collections = Array.isArray(res) ? res : (res && res.list) || [];
      this.setData({
        collections,
        collectionIndex: selected ? collections.findIndex(c => Number(c.collection_id) === Number(selected)) : -1,
      });
    } catch (_) {}
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onSubject(e) {
    const idx = Number(e.detail.value);
    this.setData({ subject: idx >= 0 ? this.data.subjectOptions[idx] : '', subjectIndex: idx });
  },
  onDeadline(e) { this.setData({ deadline: e.detail.value }); },
  onStartDate(e) { this.setData({ startDate: e.detail.value }); },
  onTagInput(e) { this.setData({ tagText: e.detail.value }); },
  addTag() {
    const t = this.data.tagText.trim();
    if (!t) return;
    const tags = [...this.data.tags];
    if (!tags.includes(t)) tags.push(t);
    this.setData({ tags, tagText: '' });
  },
  removeTag(e) {
    const i = Number(e.currentTarget.dataset.index);
    const tags = this.data.tags.filter((_, idx) => idx !== i);
    this.setData({ tags });
  },
  onDesc(e) { this.setData({ description: e.detail.value }); },
  onCollection(e) { this.setData({ collectionIndex: Number(e.detail.value) }); },
  onCheckinType(e) {
    const idx = Number(e.detail.value);
    this.setData({ checkinType: idx >= 0 ? this.data.checkinTypeOptions[idx].value : 'image', checkinTypeIndex: idx });
  },

  // 下一步校验
  async onNext() {
    if (this.data.step === 0) {
      // 完整性核验：家长/家属派发任务前必须已有孩子档案，否则无法下一步
      if (this.data.isManager && this.data.role !== 'admin' && this.data.childCount < 0) {
        await this._loadFamilyCheck();
      }
      if (this.data.isManager && this.data.role !== 'admin' && this.data.childCount === 0) {
        this._promptCreateChild();
        return;
      }
      if (!this.data.title.trim()) {
        wx.showToast({ title: '请填写任务标题', icon: 'none' });
        return;
      }
      if (!this.data.subject) {
        wx.showToast({ title: '请选择科目', icon: 'none' });
        return;
      }
      this.setData({ step: 1 });
      return;
    }
    if (this.data.step === 1) {
      this.setData({ step: 2 });
      return;
    }
    if (this.data.step === 2) {
      this.setData({ step: 3 });
      return;
    }
    if (this.data.step === 3) {
      this._syncPreview();
      this.setData({ step: 4 });
    }
  },

  onPrev() {
    this.setData({ step: Math.max(0, this.data.step - 1) });
  },

  preview(e) {
    const urls = this.data.previewImages.filter(u => !!u);
    if (!urls.length) return;
    const index = Number(e.currentTarget.dataset.index) || 0;
    wx.previewImage({ current: urls[index], urls });
  },

  _syncPreview() {
    this.setData({
      previewImages: this.data.files.filter(f => f.status === 'done' && f.url).map(f => f.url),
      assigneeNames: this.data.assigneeIds
        .map(id => (this.data.students.find(s => String(s.staff_id) === String(id)) || {}).nickname)
        .filter(Boolean)
        .join('、'),
    });
  },

  /** t-upload 选中图片后回调：先挂载占位图，再逐张上传原图（压缩由后端完成），成功后回填远程地址 */
  handleUploadAdd(e) {
    const added = (e.detail && e.detail.files) || [];
    if (!added.length) return;
    const items = added.map(f => ({
      _uid: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: f.name || 'img',
      type: 'image',
      url: f.url,
      status: 'loading',
    }));
    this.setData({ files: this.data.files.concat(items) });
    this._uploadItems(added, items);
  },

  async _uploadItems(added, items) {
    for (let i = 0; i < added.length; i++) {
      const file = added[i];
      const uid = items[i]._uid;
      try {
        const rel = await this._uploadOne(file);
        if (!rel) throw new Error('上传失败');
        const idx = this.data.files.findIndex(f => f._uid === uid);
        if (idx >= 0) {
          this.setData({ [`files[${idx}].url`]: fileUrl(rel), [`files[${idx}].status`]: 'done' });
        }
      } catch (_) {
        const idx = this.data.files.findIndex(f => f._uid === uid);
        if (idx >= 0) this.setData({ [`files[${idx}].status`]: 'failed' });
      }
    }
    this._syncImages();
  },

  async _uploadOne(file) {
    const b64 = await fileToBase64(file.url);
    const up = await lp.upload('tasks', [{ data: b64, contentType: 'image/jpeg', fileName: file.name || 'img.jpg' }]);
    const f = (up.files || [])[0];
    return (f && f.path) || '';
  },

  /** t-upload 删除图片回调 */
  handleUploadRemove(e) {
    const idx = e.detail.index;
    const files = this.data.files.filter((_, i) => i !== idx);
    this.setData({ files });
    this._syncImages();
  },

  _syncImages() {
    this.setData({ images: this.data.files.filter(f => f.status === 'done' && f.url).map(f => relPath(f.url)) });
  },

  toggleAssignee(e) {
    const sid = String(e.currentTarget.dataset.id);
    const assigneeIds = this.data.assigneeIds.includes(sid)
      ? this.data.assigneeIds.filter(x => x !== sid)
      : [...this.data.assigneeIds, sid];
    const assigneeMap = {};
    assigneeIds.forEach(id => { assigneeMap[id] = true; });
    this.setData({ assigneeIds, assigneeMap });
  },

  onSubmit() {
    this._syncImages();
    const { title, subject, deadline, startDate, tags, description, images } = this.data;
    // 完整性核验：家长/家属派发任务前必须已有孩子档案
    if (this.data.isManager && this.data.role !== 'admin' && this.data.childCount === 0) {
      this._promptCreateChild();
      return;
    }
    if (!title.trim()) {
      wx.showToast({ title: '请填写任务标题', icon: 'none' });
      return;
    }
    if (!subject) {
      wx.showToast({ title: '请选择科目', icon: 'none' });
      return;
    }
    if (this.data.isManager && this.data.assigneeIds.length === 0) {
      wx.showToast({ title: '请选择派发学生', icon: 'none' });
      return;
    }
    const collectionId = this.data.collectionIndex >= 0 ? this.data.collections[this.data.collectionIndex].collection_id : 0;
    const payload = {
      title: title.trim(),
      subject,
      deadline,
      start_date: startDate,
      tags,
      description,
      images,
      collection_id: collectionId,
      checkin_type: this.data.checkinType || 'image',
    };
    if (this.data.isManager) payload.assignee_ids = this.data.assigneeIds.map(Number);
    this.setData({ submitting: true });
    const req = this.data.editing ? lp.taskUpdate({ id: this.data.id, ...payload }) : lp.taskCreate(payload);
    req
      .then(() => {
        trackEvent('button_click', this.data.editing ? '编辑任务' : (this.data.clone ? '克隆任务' : '创建任务'));
        wx.showToast({ title: this.data.editing ? '已保存' : (this.data.clone ? '克隆成功' : '创建成功'), icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((e) => wx.showToast({ title: e.msg || '提交失败', icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },
});
