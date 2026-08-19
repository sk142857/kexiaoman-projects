// components/empty/empty.js
// 统一空态组件：白卡 + 居中（图标 + 标题 + 描述），各列表页共用
Component({
  properties: {
    icon: { type: String, value: '' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    height: { type: String, value: '360rpx' },
  },
});
