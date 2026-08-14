import React, { useEffect, useState } from 'react';
import { Drawer, Timeline, Tag, Spin, Empty } from 'antd';
import {
  PlusCircleFilled, CheckCircleFilled, CalendarFilled, EditFilled,
  DeleteFilled, EditOutlined, HistoryOutlined,
} from '@ant-design/icons';
import { crudApi } from '../services/api';
import { ImageAvatar, ImageList, parseImages } from './fields.jsx';
import dayjs from 'dayjs';

// 事件类型 → 醒目节点图标/颜色/标记（创建/完成/打卡等特殊节点用填充图标突出）
const EVENT_STYLE = {
  create:         { color: '#52c41a', icon: <PlusCircleFilled />,      label: '创建', tag: 'success' },
  done:           { color: '#52c41a', icon: <CheckCircleFilled />,     label: '完成', tag: 'success' },
  checkin:        { color: '#1677ff', icon: <CalendarFilled />,        label: '打卡', tag: 'processing' },
  checkin_update: { color: '#722ed1', icon: <EditFilled />,            label: '修改打卡', tag: 'purple' },
  checkin_delete: { color: '#eb2f96', icon: <DeleteFilled />,          label: '删除打卡', tag: 'magenta' },
  update:         { color: '#8c8c8c', icon: <EditOutlined />,          label: '更新', tag: 'default' },
  delete:         { color: '#ff4d4f', icon: <DeleteFilled />,          label: '删除', tag: 'error' },
};
const DEFAULT_STYLE = { color: '#bfbfbf', icon: <HistoryOutlined />, label: '事件', tag: 'default' };

const TASK_STATUS = { todo: '未开始', doing: '进行中', done: '已完成' };

// ==================== 时间列：日期 + 时间 两行，右对齐 ====================
function TimeTitle({ t }) {
  if (!t) return null;
  const d = dayjs(t);
  return (
    <div style={{ textAlign: 'right', paddingTop: 2 }}>
      <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.85)', whiteSpace: 'nowrap' }}>{d.format('YYYY-MM-DD')}</div>
      <div style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>{d.format('HH:mm:ss')}</div>
    </div>
  );
}

// ==================== 标签-值 行（空值不渲染） ====================
function Row({ label, children }) {
  if (children === undefined || children === null || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: '24px' }}>
      <span style={{ flexShrink: 0, color: '#8c8c8c' }}>{label}</span>
      <span style={{ color: '#262626', wordBreak: 'break-all', minWidth: 0, flex: 1 }}>{children}</span>
    </div>
  );
}

// ==================== 变更明细（旧值 → 新值） ====================
function ChangeList({ changed }) {
  if (!changed || typeof changed !== 'object' || Object.keys(changed).length === 0) return null;
  const rows = Object.entries(changed).map(([k, v]) => {
    const from = v && typeof v === 'object' && 'from' in v ? String(v.from ?? '-') : String(v ?? '-');
    const to = v && typeof v === 'object' && 'to' in v ? String(v.to ?? '-') : from;
    return { k, from, to };
  });
  return (
    <div style={{ marginTop: 6, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: '#666' }}>
      <div style={{ fontWeight: 600, color: '#8c8c8c', marginBottom: 4 }}>变更明细</div>
      {rows.map(({ k, from, to }) => (
        <div key={k} style={{ display: 'flex', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
          <span style={{ flexShrink: 0, color: '#999' }}>{k}：</span>
          <span style={{ color: '#cf1322', textDecoration: 'line-through', wordBreak: 'break-all' }}>{from}</span>
          <span style={{ color: '#389e0d' }}>→ {to}</span>
        </div>
      ))}
    </div>
  );
}

// ==================== 事件关键内容：按类型抽取结构化字段 ====================
function EventBody({ ev }) {
  const p = ev.payload || {};
  const rows = [];
  switch (ev.event_type) {
    case 'create': // 创建了什么任务：展示科目/起止日期等要点（标题已在抽屉标题）
      if (p.subject) rows.push(<Row key="subject" label="科目">{p.subject}</Row>);
      if (p.start_date) rows.push(<Row key="start" label="开始日期">{p.start_date}</Row>);
      if (p.deadline) rows.push(<Row key="deadline" label="截止日期">{p.deadline}</Row>);
      if (p.collection_id) rows.push(<Row key="col" label="所属合集">#{p.collection_id}</Row>);
      break;
    case 'checkin': // 打卡了什么内容：日期 + 备注 + 图片
    case 'checkin_delete':
      if (p.checkin_date) rows.push(<Row key="date" label="打卡日期">{p.checkin_date}</Row>);
      if (p.note) {
        rows.push(
          <div key="note" style={{ marginTop: 4, background: '#f6f8fa', border: '1px solid #eee', borderRadius: 6, padding: '6px 10px', fontSize: 13, color: '#333', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {p.note}
          </div>
        );
      }
      break;
    case 'delete': // 删除任务：记录状态与累计打卡
      if (p.task_status) rows.push(<Row key="status" label="任务状态">{TASK_STATUS[p.task_status] || p.task_status}</Row>);
      if (p.checkin_count != null) rows.push(<Row key="count" label="累计打卡">{p.checkin_count} 次</Row>);
      break;
    case 'done': // 完成：无需补充，绿色对勾节点已表达
      break;
    default:
      break;
  }
  return (
    <div>
      {rows.length > 0 && <div style={{ marginTop: 4 }}>{rows}</div>}
      {(ev.event_type === 'update' || ev.event_type === 'checkin_update') && <ChangeList changed={p.changed} />}
      {parseImages(p.images).length > 0 && (
        <div style={{ marginTop: 8 }}><ImageList value={p.images} thumb={56} /></div>
      )}
    </div>
  );
}

/**
 * 任务/打卡时间轴抽屉（antd Timeline + titleSpan 布局）
 * 展示某任务（含其打卡）或某条打卡的全生命周期事件，节点用图标区分类型，
 * 关键信息按事件类型结构化展示，并标注 36px 操作人头像。
 * @param {object} props
 *  - open / onClose / title: 抽屉开关与标题（会在标题后追加 任务/打卡 主题）
 *  - record: 当前行记录（取 paramField 值作为查询条件，取 title/task_title 作为抽屉标题）
 *  - paramField: 记录字段名（默认 task_id）
 *  - paramName: 查询参数名（默认 taskId，对应 /api/tasks/timeline）
 */
export default function TimelineDrawer({
  title = '时间轴', open, record, onClose,
  paramField = 'task_id', paramName = 'taskId', width = 600,
}) {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);

  useEffect(() => {
    if (!open || !record) return;
    setLoading(true);
    setList([]);
    crudApi.taskTimeline({ [paramName]: record[paramField] })
      .then((res) => setList(res.data.list || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [open, record, paramField, paramName]);

  const subject = record ? (record.title || record.task_title || (record[paramField] ? `#${record[paramField]}` : '')) : '';
  const drawerTitle = subject ? `${title}：${subject}` : title;

  const items = list.map((ev) => {
    const st = EVENT_STYLE[ev.event_type] || DEFAULT_STYLE;
    const opName = ev._creatorNickname || ev._creatorUsername || (ev.created_by ? `员工 #${ev.created_by}` : '系统');
    const opSub = ev._creatorUsername ? `@${ev._creatorUsername}` : (ev.created_by ? `员工ID ${ev.created_by}` : '');
    return {
      key: ev.event_id,
      title: <TimeTitle t={ev.created_at} />,
      dot: <span style={{ fontSize: 18, lineHeight: 0 }}>{st.icon}</span>,
      color: st.color,
      children: (
        <div style={{ paddingBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: st.color, fontWeight: 600, fontSize: 14 }}>{ev.event_name || st.label}</span>
            <Tag color={st.tag} style={{ marginRight: 0 }}>{st.label}</Tag>
          </div>
          <EventBody ev={ev} />
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ImageAvatar nickname={opName} avatarChar="员" size={36} />
            <div style={{ lineHeight: 1.3, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#1f1f1f', whiteSpace: 'nowrap' }}>{opName}</div>
              {opSub && <div style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>{opSub}</div>}
            </div>
          </div>
        </div>
      ),
    };
  });

  return (
    <Drawer title={drawerTitle} width={width} open={open} onClose={onClose} destroyOnClose>
      <Spin spinning={loading}>
        {!loading && list.length === 0 ? (
          <Empty description="暂无时间轴记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Timeline items={items} titleSpan="120px" />
        )}
      </Spin>
    </Drawer>
  );
}
