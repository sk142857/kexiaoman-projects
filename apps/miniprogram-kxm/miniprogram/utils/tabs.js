/**
 * 底部主菜单（TabBar）定义：所有角色共用同一套主菜单
 * 首页 / 待办 / 任务 / 我的
 * Admin 的审核等业务统一收敛在「待办」中，不再单独增加管理主菜单。
 * badgeKey：对应 /api/lp/badges 聚合返回的角标字段；无角标的 tab 留空。
 */
function tabList() {
  return [
    { label: '首页', icon: 'home', url: '/pages/home/home', badgeKey: '' },
    { label: '待办', icon: 'check-circle', url: '/pages/todo/todo', badgeKey: 'todos' },
    { label: '任务', icon: 'task', url: '/pages/tasks/tasks', badgeKey: '' },
    { label: '我的', icon: 'user', url: '/pages/mine/mine', badgeKey: 'notifications' },
  ].map((t, index) => ({ index, ...t }));
}

/** 某页面在主菜单中的 index（不在菜单内返回 0） */
function indexFor(url) {
  const idx = tabList().findIndex(t => t.url === url);
  return idx >= 0 ? idx : 0;
}

module.exports = { tabList, indexFor };
