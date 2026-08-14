// pages/task-edit/task-edit.js
const { lp, getRole, getViewStudent } = require('../../utils/api');
const { compressImage, fileToBase64, fileUrl, relPath } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');

const SUBJECTS = ['语文', '数学', '英语', '阅读', '作业', '运动'];
const MANAGER_ROLES = ['admin', 'parent', 'family'];

Page({
  data: {
    id: '',
    editing: false,
    isAdmin: false,
    isManager: false,
    title: '',
    subject: '',
    subjectOptions: SUBJECTS,
    subjectIndex: -1,
    deadline: '',
    startDate: '',
    tagText: '',
    tags: [],
    description: '',
    images: [],
    files: [],
    uploadGrid: { column: 3, width: 200, height: 200 },
    collections: [],
    collectionIndex: -1,
    students: [],
    assigneeIds: [],
    assigneeMap: {},
    submitting: false,
  },

  onLoad(options) {
    const id = options.id || '';
    const role = getRole();
    const isManager = MANAGER_ROLES.includes(role);
    this.setData({ id, editing: !!id, isAdmin: role === 'admin', isManager });
    if (isManager) this._loadStudents();
    if (id) this._loadTask(id);
    else this._loadCollections();
  },

  async _loadStudents() {
    try {
      const { list } = await lp.adminStudents();
      this.setData({ students: list || [] });
    } catch (_) {}
  },

  async _loadTask(id) {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await lp.taskDetail(id, getViewStudent());
      const t = res.task || {};
      // 已完成任务仅可查看：学生禁止编辑（家长/家属/管理员不受限）
      if (t.task_status === 'done' && !this.data.isManager) {
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
    const i = Number(e.detail.value);
    this.setData({ subjectIndex: i, subject: SUBJECTS[i] || '' });
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

  /** t-upload 选中图片后回调：先挂载占位图，再逐张压缩上传，成功后回填远程地址 */
  handleUploadAdd(e) {
    const added = (e.detail && e.detail.files) || [];
    if (!added.length) return;
    const items = added.map(f => ({ name: f.name || 'img', type: 'image', url: f.url, status: 'loading' }));
    this.setData({ files: this.data.files.concat(items) });
    this._uploadItems(added);
  },

  async _uploadItems(added) {
    for (const file of added) {
      try {
        const rel = await this._uploadOne(file);
        if (!rel) throw new Error('上传失败');
        const idx = this.data.files.findIndex(f => f.name === file.name);
        if (idx >= 0) {
          this.setData({ [`files[${idx}].url`]: fileUrl(rel), [`files[${idx}].status`]: 'done' });
        }
      } catch (_) {
        const idx = this.data.files.findIndex(f => f.name === file.name);
        if (idx >= 0) this.setData({ [`files[${idx}].status`]: 'failed' });
      }
    }
    this._syncImages();
  },

  async _uploadOne(file) {
    const compressed = await compressImage(file.url);
    const b64 = await fileToBase64(compressed);
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
    };
    if (this.data.isManager) payload.assignee_ids = this.data.assigneeIds.map(Number);
    this.setData({ submitting: true });
    const req = this.data.editing ? lp.taskUpdate({ id: this.data.id, ...payload }) : lp.taskCreate(payload);
    req
      .then(() => {
        trackEvent('button_click', this.data.editing ? '编辑任务' : '创建任务');
        wx.showToast({ title: this.data.editing ? '已保存' : '创建成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((e) => wx.showToast({ title: e.msg || '提交失败', icon: 'none' }))
      .finally(() => this.setData({ submitting: false }));
  },
});
