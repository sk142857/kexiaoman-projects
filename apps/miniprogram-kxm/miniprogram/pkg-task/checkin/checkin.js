// pages/checkin/checkin.js
// 任务打卡（步骤式表单）：打卡内容 → 打卡媒体
// 打卡方式由任务决定：image 图文（备注+图片）/ voice 语音（备注+录音）/ video 视频（备注+视频，≤1GB）
const { lp } = require('../../utils/api');
const { chooseAndUploadImages, fileUrl, relPath } = require('../../utils/image');
const voice = require('../utils/voice');
const video = require('../utils/video');
const { trackEvent } = require('../../utils/tracker');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    taskId: '',
    taskTitle: '',
    checkinType: 'image',
    step1Title: '打卡图片',
    minDate: '2000-01-01', // 可打卡最早日期：任务开始日期（未设置则放开）
    maxDate: todayStr(),   // 可打卡最晚日期：今天与任务截止日期取早
    step: 0,               // 0 打卡内容 / 1 打卡媒体
    date: todayStr(),
    note: '',
    images: [],
    // 语音打卡状态：idle 未录 / recording 录音中 / recorded 已录音
    voiceState: 'idle',
    recordingMs: 0,
    recordingMsText: '0:00',
    voiceTempPath: '',
    voiceDuration: 0,
    // 视频打卡状态：idle 未选 / chosen 已选
    videoState: 'idle',
    videoTempPath: '',
    videoDuration: 0,
    videoSize: 0,
    videoSizeText: '',
    submitting: false,
  },

  observers: {
    recordingMs(ms) {
      const s = Math.floor((Number(ms) || 0) / 1000);
      const m = Math.floor(s / 60);
      const r = s % 60;
      this.setData({ recordingMsText: `${m}:${String(r).padStart(2, '0')}` });
    },
  },

  onLoad(options) {
    this.setData({ taskId: options.taskId || '' });
    trackEvent('page_view', '打卡页', { taskId: options.taskId || '' });
    this._loadTitle(options.taskId);
    // 录音事件统一绑定（惰性单例录音器，避免重复注册）
    voice.onStop((res) => {
      this._clearRecTimer();
      this.setData({
        voiceState: 'recorded',
        voiceTempPath: res.tempFilePath || '',
        voiceDuration: Math.max(1, Math.round((res.duration || 0) / 1000)),
        recordingMs: 0,
      });
    });
    voice.onError(() => {
      this._clearRecTimer();
      this.setData({ voiceState: 'idle', recordingMs: 0 });
      wx.showToast({ title: '录音失败，请重试', icon: 'none' });
    });
  },

  onUnload() {
    // 清理录音、录音计时器与本地试听
    this._clearRecTimer();
    if (this.data.voiceState === 'recording') {
      try { voice.stop(); } catch (_) {}
    }
    if (this._previewCtx) {
      try { this._previewCtx.destroy(); } catch (_) {}
    }
  },

  async _loadTitle(taskId) {
    try {
      const res = await lp.taskDetail(taskId);
      const t = res.task;
      if (!t) return;
      const today = todayStr();
      const start = String(t.start_date || '').slice(0, 10);
      const deadline = String(t.deadline || '').slice(0, 10);
      // 截止日期与今天取早；开始日期放开到 2000 年兜底
      const minDate = start || '2000-01-01';
      const maxDate = deadline && deadline < today ? deadline : today;
      const checkinType = t.checkin_type === 'voice' ? 'voice' : (t.checkin_type === 'video' ? 'video' : 'image');
      this.setData({
        taskTitle: t.title,
        checkinType,
        step1Title: checkinType === 'voice' ? '语音打卡' : (checkinType === 'video' ? '视频打卡' : '打卡图片'),
        minDate,
        maxDate,
        // 当前默认日期超出可选范围时回落到上限
        date: this.data.date > maxDate ? maxDate : this.data.date,
      });
    } catch (_) {}
  },

  onDate(e) { this.setData({ date: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },

  _dateValid() {
    const d = this.data.date;
    if (!d) return false;
    return d >= this.data.minDate && d <= this.data.maxDate;
  },

  onNext() {
    if (!this._dateValid()) {
      wx.showToast({ title: '请选择有效打卡日期', icon: 'none' });
      return;
    }
    this.setData({ step: 1 });
  },

  onPrev() {
    this.setData({ step: 0 });
  },

  // ==================== 图文打卡 ====================
  addImages() {
    chooseAndUploadImages(9, 'tasks', this.data.images)
      .then((paths) => this.setData({ images: [...this.data.images, ...paths.map(fileUrl)] }))
      .catch(() => {});
  },
  previewImage(e) {
    const urls = this.data.images;
    if (!urls.length) return;
    const index = Number(e.currentTarget.dataset.index) || 0;
    wx.previewImage({ current: urls[index], urls });
  },
  removeImage(e) {
    const i = Number(e.currentTarget.dataset.index);
    this.setData({ images: this.data.images.filter((_, idx) => idx !== i) });
  },

  // ==================== 语音打卡 ====================
  // RecorderManager 无 onTimeUpdate，录音时长用定时器自增
  _startRecTimer() {
    this._clearRecTimer();
    this._recTimer = setInterval(() => {
      this.setData({ recordingMs: (this.data.recordingMs || 0) + 1000 });
    }, 1000);
  },
  _clearRecTimer() {
    if (this._recTimer) {
      clearInterval(this._recTimer);
      this._recTimer = null;
    }
  },
  onMicTap() {
    if (this.data.voiceState === 'recording') {
      voice.stop();
      return;
    }
    if (this.data.voiceState === 'idle') {
      this.setData({ voiceState: 'recording', recordingMs: 0 });
      this._startRecTimer();
      voice.start();
    }
  },
  reRecord() {
    this.setData({ voiceState: 'idle', voiceTempPath: '', voiceDuration: 0, recordingMs: 0 });
  },
  onPlayPreview() {
    if (!this.data.voiceTempPath) return;
    if (this._previewCtx) {
      try { this._previewCtx.destroy(); } catch (_) {}
    }
    this._previewCtx = wx.createInnerAudioContext();
    this._previewCtx.obeyMuteSwitch = false;
    this._previewCtx.src = this.data.voiceTempPath;
    this._previewCtx.play();
  },

  // ==================== 视频打卡 ====================
  onChooseVideo() {
    video.chooseVideo()
      .then((v) => {
        if (!v) return;
        this.setData({
          videoState: 'chosen',
          videoTempPath: v.tempFilePath,
          videoDuration: v.duration,
          videoSize: v.size,
          videoSizeText: video.formatSize(v.size),
        });
      })
      .catch(() => {});
  },
  onRemoveVideo() {
    this.setData({ videoState: 'idle', videoTempPath: '', videoDuration: 0, videoSize: 0, videoSizeText: '' });
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (!this._dateValid()) {
      wx.showToast({ title: '请选择有效打卡日期', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const submit = async () => {
      if (this.data.checkinType === 'video') {
        // 视频打卡：必须已选择视频（≤1GB），上传并登记后再提交
        if (this.data.videoState !== 'chosen' || !this.data.videoTempPath) {
          wx.showToast({ title: '请先选择视频', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '上传视频中', mask: true });
        const { path, duration } = await video.uploadVideo(this.data.videoTempPath, this.data.videoDuration, this.data.videoSize);
        wx.hideLoading();
        return lp.checkinCreate({
          taskId: this.data.taskId,
          date: this.data.date,
          note: this.data.note,
          videoUrl: path,
          videoDuration: duration,
        });
      }
      if (this.data.checkinType === 'voice') {
        // 语音打卡：必须已录音，上传后再提交
        if (this.data.voiceState !== 'recorded') {
          wx.showToast({ title: '请先录制语音', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '上传语音中', mask: true });
        const { path, duration } = await voice.uploadVoice(this.data.voiceTempPath, this.data.voiceDuration * 1000);
        wx.hideLoading();
        return lp.checkinCreate({
          taskId: this.data.taskId,
          date: this.data.date,
          note: this.data.note,
          voiceUrl: path,
          voiceDuration: duration,
        });
      }
      // 图文打卡：备注 + 图片
      return lp.checkinCreate({
        taskId: this.data.taskId,
        date: this.data.date,
        note: this.data.note,
        images: this.data.images.map(relPath),
      });
    };
    submit()
      .then(() => {
        trackEvent('button_click', this.data.checkinType === 'voice' ? '语音打卡' : (this.data.checkinType === 'video' ? '视频打卡' : '任务打卡'), { taskId: this.data.taskId });
        wx.showToast({ title: '打卡成功，等待老师审核', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      })
      .catch((e) => {
        wx.hideLoading();
        wx.showToast({ title: e.msg || '打卡失败', icon: 'none' });
      })
      .finally(() => this.setData({ submitting: false }));
  },
});
