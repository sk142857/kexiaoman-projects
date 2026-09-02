/**
 * 通用工具函数模块
 * 提供日期格式化、节流防抖等常用能力。
 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatDate(d, sep = '-') {
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join(sep);
}

function todayKey() {
  return formatDate(new Date());
}

function formatTime(d) {
  return formatDate(d, '-') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function throttle(fn, wait) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    }
  };
}

function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

module.exports = { pad, formatDate, formatTime, todayKey, throttle, debounce, pick };
