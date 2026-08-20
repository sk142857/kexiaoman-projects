// 文件上传记录（卡片模式）
// 与「文件上传记录」模块一致（只读 + 详情 + 物理删除云存储），改为卡片网格布局，
// 卡片以图片/视频等媒体大幅展示为主（图片整幅预览、视频整幅播放、音频居中播放），
// 底部提供必要信息字段（业务/状态/文件名/上传者/大小/时间）与「详情/删除」操作，
// 详情通过抽屉查看（复用模块 detailFields）。
// 数据源 /admin/api/file_uploads（通用 CRUD，enrichUsers 附带上传者信息）。
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Button, Modal, Input, Select, DatePicker, Tag, Card, Row, Col, Pagination, Empty, message, Image,
} from 'antd';
import { EyeOutlined, DeleteOutlined, ReloadOutlined, ClearOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';
import DetailDrawer from '../components/DetailDrawer.jsx';
import {
  AudioPlayer, isVideoRecord, SizeText, fmtDateTime,
  toImageUrl, toThumbUrl, IMG_FALLBACK,
} from '../components/fields.jsx';
import { MODULES } from '../config/modules.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import dayjs from 'dayjs';

const UPLOADS_CFG = MODULES.file_uploads;

// 业务类型（与模块表格/详情一致）
const BIZ_MAP = {
  avatar: { label: '头像', color: 'blue' },
  events: { label: '事件', color: 'default' },
  tasks: { label: '任务', color: 'purple' },
  voice: { label: '语音', color: 'warning' },
  videos: { label: '视频', color: 'cyan' },
};

const FILE_STATUS_MAP = {
  active: { label: '正常', color: 'success' },
  removed: { label: '已删除', color: 'default' },
};

// 文件类型（按 content_type 前缀）
const contentTypeTag = (ct) => {
  const s = String(ct || '');
  if (/^video\//i.test(s)) return <Tag color="cyan" style={{ margin: 0 }}>视频</Tag>;
  if (/^audio\//i.test(s)) return <Tag color="warning" style={{ margin: 0 }}>语音</Tag>;
  if (/^image\//i.test(s)) return <Tag color="blue" style={{ margin: 0 }}>图片</Tag>;
  return <Tag style={{ margin: 0 }}>{s || '-'}</Tag>;
};

// 媒体区正方形：紧贴卡片内侧（上/左/右 0 间距），宽高随卡片自适应（同行卡片等宽，正方形统一）
/** 媒体主区：图片/视频固定正方形（紧贴卡片上/左/右边缘），音频居中播放、其余占位
 * 用 padding-top:100% 方形盒子 + 内部绝对定位，避免 aspect-ratio 被高固有内容撑大 */
const MediaArea = ({ record }) => {
  const ct = String((record && record.content_type) || '');
  const url = record && record.file_url ? toImageUrl(record.file_url) : '';
  if (isVideoRecord(record) && url) {
    return (
      <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#000', overflow: 'hidden' }}>
        <video controls preload="metadata" src={url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }
  if (/^audio\//i.test(ct) && url) {
    return (
      <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <AudioPlayer value={record.file_url} />
        </div>
      </div>
    );
  }
  if (/^image\//i.test(ct) && url) {
    return (
      <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa', overflow: 'hidden' }}>
        {/* antd Image：wrapperStyle 作用于外层 .ant-image，style 作用于内层 <img>，均走内联样式避免被 hash 覆盖 */}
        <Image
          wrapperStyle={{ position: 'absolute', inset: 0 }}
          src={toThumbUrl(record.file_url, 900)}
          fallback={IMG_FALLBACK}
          preview={{ src: url }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', width: '100%', paddingTop: '100%', background: '#fafafa' }}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bfbfbf', fontSize: 12 }}>
        {ct || '未知文件类型'}
      </div>
    </div>
  );
};

/** 文件卡片：媒体大图 + 底部信息字段 + 详情/删除操作 */
const FileCard = ({ record, onDetail, onDelete }) => {
  const biz = BIZ_MAP[record.biz] || { label: record.biz || '-', color: 'default' };
  const status = FILE_STATUS_MAP[record.file_status] || { label: record.file_status || '-', color: 'default' };
  const uploaderName = record._userNickname || record._userAvatarChar || (record.staff_id ? `#${record.staff_id}` : '游客');
  const size = record.file_size_compressed || record.file_size || record.file_size_orig;
  return (
    <Card
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      styles={{ body: { flex: 1, padding: 0, display: 'flex', flexDirection: 'column' } }}
    >
      <MediaArea record={record} />
      <div style={{ flex: 1, padding: '12px 16px 0', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <Tag color={biz.color} style={{ margin: 0 }}>{biz.label}</Tag>
          <Tag color={status.color} style={{ margin: 0 }}>{status.label}</Tag>
          {contentTypeTag(record.content_type)}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={record.file_name}>
          {record.file_name || '-'}
        </div>
        <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {uploaderName}{size ? <span> · {SizeText && <SizeText value={size} />}</span> : null}
        </div>
        <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 2 }}>
          上传于 {fmtDateTime(record.created_at)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px' }}>
        <Button size="middle" block icon={<EyeOutlined />} onClick={() => onDetail(record)}>详情</Button>
        <Button size="middle" block danger icon={<DeleteOutlined />} onClick={() => onDelete(record)}>删除</Button>
      </div>
    </Card>
  );
};

export default function FileUploadsCardsPage() {
  const keywordRef = useRef('');
  const filterRef = useRef({});
  const pageRef = useRef(1);
  const pageSizeRef = useRef(18);
  // 默认最近 3 天（与表格模块 defaultDays: 3 一致），可切换时间范围
  const timeRangeRef = useRef([
    dayjs().subtract(2, 'day').startOf('day'),
    dayjs().endOf('day'),
  ]);
  const [filterValues, setFilterValues] = useState({});
  const [timeRange, setTimeRange] = useState([...timeRangeRef.current]);
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [drawerRecord, setDrawerRecord] = useState(null);

  // ==================== 列表加载（复用 /admin/api/file_uploads 通用 CRUD 接口） ====================
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
      const res = await crudApi.list('file_uploads', q);
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
    timeRangeRef.current = [dayjs().subtract(2, 'day').startOf('day'), dayjs().endOf('day')];
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

  // ==================== 删除（物理删除云存储对象 + 登记记录，复用 batchDelete 语义） ====================
  const openDelete = (record) => {
    Modal.confirm({
      title: '删除文件',
      content: (
        <span>
          确定删除文件 <b>{record.file_name || record.file_path}</b> 吗？
          <br />
          将<b style={{ color: '#f5222d' }}>物理删除腾讯云存储对象</b>及登记记录，删除后不可恢复。
        </span>
      ),
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        const res = await crudApi.batchDelete('file_uploads', [record.file_id]);
        message.success((res.data && res.data.msg) || '已删除');
        fetchList();
      },
    });
  };

  // ==================== 图片清理（两段式：预览统计 → 确认后物理删除未引用文件） ====================
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const openCleanup = async () => {
    setCleanupLoading(true);
    try {
      // 第一阶段：仅统计预览（不删除）
      const res = await crudApi.fileCleanup({ preview: 1 });
      const d = res.data || {};
      const total = Number(d.total) || 0;
      const samples = Array.isArray(d.samples) ? d.samples : [];
      if (total === 0) {
        message.success('暂无需要清理的文件（所有登记均被业务引用）');
        return;
      }
      const run = async () => {
        const execRes = await crudApi.fileCleanup({ preview: 0 });
        message.success((execRes.data && execRes.data.msg) || '清理完成');
        fetchList();
      };
      Modal.confirm({
        title: '确认清理未引用图片',
        width: 640,
        content: (
          <div style={{ lineHeight: 1.8 }}>
            <p style={{ marginBottom: 8 }}>
              将<b style={{ color: '#f5222d' }}>物理删除腾讯云存储对象</b>并清理登记记录，删除后不可恢复。
            </p>
            <p style={{ margin: 0 }}>
              本次共发现 <b>{total}</b> 个文件不再被业务系统引用：
            </p>
            <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
              <li>待物理删除：<b>{Number(d.pathCount) || 0}</b> 个</li>
              <li>无路径登记（仅清登记）：<b>{Number(d.empty) || 0}</b> 条</li>
              {d.truncated ? <li style={{ color: '#fa8c16' }}>数量超过单次上限（{d.cap}），本次仅处理前 {d.cap} 条，可重复点击分批清理</li> : null}
            </ul>
            {samples.length > 0 ? (
              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 12px', background: '#fafafa', fontSize: 12, color: '#595959' }}>
                {samples.slice(0, 10).map(s => (
                  <div key={s.file_id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.file_path || '（无路径登记）'}
                    {s.biz ? <span style={{ color: '#8c8c8c' }}> · {s.biz}</span> : null}
                  </div>
                ))}
                {samples.length > 10 ? <div style={{ color: '#8c8c8c' }}>… 等 {samples.length} 条</div> : null}
              </div>
            ) : null}
          </div>
        ),
        okText: '确认清理',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => run(),
      });
    } catch (_) {
    } finally {
      setCleanupLoading(false);
    }
  };

  return (
    <div>
      {/* ==================== 工具栏：业务/状态筛选 + 时间范围 + 搜索 + 重置/刷新 ==================== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Select
          placeholder="业务类型"
          allowClear
          style={{ width: 130 }}
          value={filterValues.biz}
          options={Object.entries(BIZ_MAP).map(([value, v]) => ({ value, label: v.label }))}
          onChange={(v) => onFilterChange('biz', v)}
        />
        <Select
          placeholder="文件状态"
          allowClear
          style={{ width: 130 }}
          value={filterValues.file_status}
          options={Object.entries(FILE_STATUS_MAP).map(([value, v]) => ({ value, label: v.label }))}
          onChange={(v) => onFilterChange('file_status', v)}
        />
        <DatePicker.RangePicker
          allowClear
          value={timeRange}
          onChange={onTimeRangeChange}
          style={{ width: 260 }}
        />
        <Input.Search
          placeholder="搜索路径/openid"
          allowClear
          style={{ width: 220 }}
          onSearch={(v) => {
            keywordRef.current = v;
            reload(1);
          }}
        />
        <Button onClick={onFilterReset}>重置</Button>
        <Button icon={<ReloadOutlined />} onClick={() => reload(1)} />
        <Button
          danger
          icon={<ClearOutlined />}
          loading={cleanupLoading}
          onClick={openCleanup}
          style={{ marginLeft: 'auto' }}
        >
          清理图片
        </Button>
      </div>

      {/* ==================== 卡片网格（6 列等宽，媒体大幅展示） ==================== */}
      {loading ? (
        <PageSkeleton type="cards" twoCol noCover toolbar />
      ) : list.length === 0 ? (
        <Card><Empty description="暂无文件记录" /></Card>
      ) : (
        <Row gutter={[16, 16]}>
          {list.map(record => (
            <Col span={4} key={record.file_id}>
              <FileCard
                record={record}
                onDetail={() => setDrawerRecord(record)}
                onDelete={openDelete}
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

      {/* ==================== 详情抽屉（复用模块 detailFields） ==================== */}
      <DetailDrawer
        title="文件详情"
        open={!!drawerRecord}
        record={drawerRecord}
        fields={UPLOADS_CFG.detailFields}
        onClose={() => setDrawerRecord(null)}
      />
    </div>
  );
}
