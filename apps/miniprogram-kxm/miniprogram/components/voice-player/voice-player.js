// components/voice-player/voice-player.js
// 语音打卡播放器：播放/暂停 + 进度条 + 时长（wx.createInnerAudioContext，Skyline 可用）
const STORAGE_DOMAIN = 'https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la';

function fmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

Component({
  properties: {
    // 云存储相对路径或完整 URL（相对路径自动拼域名）
    src: { type: String, value: '' },
    // 语音时长（秒）
    duration: { type: Number, value: 0 },
  },
  data: {
    fullSrc: '',
    playing: false,
    current: 0,
    durationText: '0:00',
    currentText: '0:00',
    percent: 0,
  },
  lifetimes: {
    attached() {
      this._ctx = wx.createInnerAudioContext();
      this._ctx.obeyMuteSwitch = false;
      this._ctx.onTimeUpdate(() => {
        const t = Math.floor(this._ctx.currentTime || 0);
        if (t !== this.data.current) {
          const total = Number(this.data.duration) || 0;
          const pct = total > 0 ? Math.min(100, Math.round((t / total) * 100)) : 0;
          this.setData({ current: t, currentText: fmt(t), percent: pct });
        }
      });
      this._ctx.onEnded(() => this.setData({ playing: false, current: 0, currentText: fmt(0), percent: 0 }));
      this._ctx.onError(() => {
        this.setData({ playing: false });
        wx.showToast({ title: '语音播放失败', icon: 'none' });
      });
    },
    detached() {
      if (this._ctx) {
        try { this._ctx.destroy(); } catch (_) {}
      }
    },
  },
  observers: {
    'src, duration'(src, duration) {
      const s = String(src || '');
      const full = /^https?:\/\//i.test(s) ? s : (s ? `${STORAGE_DOMAIN}/${s.replace(/^\/+/, '')}` : '');
      this.setData({
        fullSrc: full,
        playing: false,
        current: 0,
        currentText: fmt(0),
        durationText: fmt(duration),
        percent: 0,
      });
    },
  },
  methods: {
    toggle() {
      if (!this.data.fullSrc) return;
      if (this.data.playing) {
        this._ctx.pause();
        this.setData({ playing: false });
        return;
      }
      this._ctx.src = this.data.fullSrc;
      this._ctx.play();
      this.setData({ playing: true });
    },
  },
});
