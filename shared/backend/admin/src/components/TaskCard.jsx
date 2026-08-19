import React from 'react';
import { Avatar, Button, Descriptions, Image } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import { parseImages, toThumbUrl, toImageUrl, IMG_FALLBACK } from './fields.jsx';
import TaskProgressBar from './TaskProgressBar.jsx';

// 任务卡片：作者行(头像 + 操作按钮组) + 带边框字段区 + 步骤式渐变进度条。
// 多个页面复用，页面通过参数控制内容与权限：
//   author  - { name, sub, avatar? } 头像信息（avatar 为自定义头像节点，默认取 name 首字母）
//   actions - 操作按钮配置数组 [{ key, children, icon, type, danger, ghost, disabled, title, onClick }]，传哪些按钮就显示哪些
//   items   - Descriptions items 字段区（由页面决定展示哪些字段）
//   progress- 0~100 进度，传数字才显示进度条

/** 卡片头部作者：头像 + 昵称 + 副信息 */
const TaskCardAuthor = ({ name, sub, avatar, width = 200 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, width, flexShrink: 0 }}>
    {avatar || (
      <Avatar size={40} style={{ background: '#1677ff', color: '#fff', fontSize: 17, flexShrink: 0 }}>
        {String(name).charAt(0).toUpperCase()}
      </Avatar>
    )}
    <span style={{ lineHeight: 1.5, minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
      {sub != null && <div style={{ color: '#8c8c8c', fontSize: 12, whiteSpace: 'nowrap' }}>{sub}</div>}
    </span>
  </div>
);

/** 图片行：默认展示 6 张，超过在第 6 张叠加「+N」，支持点击预览全部 */
const TaskImages = ({ images }) => {
  const list = parseImages(images);
  if (list.length === 0) {
    return (
      <div style={{ height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa', borderRadius: 6, color: '#bfbfbf' }}>
        <PictureOutlined style={{ marginRight: 6 }} />暂无图片
      </div>
    );
  }
  const MAX_SHOW = 6;
  const shown = list.slice(0, MAX_SHOW);
  const extra = list.length - shown.length;
  return (
    <Image.PreviewGroup>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {shown.map((p, i) => {
          const hasExtra = i === shown.length - 1 && extra > 0;
          return (
            <div key={`img-${i}`} style={{ position: 'relative' }}>
              <Image
                width={88}
                height={88}
                src={toThumbUrl(p, 200)}
                preview={{ src: toImageUrl(p) }}
                fallback={IMG_FALLBACK}
                style={{ borderRadius: 6, objectFit: 'cover' }}
              />
              {hasExtra && (
                <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 600, pointerEvents: 'none' }}>
                  +{extra}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Image.PreviewGroup>
  );
};

/** 任务卡片主组件 */
const TaskCard = ({ author, actions = [], items = [], progress, progressStrokeWidth = 14 }) => (
  <div>
    {author && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <TaskCardAuthor {...author} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          {actions.map(({ key, ...btn }) => <Button key={key} {...btn} />)}
        </div>
      </div>
    )}
    <Descriptions bordered size="small" column={2} items={items} />
    {typeof progress === 'number' && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <TaskProgressBar percent={progress} strokeWidth={progressStrokeWidth} style={{ flex: 1 }} />
        <span style={{ fontWeight: 600, color: '#333', fontSize: 14 }}>{progress}%</span>
      </div>
    )}
  </div>
);

export default TaskCard;
export { TaskCardAuthor, TaskImages };
