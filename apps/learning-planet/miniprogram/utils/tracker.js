/**
 * 课小满 - 用户操作事件埋点（user_events）
 * 页面访问 / 按钮点击等，经 /api/lp/collectEvent（LP JWT 身份），失败静默
 */
const { analytics } = require('./api');

/** 当前页面路由（/pages/xxx/xxx 形式） */
function currentRoute() {
  try {
    const pages = getCurrentPages();
    const page = pages && pages[pages.length - 1];
    return page ? `/${page.route || ''}` : '';
  } catch (_) {
    return '';
  }
}

/**
 * 上报一条用户事件
 * @param {string} type page_view / menu_click / button_click / custom
 * @param {string} name 事件名称
 * @param {object} extra 附加信息（bizId 等）
 */
function trackEvent(type, name, extra = {}) {
  try {
    analytics.collectEvent({
      eventType: type,
      eventName: name,
      pagePath: currentRoute(),
      extra,
    }).catch(() => {});
  } catch (_) {}
}

module.exports = { trackEvent, currentRoute };
