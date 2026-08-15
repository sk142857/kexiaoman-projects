const { trackEvent, currentRoute } = require('../utils/tracker');
const { tabList, indexFor } = require('../utils/tabs');

Component({
  data: {
    selected: 0,
    list: [],
  },

  lifetimes: {
    attached() {
      this.setData({ list: tabList(), selected: Math.max(0, indexFor(currentRoute())) });
    },
  },

  methods: {
    /** 页面 onShow 时同步主菜单（角色可能变化，需重算） */
    sync(url) {
      this.setData({ list: tabList(), selected: indexFor(url) });
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
