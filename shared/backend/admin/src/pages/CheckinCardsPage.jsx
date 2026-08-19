// 打卡管理（卡片式）
// 与「打卡管理」模块功能一致（只读 + 时间轴 + 删除），改为卡片网格布局，
// 参考「任务管理（卡片模式）」页面结构与交互，复用 TaskCard / TaskImages 组件，
// 数据源 /admin/api/task_checkins（通用 CRUD，enrich 附带任务信息与进度）。
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Button, Modal, Input, DatePicker, Tag, Badge, Card, Row, Col, Pagination, Empty, message,
} from 'antd';
import { EyeOutlined, HistoryOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';
import DetailDrawer from '../components/DetailDrawer.jsx';
import TimelineDrawer from '../components/TimelineDrawer.jsx';
import { AudioPlayer, VideoPlayer, fmtDateOnly, fmtDateTime } from '../components/fields.jsx';
import { MODULES } from '../config/modules.jsx';
import TaskCard, { TaskImages } from '../components/TaskCard.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import dayjs from 'dayjs';

const CHECKINS_CFG = MODULES.task_checkins;

// 打卡方式（与任务/审核卡片页一致）
const CHECKIN_TYPE_MAP = {
  image: { label: '图文打卡', color: 'blue' },
  voice: { label: '语音打卡', color: 'warning' },
  video: { label: '视频打卡', color: 'cyan' },
};

// 打卡审核状态（task_checkins.review_status）
const REVIEW_STATUS_MAP = {
  pending: { label: '待审核', color: 'warning' },
  approved: { label: '已通过', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
};

/** 打卡进度：优先任务独立 progress，缺失按状态兜底 */
const progressOf = (r) => {
  const p = Number(r && r.task_progress);
  return Number.isFinite(p) && p >= 0 ? p : (r.task_status === 'done' ? 100 : r.task_status === 'doing' ? 50 : 1);
};

export default function CheckinCardsPage() {
  const keywordRef = useRef('');
  const filterRef = useRef({});
  const pageRef = useRef(1);
  const pageSizeRef = useRef(16);
  const [filterValues, setFilterValues] = useState({});
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [drawerRecord, setDrawerRecord] = useState(null);
  const [timelineRecord, setTimelineRecord] = useState(null);

  // 任务状态字典（卡片绑带颜色/文案，直接取自字典，前端不另起炉灶）
  const [statusDict, setStatusDict] = useState({});

  let currentStaff = {};
  try { currentStaff = JSON.parse(localStorage.getItem('admin_user') || '{}'); } catch (_) {}
  const isAdmin = currentStaff.role === 'admin';

  useEffect(() => {
    let alive = true;
    crudApi.list('dict_items', { page: 1, pageSize: 100, dict_code: 'task_status', item_status: 1 })
      .then((res) => {
        if (!alive) return;
        const list = res.data.list || [];
        const map = {};
        list.forEach(it => {
          map[it.item_value] = { label: it.item_label || it.item_value, color: it.color || '#bfbfbf' };
        });
        setStatusDict(map);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const statusOf = (v) => statusDict[v] || { label: v || '-', color: '#bfbfbf' };

  // ==================== 列表加载（复用 /admin/api/task_checkins 通用 CRUD 接口） ====================
  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const q = {
        page: pageRef.current,
        pageSize: pageSizeRef.current,
        keyword: keywordRef.current,
        ...filterRef.current,
      };
      const res = await crudApi.list('task_checkins', q);
      setList(res.data.list || []);
      setTotal(res.data.total || 0);
    } catch (_) {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const reload = (page = 1) => {
    pageRef.current = page;
    fetchList();
  };

  const onFilterChange = (name, value) => {
    filterRef.current[name] = value || undefined;
    setFilterValues(prev => ({ ...prev, [name]: value }));
    reload(1);
  };

  const onFilterReset = () => {
    filterRef.current = {};
    setFilterValues({});
    reload(1);
  };

  const onPageChange = (p) => {
    pageRef.current = p;
    fetchList();
  };

  const onPageSizeChange = (_cur, size) => {
    pageSizeRef.current = size;
    pageRef.current = 1;
    fetchList();
  };

  // ==================== 删除（后端兜底：非管理员且任务已完成时拒绝） ====================
  const openDelete = (record) => {
    Modal.confirm({
      title: '删除打卡',
      content: `确定删除 ${fmtDateOnly(record.checkin_date)} 的打卡记录吗？删除后不可恢复。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await crudApi.remove('task_checkins', record.checkin_id);
        message.success('已删除');
        fetchList();
      },
    });
  };

  // ==================== 组装卡片参数（author / actions / items / progress） ====================
  const buildCard = (record) => {
    const status = statusOf(record.task_status);
    const review = REVIEW_STATUS_MAP[record.review_status] || { label: record.review_status || '-', color: 'default' };
    const checkinTypeLabel = (CHECKIN_TYPE_MAP[record.checkin_type] || {}).label || record.checkin_type || '-';
    const locked = !isAdmin && record.task_status === 'done';
    const lockTip = locked ? '任务已完成，仅可查看，禁止删除打卡' : undefined;
    const name = record._creatorNickname || record._creatorUsername || `#${record.created_by}`;
    return {
      author: { name, sub: `#${record.created_by}` },
      actions: [
        { key: 'detail', icon: <EyeOutlined />, onClick: () => setDrawerRecord(record), children: '详情' },
        { key: 'timeline', icon: <HistoryOutlined />, onClick: () => setTimelineRecord(record), children: '流程' },
        { key: 'delete', danger: true, icon: <DeleteOutlined />, disabled: locked, title: lockTip, onClick: () => openDelete(record), children: '删除' },
      ],
      items: [
        {
          key: 'task',
          label: '任务标题',
          children: (
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Tag color={status.color} style={{ margin: 0 }}>{status.label}</Tag>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.task_title || '-'}</span>
            </div>
          ),
        },
        { key: 'review', label: '审核状态', children: <Tag color={review.color} style={{ margin: 0 }}>{review.label}</Tag> },
        { key: 'date', label: '打卡日期', children: record.checkin_date || '-' },
        { key: 'type', label: '打卡方式', children: checkinTypeLabel },
        ...(record.checkin_type === 'voice' && record.voice_url
          ? [{ key: 'voice', label: '语音打卡', span: 2, children: <AudioPlayer value={record.voice_url} duration={record.voice_duration} /> }]
          : []),
        ...(record.checkin_type === 'video' && record.video_url
          ? [{ key: 'video', label: '视频打卡', span: 2, children: <VideoPlayer value={record.video_url} duration={record.video_duration} size={record.video_size} poster={record.video_cover} /> }]
          : []),
        {
          key: 'note',
          label: '打卡内容',
          span: 2,
          children: record.checkin_note ? <div style={{ minHeight: 60, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.checkin_note}</div> : '-',
        },
        { key: 'images', label: '打卡图片', span: 2, children: <TaskImages images={record.checkin_images} /> },
        { key: 'taskId', label: '任务编号', children: record.task_id },
        { key: 'creator', label: '打卡人', children: name },
        { key: 'createdAt', label: '打卡时间', children: fmtDateTime(record.created_at) },
      ],
      progress: progressOf(record),
    };
  };

  return (
    <div>
      {/* ==================== 工具栏：筛选（打卡日期）+ 搜索（打卡备注）+ 重置/刷新 ==================== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <DatePicker
          placeholder="打卡日期"
          allowClear
          value={filterValues.checkin_date ? dayjs(filterValues.checkin_date) : undefined}
          onChange={(v) => onFilterChange('checkin_date', v ? v.format('YYYY-MM-DD') : undefined)}
        />
        <Input.Search
          placeholder="搜索打卡备注"
          allowClear
          style={{ width: 200 }}
          onSearch={(v) => {
            keywordRef.current = v;
            reload(1);
          }}
        />
        <Button onClick={onFilterReset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => reload(1)} />
      </div>

      {/* ==================== 卡片网格（2 列等宽，Badge.Ribbon 状态绑带） ==================== */}
      {loading ? (
        <PageSkeleton type="cards" twoCol noCover toolbar />
      ) : list.length === 0 ? (
        <Card><Empty description="暂无打卡记录" /></Card>
      ) : (
        <Row gutter={[16, 16]}>
          {list.map(record => {
            const status = statusOf(record.task_status);
            return (
              <Col span={12} key={record.checkin_id}>
                <Badge.Ribbon text={status.label} color={status.color} rootClassName="kxm-task-ribbon">
                  <Card style={{ height: '100%', display: 'flex', flexDirection: 'column' }} styles={{ body: { flex: 1, padding: '46px 16px 16px' } }}>
                    <TaskCard {...buildCard(record)} />
                  </Card>
                </Badge.Ribbon>
              </Col>
            );
          })}
        </Row>
      )}

      {/* ==================== 分页 ==================== */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Pagination
          current={pageRef.current}
          pageSize={pageSizeRef.current}
          total={total}
          showSizeChanger
          pageSizeOptions={[8, 16, 32, 64]}
          showTotal={(t) => `共 ${t} 条`}
          onChange={onPageChange}
          onShowSizeChange={onPageSizeChange}
        />
      </div>

      {/* ==================== 详情 / 时间轴抽屉 ==================== */}
      <DetailDrawer
        title="打卡详情"
        open={!!drawerRecord}
        record={drawerRecord}
        fields={CHECKINS_CFG.detailFields}
        onClose={() => setDrawerRecord(null)}
      />
      <TimelineDrawer
        title={CHECKINS_CFG.timeline.title}
        open={!!timelineRecord}
        record={timelineRecord}
        paramField={CHECKINS_CFG.timeline.paramField}
        paramName={CHECKINS_CFG.timeline.paramName}
        onClose={() => setTimelineRecord(null)}
      />
    </div>
  );
}
