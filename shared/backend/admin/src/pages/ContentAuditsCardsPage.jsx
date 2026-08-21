// 内容安全（卡片模式）
// 与「内容安全」模块一致（只读 + 详情抽屉），改为卡片网格布局（每行 6 列，风格同「文件上传记录」卡片页），
// 卡片大幅展示媒体（图片/视频/音频/文本），仅展示用户关心的核心字段，全量字段在详情抽屉查看。
// 数据源 /admin/api/content_audits（通用 CRUD，readonly，filter: status/media_type/biz_type）。
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Button, Select, DatePicker, Tag, Card, Row, Col, Pagination, Empty, Input, Image,
} from 'antd';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';
import DetailDrawer from '../components/DetailDrawer.jsx';
import {
  AudioPlayer, DurationText, fmtDateTime, toImageUrl, toThumbUrl, IMG_FALLBACK,
} from '../components/fields.jsx';
import { MODULES } from '../config/modules.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import dayjs from 'dayjs';

const CFG = MODULES.content_audits;

// 业务类型 / 检测状态 / 内容类型（与模块表格/详情一致）
const BIZ_MAP = {
  task: { label: '任务', color: 'purple' },
  checkin: { label: '打卡', color: 'geekblue' },
  profile: { label: '资料', color: 'gold' },
  child: { label: '孩子档案', color: 'orange' },
  collection: { label: '合集', color: 'cyan' },
  review_note: { label: '审核评语', color: 'magenta' },
  file: { label: '媒体', color: 'default' },
};
const STATUS_MAP = {
  pending: { label: '检测中', color: 'processing' },
  pass: { label: '通过', color: 'success' },
  reject: { label: '命中违规', color: 'error' },
  risk: { label: '疑似', color: 'warning' },
  skip: { label: '跳过', color: 'default' },
};
const MEDIA_MAP = {
  1: { label: '文本', color: 'blue' },
  2: { label: '图片', color: 'green' },
  3: { label: '音频', color: 'warning' },
  4: { label: '视频', color: 'cyan' },
};

/** 无媒体占位：正方形灰底 + 文案 */
const MediaPlaceholder = () => (
  <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa' }}>
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bfbfbf', fontSize: 12 }}>
      无媒体
    </div>
  </div>
);

/** 媒体主区：按内容类型渲染，与「文件管理」一致的全宽正方形（图片/视频/音频），文本用固定高度内容区 */
const AuditMediaArea = ({ record }) => {
  const mt = Number(record && record.media_type);
  const path = record && record.content;
  const url = toImageUrl(path);
  if (mt === 2) {
    if (!url) return <MediaPlaceholder />;
    return (
      <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa', overflow: 'hidden' }}>
        <Image
          wrapperStyle={{ position: 'absolute', inset: 0 }}
          src={toThumbUrl(path, 600) || url}
          fallback={IMG_FALLBACK}
          preview={{ mask: false, src: url }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
    );
  }
  if (mt === 4) {
    if (!url) return <MediaPlaceholder />;
    return (
      <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#000', overflow: 'hidden' }}>
        <video
          controls
          preload="metadata"
          src={url}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      </div>
    );
  }
  if (mt === 3) {
    if (!url) return <MediaPlaceholder />;
    return (
      <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <AudioPlayer value={path} />
        </div>
      </div>
    );
  }
  // 文本 / 其他：内容片段（与图片/视频同尺寸正方形，放大字体、黑色系、水平垂直居中，超长省略）
  const text = String(path || record && record.detail || '').trim();
  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa' }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
        <span
          style={{
            fontSize: 18, lineHeight: 1.6, fontWeight: 600, color: '#1f1f1f', wordBreak: 'break-all', textAlign: 'center',
            overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 6, maxWidth: '100%',
          }}
        >
          {text || '（无内容）'}
        </span>
      </div>
    </div>
  );
};

/** 审核卡片：媒体大幅展示 + 核心字段 + 详情操作 */
const AuditCard = ({ record, onDetail }) => {
  const biz = BIZ_MAP[record.biz_type] || { label: record.biz_type || '-', color: 'default' };
  const status = STATUS_MAP[record.status] || { label: record.status || '-', color: 'default' };
  const mt = MEDIA_MAP[Number(record.media_type)] || { label: record.media_type || '-', color: 'default' };
  const dur = (record.enqueued_at && record.detected_at)
    ? <DurationText from={record.enqueued_at} to={record.detected_at} />
    : null;
  return (
    <Card
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      styles={{ body: { flex: 1, padding: 0, display: 'flex', flexDirection: 'column' } }}
    >
      <AuditMediaArea record={record} />
      <div style={{ flex: 1, padding: '12px 16px 0', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <Tag color={biz.color} style={{ margin: 0 }}>{biz.label}</Tag>
          <Tag color={status.color} style={{ margin: 0 }}>{status.label}</Tag>
          <Tag color={mt.color} style={{ margin: 0 }}>{mt.label}</Tag>
        </div>
        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={record.detail || record.content}>
          {record.detail || (Number(record.media_type) === 1 ? String(record.content || '').slice(0, 40) : '媒体审核') || '-'}
        </div>
        <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          业务ID：{record.biz_id || '-'}{record.field ? ` · ${record.field}` : ''}
        </div>
        <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 2 }}>
          {dur ? <span>耗时 {dur} · </span> : null}
          检测 {fmtDateTime(record.detected_at || record.enqueued_at)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px' }}>
        <Button size="middle" block icon={<EyeOutlined />} onClick={() => onDetail(record)}>详情</Button>
      </div>
    </Card>
  );
};

export default function ContentAuditsCardsPage() {
  const keywordRef = useRef('');
  const filterRef = useRef({});
  const pageRef = useRef(1);
  const pageSizeRef = useRef(18);
  // 默认最近 7 天（与表格模块 defaultDays: 7 一致），可切换时间范围
  const timeRangeRef = useRef([
    dayjs().subtract(6, 'day').startOf('day'),
    dayjs().endOf('day'),
  ]);
  const [filterValues, setFilterValues] = useState({});
  const [timeRange, setTimeRange] = useState([...timeRangeRef.current]);
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [drawerRecord, setDrawerRecord] = useState(null);

  // ==================== 列表加载（复用 /admin/api/content_audits 通用 CRUD 接口） ====================
  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const [start, end] = timeRangeRef.current;
      const q = {
        page: pageRef.current,
        pageSize: pageSizeRef.current,
        keyword: keywordRef.current,
        startTime: start ? start.format('YYYY-MM-DD HH:mm:ss') : undefined,
        endTime: end ? end.format('YYYY-MM-DD HH:mm:ss') : undefined,
        ...filterRef.current,
      };
      const res = await crudApi.list('content_audits', q);
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
    timeRangeRef.current = [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')];
    setTimeRange([...timeRangeRef.current]);
    reload(1);
  };

  const onTimeRangeChange = (range) => {
    timeRangeRef.current = range || [null, null];
    setTimeRange(range || []);
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

  return (
    <div>
      {/* ==================== 工具栏：检测状态/内容类型/业务筛选 + 时间范围 + 搜索 + 重置/刷新 ==================== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Select
          placeholder="检测状态"
          allowClear
          style={{ width: 130 }}
          value={filterValues.status}
          options={Object.entries(STATUS_MAP).map(([value, v]) => ({ value, label: v.label }))}
          onChange={(v) => onFilterChange('status', v)}
        />
        <Select
          placeholder="内容类型"
          allowClear
          style={{ width: 120 }}
          value={filterValues.media_type}
          options={Object.entries(MEDIA_MAP).map(([value, v]) => ({ value, label: v.label }))}
          onChange={(v) => onFilterChange('media_type', v)}
        />
        <Select
          placeholder="业务"
          allowClear
          style={{ width: 120 }}
          value={filterValues.biz_type}
          options={Object.entries(BIZ_MAP).map(([value, v]) => ({ value, label: v.label }))}
          onChange={(v) => onFilterChange('biz_type', v)}
        />
        <DatePicker.RangePicker
          allowClear
          value={timeRange}
          onChange={onTimeRangeChange}
          style={{ width: 260 }}
        />
        <Input.Search
          placeholder="搜索审核ID/内容"
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

      {/* ==================== 卡片网格（6 列等宽，风格同文件上传记录卡片页） ==================== */}
      {loading ? (
        <PageSkeleton type="cards" twoCol noCover toolbar />
      ) : list.length === 0 ? (
        <Card><Empty description="暂无内容安全审核记录" /></Card>
      ) : (
        <Row gutter={[16, 16]}>
          {list.map(record => (
            <Col span={4} key={record.audit_id}>
              <AuditCard
                record={record}
                onDetail={() => setDrawerRecord(record)}
              />
            </Col>
          ))}
        </Row>
      )}

      {/* ==================== 分页 ==================== */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Pagination
          current={pageRef.current}
          pageSize={pageSizeRef.current}
          total={total}
          showSizeChanger
          pageSizeOptions={[8, 16, 18, 32, 64]}
          showTotal={(t) => `共 ${t} 条`}
          onChange={onPageChange}
          onShowSizeChange={onPageSizeChange}
        />
      </div>

      {/* ==================== 详情抽屉（复用模块 detailFields，含媒体大图/视频播放/微信原始返回 JSON） ==================== */}
      <DetailDrawer
        title="审核详情"
        open={!!drawerRecord}
        record={drawerRecord}
        fields={CFG.detailFields}
        column={3}
        width={1000}
        onClose={() => setDrawerRecord(null)}
      />
    </div>
  );
}
