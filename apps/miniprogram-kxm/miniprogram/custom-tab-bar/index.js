const { trackEvent, currentRoute } = require('../utils/tracker');
const { tabList, indexFor } = require('../utils/tabs');
const { lp } = require('../utils/api');

// 角标轮询间隔：停留任意 tab 页时周期刷新未读/待办数，不切页也能感知新消息
const BADGE_REFRESH_INTERVAL = 30000;
// 角标数字上限（超过显示 99+，与 tdesign badge max-count 一致）
const BADGE_MAX_COUNT = 99;

Component({
  data: {
    selected: 0,
    list: [],
  },

  lifetimes: {
    attached() {
      this.setData({ list: tabList(), selected: Math.max(0, indexFor(currentRoute())) });
      this._loadBadges();
      this.badgeTimer = setInterval(() => this._loadBadges(), BADGE_REFRESH_INTERVAL);
    },
    detached() {
      if (this.badgeTimer) {
        clearInterval(this.badgeTimer);
        this.badgeTimer = null;
      }
    },
  },

  methods: {
    /** 页面 onShow 时同步主菜单（角色可能变化，需重算） */
    sync(url) {
      // 保留上一份角标（badgeProps）避免切页瞬间闪没，随后异步刷新
      const prev = this.data.list || [];
      const prevProps = {};
      prev.forEach((it) => { if (it.badgeProps) prevProps[it.badgeKey] = it.badgeProps; });
      this.setData({
        list: tabList().map((t) => (prevProps[t.badgeKey] ? { ...t, badgeProps: prevProps[t.badgeKey] } : t)),
        selected: indexFor(url),
      });
      this._loadBadges();
    },

    /** 拉取角标聚合数并映射到各 tab（无角标的 tab 传 0，badge 组件不渲染）；失败静默保留旧值 */
    _loadBadges() {
      lp.badges()
        .then((badges) => {
          const list = (this.data.list || []).map((item) => {
            const count = Math.max(0, Number((badges && badges[item.badgeKey]) || 0));
            return {
              ...item,
              badgeProps: { count, maxCount: BADGE_MAX_COUNT, size: 'medium' },
            };
          });
          this.setData({ list });
        })
        .catch(() => {});
    },

    onChange(e) {
      const val = e.detail.value;
      const item = this.data.list.find(i => i.index === val);
      if (!item) return;
      // 已停留在当前 tab：跳过 switchTab，避免重复触发页面 onShow/埋点
      if (item.index === this.data.selected) return;
      this.setData({ selected: item.index });
      trackEvent('menu_click', `点击底部菜单-${item.label}`);
      wx.switchTab({ url: item.url });
    },
  },
});
