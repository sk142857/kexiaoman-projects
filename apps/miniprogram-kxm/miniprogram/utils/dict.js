// utils/dict.js
// 数据字典统一取色：任务状态（task_status）/ 打卡方式（checkin_type）等标签。
// 后台「数据字典」维护 item_label / item_color，前端标签颜色以此为准（color 为空/拉取失败时回退内置默认色）。
const { lp } = require('./api');

const DICT_CODES = ['task_status', 'checkin_type'];

// 兜底色（字典未配置或拉取失败时保持可读）
const FALLBACK = {
  task_status: {
    todo: { label: '待完成', color: '#f5222d' },
    doing: { label: '进行中', color: '#1677ff' },
    done: { label: '已完成', color: '#52c41a' },
  },
  checkin_type: {
    image: { label: '图文打卡', color: '#1677ff' },
    voice: { label: '语音打卡', color: '#faad14' },
    video: { label: '视频打卡', color: '#13c2c2' },
  },
};

let cache = null; // { task_status: { todo: { label, color } }, ... }
let loading = null;

function normalize(data) {
  const map = {};
  Object.keys(data || {}).forEach(code => {
    const byValue = {};
    (data[code] || []).forEach(it => {
      byValue[it.value] = { label: it.label, color: it.color || '' };
    });
    map[code] = byValue;
  });
  return map;
}

/** 拉取并缓存字典（模块级缓存；失败静默，走兜底色） */
async function ensureDict() {
  if (cache) return cache;
  if (loading) return loading;
  loading = lp.dicts(DICT_CODES)
    .then(res => { cache = normalize(res); return cache; })
    .catch(() => { cache = {}; return cache; })
    .finally(() => { loading = null; });
  return loading;
}

function hexToRgba(color, alpha) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(color || '').trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** t-tag 内联样式：字典主色文字 + 12% 主色浅底 + 无边框 */
function tagStyle(color) {
  if (!color) return '';
  const bg = hexToRgba(color, 0.12);
  return bg ? `color:${color};background-color:${bg};border-color:transparent;` : '';
}

/** 取字典项展示元数据（label / color / style），缺失回退兜底色 */
function statusMeta(code, value) {
  const fallback = (FALLBACK[code] && FALLBACK[code][value]) || null;
  const item = (cache && cache[code] && cache[code][value]) || fallback;
  const color = (item && item.color) || '';
  return {
    label: (item && item.label) || value,
    color,
    style: tagStyle(color),
  };
}

module.exports = { DICT_CODES, ensureDict, tagStyle, statusMeta };
