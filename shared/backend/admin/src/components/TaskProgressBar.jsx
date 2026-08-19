import React, { useLayoutEffect, useRef, useState } from 'react';
import { Progress } from 'antd';

// 任务进度条：AntD steps 样式（仅取视觉，不表示真实步骤数）。
// 段宽/段间距固定，按容器实际宽度反推段数（steps ≈ 宽度/单位），让进度条铺满整行、不缩在一边。
// 已完成段按进度分档渐变着色（低-红橙 / 中-黄橙 / 高-浅绿深绿），未完成段使用灰色轨道。

const LEVELS = [
  { max: 33, gradient: { from: '#ff7875', to: '#ffa940' } },
  { max: 66, gradient: { from: '#ffa940', to: '#f6c343' } },
  { max: 101, gradient: { from: '#95de64', to: '#52c41a' } },
];

/** 任务进度渐变配色：按进度分档返回 AntD 线性渐变 { from, to } */
export const taskProgressColor = (progress) => {
  const p = Number(progress) || 0;
  const item = LEVELS.find((l) => p < l.max) || LEVELS[LEVELS.length - 1];
  return item.gradient;
};

const DEFAULT_STEP_WIDTH = 16; // 每段宽度(px)
const STEP_GAP = 2; // 段间距(px，AntD steps 固定)

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** 在 from -> to 之间按 t(0~1) 线性插值颜色 */
const lerpColor = (from, to, t) => {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const mix = (i) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
};

/** 生成 count 段从 from 渐变到 to 的配色数组（未完成段由 AntD 灰色轨道覆盖，无需处理） */
const gradientColors = (count, from, to) => {
  const colors = [];
  for (let i = 0; i < count; i++) {
    colors.push(lerpColor(from, to, count <= 1 ? 0 : i / (count - 1)));
  }
  return colors;
};

const TaskProgressBar = ({
  percent = 0,
  strokeWidth = 10,
  stepWidth = DEFAULT_STEP_WIDTH,
  style,
  className,
}) => {
  const ref = useRef(null);
  const [steps, setSteps] = useState(8);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const compute = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) {
        setSteps(Math.max(4, Math.round((w + STEP_GAP) / (stepWidth + STEP_GAP)) - 1));
      }
    };
    compute();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(compute);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [stepWidth]);

  const { from, to } = taskProgressColor(percent);
  const colors = gradientColors(steps, from, to);

  return (
    <div ref={ref} className={className} style={{ display: 'block', ...style }}>
      <Progress
        percent={percent}
        steps={steps}
        strokeColor={colors}
        size={[stepWidth, strokeWidth]}
        showInfo={false}
      />
    </div>
  );
};

export default TaskProgressBar;
