// pages/task-detail/task-detail.js
const { lp, getViewStudent, getRole } = require('../../utils/api');
const { fileUrl, previewUrl } = require('../../utils/image');
const { trackEvent } = require('../../utils/tracker');
const { secBadgeMeta } = require('../../utils/display');

const STATUS_TEXT = { todo: '待完成', doing: '进行中', done: '已完成' };
const REVIEW_TEXT = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const REVIEW_LABEL = { pending: '审核说明', approved: '老师点评', rejected: '驳回原因' };
const REVIEW_THEME = {
  pending: { color: '#e37318', bg: '#fdf1e4' },
  approved: { color: '#16a87a', bg: '#e6faf4' },
  rejected: { color: '#f6685d', bg: '#fdeeed' },
};
// 发布/打卡来源：web（Web后台）/ miniprogram（小程序）
const SOURCE_TEXT = { web: 'Web后台', miniprogram: '小程序' };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 打卡日期拆分为 日/月/星期 三段，供卡片头部大号日期块展示
function splitDate(dateStr) {
  if (!dateStr) return { day: '', month: '', week: '' };
  const s = String(dateStr).slice(0, 10);
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return { day: s.slice(8), month: s.slice(5, 7) ? `${Number(s.slice(5, 7))}月` : '', week: '' };
  }
  return { day: String(d.getDate()).padStart(2, '0'), month: `${d.getMonth() + 1}月`, week: WEEKDAYS[d.getDay()] };
}

// 完整时间：YYYY-MM-DD HH:MM:SS（MySQL datetime），ISO 时间补空格
function fmtFull(ts) {
  return String(ts || '').trim().slice(0, 19).replace('T', ' ');
}

Page({
  data: {
    scrollTop: 0,   // 每次进入页面滚动区复位到顶部（新页面不受上一页面滚动位置影响）
    id: '',
    task: null,
    checkins: [],
    statusText: STATUS_TEXT,
    images: [],
    isAdmin: false,
    isManager: false,
    canManage: false,
    canCheckin: true,
    canCopy: false,
    isDone: false,
  },

  onLoad(options) {
    let staff = {};
    try { staff = wx.getStorageSync('lp_staff') || {}; } catch (_) {}
    const role = getRole();
    const isManager = ['admin', 'parent', 'family'].includes(role);
    this.setData({
      id: options.id || '',
      staffId: String(staff.staff_id || ''),
      isAdmin: role === 'admin',
      isManager,
      canCheckin: !isManager,
    });
    trackEvent('page_view', '任务详情', { taskId: options.id || '' });
  },

  onShow() {
    this.setData({ scrollTop: 1 });
    wx.nextTick(() => this.setData({ scrollTop: 0 }));
    if (this.data.id) this._load();
  },

  async _load() {
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const res = await lp.taskDetail(this.data.id, getViewStudent());
      const task = res.task || null;
      const isDone = !!(task && task.task_status === 'done');
      const own = !!(task && String(task.created_by) === this.data.staffId);
      const taskSecMeta = secBadgeMeta(task);
      const checkins = (res.checkins || []).map(c => {
        const st = c.review_status || 'approved';
        const theme = REVIEW_THEME[st] || REVIEW_THEME.approved;
        // 未审核通过（待审核/已驳回）内容脱敏：正文 ****、图片/语音/视频占位，防止未审核信息被截图传播
        const masked = st === 'pending' || st === 'rejected';
        // 内容安全角标：业务已审核通过时展示（安全关闭/失败时无 display 字段 → 空，走旧逻辑）
        const secMeta = masked ? null : secBadgeMeta(c);
        const totalImages = masked ? 0 : (c.images || []).length;
        const dateParts = splitDate(c.checkin_date);
        return {
          ...c,
          masked,
          maskText: st === 'rejected' ? '该打卡未通过审核，内容暂不展示' : '该打卡正在审核中，内容暂不展示',
          secBadge: secMeta ? secMeta.text : '',
          secColor: secMeta ? secMeta.color : '',
          secBg: secMeta ? secMeta.bg : '',
          checkin_note: masked ? '****' : (c.checkin_note || ''),
          // 列表展示用预览图缩略（省流量），lightbox 用原图
          images: masked ? [] : (c.images || []).slice(0, 4).map(p => previewUrl(p)),
          fullImages: masked ? [] : (c.images || []).slice(0, 4).map(fileUrl),
          // 逐张图片内容安全状态（后端派生）：reviewing=检测中→磨砂加锁，ok=正常
          imageStates: masked ? [] : (c.images || []).slice(0, 4).map((p, i) => (c.images_states && c.images_states[i]) || 'ok'),
          totalImages,
          dateDay: dateParts.day,
          dateMonth: dateParts.month,
          dateWeek: dateParts.week,
          submitTime: fmtFull(c.created_at),
          submitter_avatar: fileUrl(c.submitter_avatar || ''),
          submitter_initial: String(c.submitter_name || '').slice(0, 1),
          scoreText: masked ? '' : (Number(c.review_score) > 0 ? `${c.review_score} 分` : ''),
          mediaText: c.checkin_type === 'voice' ? '语音打卡' : (c.checkin_type === 'video' ? '视频打卡' : '图文打卡'),
          sourceText: SOURCE_TEXT[c.source] || (c.source === 'web' ? 'Web后台' : '小程序'),
          reviewText: REVIEW_TEXT[st] || '已通过',
          reviewLabel: REVIEW_LABEL[st] || '审核说明',
          reviewColor: theme.color,
          reviewBg: theme.bg,
          canDelete: !isDone || this.data.isManager,
          voiceUrl: masked ? '' : (c.voice_url ? fileUrl(c.voice_url) : ''),
          videoUrl: masked ? '' : (c.video_url ? fileUrl(c.video_url) : ''),
          videoCover: masked ? '' : (c.video_cover ? fileUrl(c.video_cover) : ''),
        };
      });
      this.setData({
        task,
        checkins,
        images: ((task && task.images) || []).map(fileUrl),
        // 任务图片逐张内容安全状态（reviewing=检测中→磨砂加锁，ok=正常）
        taskImageStates: ((task && task.images) || []).map((p, i) => (task.images_states && task.images_states[i]) || 'ok'),
        isDone,
        creatorName: (task && (task.creator_name || '创建者')),
        creatorAvatar: fileUrl((task && task.creator_avatar) || ''),
        creatorChar: String((task && task.creator_name) || '创').slice(0, 1),
        createdTime: fmtFull(task && task.created_at),
        checkinType: (task && task.checkin_type) || 'image',
        taskSecBadge: taskSecMeta ? taskSecMeta.text : '',
        taskSecTagTheme: taskSecMeta ? taskSecMeta.tagTheme : '',
        sourceText: SOURCE_TEXT[(task && task.source)] || (task && task.source === 'web' ? 'Web后台' : '小程序'),
        // 已完成任务仅可查看：学生隐藏编辑/删除/打卡；家长/家属/管理员不受限
        canManage: this.data.isManager || (own && !isDone),
        canCheckin: !this.data.isManager && !isDone,
        // 复制：可见任务均可复制（后端按 myTaskIds 校验：派发给我/我创建）
        canCopy: !!task,
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' });
      return;
    }
    wx.hideLoading();
  },

  preview(e) {
    const index = Number(e.currentTarget.dataset.index);
    if ((this.data.taskImageStates || [])[index] === 'reviewing') {
      wx.showToast({ title: '内容安全检测中，通过后可查看原图', icon: 'none' });
      return;
    }
    const url = previewUrl(e.currentTarget.dataset.url);
    const urls = this.data.images.map(previewUrl);
    wx.previewImage({ urls, current: url });
  },

  previewCheckin(e) {
    const index = Number(e.currentTarget.dataset.index);
    const cid = String(e.currentTarget.dataset.cid);
    const item = this.data.checkins.find(c => String(c.checkin_id) === cid);
    if ((item && (item.imageStates || [])[index]) === 'reviewing') {
      wx.showToast({ title: '内容安全检测中，通过后可查看原图', icon: 'none' });
      return;
    }
    const urls = ((item && item.fullImages) || []).map(previewUrl);
    const url = urls[index];
    if (!url) return;
    wx.previewImage({ urls, current: url });
  },

  onFinish() {
    wx.showModal({
      title: '确认完成？',
      content: '任务将标记为已完成（需至少打卡 1 次）',
      confirmText: '完成',
      cancelText: '再想想',
      success: (r) => {
        if (!r.confirm) return;
        lp.taskStatus({ id: this.data.id, status: 'done' })
          .then(() => { trackEvent('button_click', '完成任务', { taskId: this.data.id }); wx.showToast({ title: '太棒了！', icon: 'success' }); this._load(); })
          .catch((e) => wx.showToast({ title: e.msg, icon: 'none' }));
      },
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除任务？',
      content: '将一并删除该任务下的打卡记录与图片，不可恢复',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: (r) => {
        if (!r.confirm) return;
        lp.taskDelete(this.data.id)
          .then(() => { trackEvent('button_click', '删除任务', { taskId: this.data.id }); wx.showToast({ title: '已删除', icon: 'success' }); setTimeout(() => wx.navigateBack(), 600); })
          .catch((e) => wx.showToast({ title: e.msg, icon: 'none' }));
      },
    });
  },

  onEdit() {
    trackEvent('button_click', '编辑任务入口', { taskId: this.data.id });
    wx.navigateTo({ url: `/pkg-task/task-edit/task-edit?id=${this.data.id}` });
  },

  onCheckin() {
    if (this.data.task.task_status === 'done') {
      wx.showToast({ title: '任务已完成，不能打卡', icon: 'none' });
      return;
    }
    trackEvent('button_click', '任务-去打卡', { taskId: this.data.id });
    wx.navigateTo({ url: `/pkg-task/checkin/checkin?taskId=${this.data.id}` });
  },

  onCopy() {
    // 克隆 = 把源任务内容带入新增任务表单，用户可修改后再创建
    trackEvent('button_click', '克隆任务', { taskId: this.data.id });
    wx.navigateTo({ url: `/pkg-task/task-edit/task-edit?id=${this.data.id}&clone=1` });
  },

  onDeleteCheckin(e) {
    const cid = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除打卡？',
      content: '删除后不可恢复',
      success: (r) => {
        if (!r.confirm) return;
        lp.checkinDelete(cid)
          .then(() => { trackEvent('button_click', '删除打卡', { checkinId: cid }); wx.showToast({ title: '已删除', icon: 'success' }); this._load(); })
          .catch((e2) => wx.showToast({ title: e2.msg, icon: 'none' }));
      },
    });
  },
});
