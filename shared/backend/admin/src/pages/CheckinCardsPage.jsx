// 打卡管理（卡片式）
// 与「打卡管理」模块功能一致（只读 + 时间轴 + 删除），改为卡片网格布局，
// 参考「任务管理（卡片模式）」页面结构与交互，复用 TaskCard / TaskImages 组件，
// 数据源 /admin/api/task_checkins（通用 CRUD，enrich 附带任务信息与进度）。
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Button, Modal, Form, Input, DatePicker, Select, Tag, Badge, Card, Row, Col, Pagination, Empty, message, Image,
} from 'antd';
import { EyeOutlined, HistoryOutlined, DeleteOutlined, ReloadOutlined, EditOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';
import DetailDrawer from '../components/DetailDrawer.jsx';
import TimelineDrawer from '../components/TimelineDrawer.jsx';
import {
  AudioPlayer, ImageUploader, parseImages, imagesToJson,
  toImageUrl, toThumbUrl, IMG_FALLBACK, fmtDateOnly, fmtDateTime,
} from '../components/fields.jsx';
import { MODULES } from '../config/modules.jsx';
import TaskCard from '../components/TaskCard.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import dayjs from 'dayjs';

const CHECKINS_CFG = MODULES.task_checkins;

// 打卡方式（与任务/审核卡片页一致）
const CHECKIN_TYPE_MAP = {
  image: { label: '图文打卡', color: 'blue' },
  voice: { label: '语音打卡', color: 'warning' },
  video: { label: '视频打卡', color: 'cyan' },
};

// 打卡来源（Web 后台 / 小程序）
const TASK_SOURCE_MAP = {
  web: { label: 'Web后台', color: 'purple' },
  miniprogram: { label: '小程序', color: 'blue' },
};

// 打卡审核状态（task_checkins.review_status）
const REVIEW_STATUS_MAP = {
  pending: { label: '待审核', color: 'warning' },
  approved: { label: '已通过', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
};

// 内容安全状态（打卡内容机器检测结果）
const RISK_STATUS_MAP = {
  pass: { label: '安全', color: 'success' },
  pending: { label: '检测中', color: 'processing' },
  reject: { label: '违规', color: 'error' },
};
// 「其他信息」文本着色（1 行 2 列展示用）：审核状态 / 风控安全 不同状态取不同色值
const REVIEW_STATUS_HEX = { pending: '#faad14', approved: '#52c41a', rejected: '#ff4d4f' };
const RISK_STATUS_HEX = { pass: '#52c41a', pending: '#1677ff', reject: '#ff4d4f' };

// 打卡媒体区：与「文件管理」图片观感一致（268px 正方形），不随卡片列宽拉伸
// 图片/视频/语音均为 268×268 正方形：图片默认展示前 2 张（更多时右上角显示数量，点击预览可查看全部），视频整幅播放，语音居中播放
const MEDIA_SIZE = 268;
const CheckinMediaArea = ({ record }) => {
  if (record.checkin_type === 'image') {
    const imgs = parseImages(record.checkin_images);
    if (imgs.length === 0) return null;
    const show = imgs.slice(0, 2);
    return (
      <div style={{ position: 'relative', width: MEDIA_SIZE, height: MEDIA_SIZE, background: '#fafafa', borderRadius: 8, overflow: 'hidden' }}>
        <Image.PreviewGroup>
          <div style={{ display: 'flex', width: '100%', height: '100%' }}>
            {show.map((p, i) => (
              <Image
                key={`img-${i}`}
                wrapperStyle={{ width: '50%', height: '100%', flexShrink: 0 }}
                src={toThumbUrl(p, 900) || toImageUrl(p)}
                fallback={IMG_FALLBACK}
                preview={{ mask: false, src: toImageUrl(p) }}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ))}
          </div>
          {/* 第 3 张起注册进 PreviewGroup（隐藏），点击预览可左右切换查看全部 */}
          {imgs.slice(2).map((p, i) => (
            <Image key={`more-${i}`} src={toThumbUrl(p, 900)} fallback={IMG_FALLBACK} width={0} height={0} style={{ display: 'none' }} preview={{ mask: false, src: toImageUrl(p) }} />
          ))}
        </Image.PreviewGroup>
        {imgs.length > 2 && (
          <div style={{ position: 'absolute', right: 6, top: 6, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 12, padding: '2px 10px', borderRadius: 999, pointerEvents: 'none' }}>
            {imgs.length} 张
          </div>
        )}
      </div>
    );
  }
  if (record.checkin_type === 'video' && record.video_url) {
    const url = toImageUrl(record.video_url);
    const posterUrl = record.video_cover ? toImageUrl(record.video_cover) : '';
    const duration = Number(record.video_duration);
    const size = Number(record.video_size);
    const sizeText = size > 0 ? (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${Math.round(size / 1024)}KB`) : '';
    return (
      <div>
        <div style={{ position: 'relative', width: MEDIA_SIZE, height: MEDIA_SIZE, background: '#000', borderRadius: 8, overflow: 'hidden' }}>
          <video
            controls
            preload="metadata"
            src={url}
            poster={posterUrl || undefined}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
        {(duration > 0 || sizeText) && (
          <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4 }}>
            {[duration > 0 ? `时长 ${duration} 秒` : '', sizeText ? `压缩后 ${sizeText}` : ''].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    );
  }
  if (record.checkin_type === 'voice' && record.voice_url) {
    return (
      <div style={{ position: 'relative', width: MEDIA_SIZE, height: MEDIA_SIZE, background: '#fafafa', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
        <AudioPlayer value={record.voice_url} duration={record.voice_duration} />
      </div>
    );
  }
  return null;
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

  // 编辑打卡弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [editForm] = Form.useForm();

  // 任务状态字典（卡片绑带颜色/文案，直接取自字典，前端不另起炉灶）
  const [statusDict, setStatusDict] = useState({});
  // 打卡方式字典（数据字典维护：label/color 全局同步，后台改色即生效）
  const [checkinTypeDict, setCheckinTypeDict] = useState({});

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
    crudApi.list('dict_items', { page: 1, pageSize: 100, dict_code: 'checkin_type', item_status: 1 })
      .then((res) => {
        if (!alive) return;
        const list = res.data.list || [];
        const map = {};
        list.forEach(it => {
          map[it.item_value] = { label: it.item_label || it.item_value, color: it.color || '#bfbfbf' };
        });
        setCheckinTypeDict(map);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const statusOf = (v) => statusDict[v] || { label: v || '-', color: '#bfbfbf' };
  const checkinTypeOf = (v) => checkinTypeDict[v] || { label: (CHECKIN_TYPE_MAP[v] || {}).label || v || '-', color: (CHECKIN_TYPE_MAP[v] || {}).color || '#bfbfbf' };

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

  // ==================== 编辑打卡（改日期/备注；图文打卡可换图，后端兜底权限） ====================
  const openEdit = (record) => {
    setEditing(record);
    editForm.setFieldsValue({
      checkin_date: dayjs(record.checkin_date),
      checkin_note: record.checkin_note || '',
      checkin_images: parseImages(record.checkin_images),
    });
    setEditOpen(true);
  };

  const submitEdit = async () => {
    let values;
    try {
      values = await editForm.validateFields();
    } catch (e) {
      if (e?.errorFields) return;
      return;
    }
    setSubmitting(true);
    const payload = {
      checkin_date: values.checkin_date ? values.checkin_date.format('YYYY-MM-DD') : undefined,
      checkin_note: values.checkin_note || '',
    };
    // 图文打卡可替换图片；语音/视频打卡仅改日期与备注
    if (editing && editing.checkin_type === 'image') {
      payload.checkin_images = imagesToJson(values.checkin_images);
    }
    try {
      await crudApi.update('task_checkins', editing.checkin_id, payload);
      message.success('更新成功');
      setEditOpen(false);
      fetchList();
    } catch (_) {
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== 组装卡片参数（author / actions / items） ====================
  const buildCard = (record) => {
    const status = statusOf(record.task_status);
    const review = REVIEW_STATUS_MAP[record.review_status] || { label: record.review_status || '-', color: 'default' };
    const locked = !isAdmin && record.task_status === 'done';
    const lockTip = locked ? '任务已完成，仅可查看，禁止编辑/删除打卡' : undefined;
    const name = record._creatorNickname || record._creatorUsername || `#${record.created_by}`;
    return {
      author: { name, sub: `#${record.created_by}` },
      actions: [
        { key: 'detail', icon: <EyeOutlined />, onClick: () => setDrawerRecord(record), children: '详情' },
        { key: 'timeline', icon: <HistoryOutlined />, onClick: () => setTimelineRecord(record), children: '流程' },
        { key: 'edit', icon: <EditOutlined />, disabled: locked, title: lockTip, onClick: () => openEdit(record), children: '编辑' },
        { key: 'delete', danger: true, icon: <DeleteOutlined />, disabled: locked, title: lockTip, onClick: () => openDelete(record), children: '删除' },
      ],
      items: [
        {
          key: 'task',
          label: '任务标题',
          span: 2,
          children: (
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Tag color={status.color} style={{ margin: 0 }}>{status.label}</Tag>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.task_title || '-'}</span>
            </div>
          ),
        },
        {
          // 打卡方式：来源 + 打卡方式均为 Tag（打卡方式取数据字典 color 同步）
          key: 'type',
          label: '打卡方式',
          children: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {(() => { const c = TASK_SOURCE_MAP[record.source] || {}; return record.source ? <Tag color={c.color} style={{ margin: 0 }}>{c.label || record.source}</Tag> : null; })()}
              {(() => { const c = checkinTypeOf(record.checkin_type); return <Tag color={c.color} style={{ margin: 0 }}>{c.label}</Tag>; })()}
            </div>
          ),
        },
        { key: 'createdAt', label: '打卡时间', children: fmtDateTime(record.created_at) },
        // 按打卡模式展示对应媒体：图片/视频/语音统一为全宽正方形媒体区（与文件管理尺寸一致）
        ...(record.checkin_type === 'image'
          ? [{ key: 'images', label: '打卡图片', span: 2, children: <CheckinMediaArea record={record} /> }]
          : []),
        ...(record.checkin_type === 'voice' && record.voice_url
          ? [{ key: 'voice', label: '语音打卡', span: 2, children: <CheckinMediaArea record={record} /> }]
          : []),
        ...(record.checkin_type === 'video' && record.video_url
          ? [{ key: 'video', label: '视频打卡', span: 2, children: <CheckinMediaArea record={record} /> }]
          : []),
        {
          key: 'note',
          label: '打卡内容',
          span: 2,
          children: record.checkin_note ? <div style={{ minHeight: 60, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.checkin_note}</div> : '-',
        },
        { key: 'taskId', label: '任务编号', children: record.task_id },
        { key: 'creator', label: '打卡人', children: name },
        // 其他信息：1 行 2 列（审核状态 / 风控安全），文本按状态取不同色值
        { key: 'review', label: '审核状态', children: <span style={{ color: REVIEW_STATUS_HEX[record.review_status] || '#8c8c8c', fontWeight: 500 }}>{review.label}</span> },
        { key: 'risk', label: '风控安全', children: <span style={{ color: RISK_STATUS_HEX[record.risk_status] || '#8c8c8c', fontWeight: 500 }}>{(RISK_STATUS_MAP[record.risk_status] || {}).label || record.risk_status || '-'}</span> },
      ],
    };
  };

  return (
    <div>
      {/* ==================== 工具栏：筛选（打卡日期/来源）+ 搜索（打卡备注）+ 重置/刷新 ==================== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <DatePicker
          placeholder="打卡日期"
          allowClear
          value={filterValues.checkin_date ? dayjs(filterValues.checkin_date) : undefined}
          onChange={(v) => onFilterChange('checkin_date', v ? v.format('YYYY-MM-DD') : undefined)}
        />
        <Select
          placeholder="打卡来源"
          allowClear
          style={{ width: 130 }}
          value={filterValues.source}
          options={[{ value: 'web', label: 'Web后台' }, { value: 'miniprogram', label: '小程序' }]}
          onChange={(v) => onFilterChange('source', v)}
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

      {/* ==================== 编辑打卡弹窗（日期/备注；图文可换图） ==================== */}
      <Modal
        title={`编辑打卡${editing ? `：${fmtDateOnly(editing.checkin_date)}` : ''}`}
        open={editOpen}
        onOk={submitEdit}
        onCancel={() => setEditOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        okText="保存"
        width={560}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="checkin_date" label="打卡日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="checkin_note" label="打卡备注">
            <Input.TextArea rows={3} maxLength={500} placeholder="记录本次学习情况..." />
          </Form.Item>
          {editing && editing.checkin_type === 'image' && (
            <Form.Item name="checkin_images" label="打卡图片（最多9张）">
              <ImageUploader max={9} biz="tasks" />
            </Form.Item>
          )}
          {editing && editing.checkin_type !== 'image' && (
            <Form.Item label="打卡方式">
              <Input value={checkinTypeOf(editing.checkin_type).label} disabled />
            </Form.Item>
          )}
        </Form>
      </Modal>

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
