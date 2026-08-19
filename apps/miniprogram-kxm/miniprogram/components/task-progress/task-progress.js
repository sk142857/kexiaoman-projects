// components/task-progress/task-progress.js
// 带步骤的任务进度条：5 步，已完成步骤绿色 / 进行中步骤红色 / 未开始灰色，百分比放在末尾
const DEFAULT_STEPS = 5;
const DONE_COLOR = '#52c41a';
const CURRENT_COLOR = '#ff4d4f';

Component({
  properties: {
    percent: { type: Number, value: 1 },
    steps: { type: Number, value: DEFAULT_STEPS },
    showText: { type: Boolean, value: true },
    height: { type: Number, value: 12 },
  },

  data: {
    segments: [],
    percentText: '',
  },

  observers: {
    'percent, steps': function (percent, steps) {
      const total = Math.max(1, Math.min(10, Number(steps) || DEFAULT_STEPS));
      const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      const stepSize = 100 / total;
      const segments = [];
      for (let i = 0; i < total; i++) {
        const filled = Math.max(0, Math.min(1, (p - i * stepSize) / stepSize));
        let color = 'transparent';
        if (filled >= 1) color = DONE_COLOR;
        else if (filled > 0) color = CURRENT_COLOR;
        segments.push({ fill: Math.round(filled * 100), color });
      }
      this.setData({ segments, percentText: `${p}%` });
    },
  },
});
