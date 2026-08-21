import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Modal, Form, Input, Select, message, Row, Col, Tag, Avatar, Badge,
  Card, Empty, Statistic,
} from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined, AuditOutlined } from '@ant-design/icons';
import {
  AudioPlayer, VideoPlayer, fmtDateTime, DictTag,
} from '../components/fields.jsx';
import TaskCard, { TaskImages } from '../components/TaskCard.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import { crudApi } from '../services/api';

// 打卡方式（与任务管理卡片页一致）
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
// 任务状态字典（label / color 直接取自字典）
const STATUS_MAP = { todo: '待完成', doing: '进行中', done: '已完成' };
const STATUS_COLOR = { todo: 'default', doing: 'processing', done: 'success' };
const SCORE_OPTIONS = [0, 3, 5, 7, 9, 10].map(v => ({ value: v, label: `${v}分` }));
// 内容安全状态（打卡内容机器检测结果）
const RISK_STATUS_MAP = {
  pass: { label: '安全', color: 'success' },
  pending: { label: '检测中', color: 'processing' },
  reject: { label: '违规', color: 'error' },
};

export default function CheckinReviewsPage() {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);
  const [count, setCount] = useState(0);
  const [rejectVisible, setRejectVisible] = useState(false);
  const [rejectItem, setRejectItem] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const res = await crudApi.checkinReviewList();
      setList(res.data.list || []);
      setCount(res.data.count || 0);
    } catch (_) {}
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onApprove = (record) => {
    Modal.confirm({
      title: '审核通过',
      content: `确认通过「${record.student.nickname || '学生'}」对「${record.task_title || ''}」的打卡？任务将自动标记为已完成并得 10 分。`,
      okText: '通过',
      cancelText: '再想想',
      onOk: async () => {
        try {
          await crudApi.checkinReview({ checkinId: record.checkin_id, action: 'approve' });
          message.success('已通过，任务完成 +10 分');
          load(true);
        } catch (_) {}
      },
    });
  };

  const openReject = (record) => {
    setRejectItem(record);
    form.setFieldsValue({ score: 0, note: '' });
    setRejectVisible(true);
  };

  const submitReject = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await crudApi.checkinReview({
        checkinId: rejectItem.checkin_id,
        action: 'reject',
        score: Number(values.score) || 0,
        note: values.note || '',
      });
      message.success('已驳回');
      setRejectVisible(false);
      load(true);
    } catch (e) {
      if (e?.errorFields) return;
    } finally {
      setSubmitting(false);
    }
  };

  const statusOf = (v) => ({ label: STATUS_MAP[v] || v || '-', color: STATUS_COLOR[v] || 'default' });

  // 组装卡片参数（author / actions / items），复用 TaskCard 组件：
  // actions 仅保留审核按钮（通过/不通过），并在字段区增加用户提交的打卡内容 / 打卡图片 / 语音
  const buildCard = (record) => {
    const status = statusOf(record.task_status);
    const checkinTypeLabel = (CHECKIN_TYPE_MAP[record.checkin_type] || {}).label || record.checkin_type || '-';
    return {
      author: {
        name: record.student.nickname || '学生',
        sub: `#${record.student.staff_id}`,
        avatar: (
          <Avatar size={40} style={{ background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', color: '#fff', fontSize: 17, flexShrink: 0 }}>
            {String(record.student.nickname || '生').charAt(0)}
          </Avatar>
        ),
      },
      actions: [
        { key: 'reject', danger: true, icon: <CloseOutlined />, onClick: () => openReject(record), children: '不通过' },
        { key: 'approve', type: 'primary', icon: <CheckOutlined />, style: { background: '#52c41a', borderColor: '#52c41a' }, onClick: () => onApprove(record), children: '通过' },
      ],
      items: [
        {
          key: 'task',
          label: '任务标题',
          children: (
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {record.task_subject && <DictTag code="subject" value={record.task_subject} />}
              <Tag color={status.color} style={{ margin: 0 }}>{status.label}</Tag>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.task_title || '-'}</span>
            </div>
          ),
        },
        { key: 'date', label: '打卡日期', children: record.checkin_date || '-' },
        { key: 'type', label: '打卡方式', children: checkinTypeLabel },
        { key: 'source', label: '打卡来源', children: (() => { const c = TASK_SOURCE_MAP[record.source] || {}; return record.source ? <Tag color={c.color}>{c.label || record.source}</Tag> : '-'; })() },
        { key: 'riskStatus', label: '内容安全', children: (() => { const c = RISK_STATUS_MAP[record.risk_status] || {}; return record.risk_status ? <Tag color={c.color}>{c.label || record.risk_status}</Tag> : '-'; })() },
        { key: 'submit', label: '提交时间', children: fmtDateTime(record.created_at) },
        {
          key: 'note',
          label: '打卡内容',
          span: 2,
          children: (
            <div style={{ minHeight: 60, display: 'flex', alignItems: 'center', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {record.checkin_note || '-'}
            </div>
          ),
        },
        // 按打卡模式展示对应媒体：图文打卡显图片、语音打卡显语音、视频打卡显视频，互不混显
        ...(record.checkin_type === 'image'
          ? [{ key: 'images', label: '打卡图片', span: 2, children: <TaskImages images={record.images} /> }]
          : []),
        ...(record.checkin_type === 'voice' && record.voice_url
          ? [{ key: 'voice', label: '语音打卡', span: 2, children: <AudioPlayer value={record.voice_url} duration={record.voice_duration} /> }]
          : []),
        ...(record.checkin_type === 'video' && record.video_url
          ? [{ key: 'video', label: '视频打卡', span: 2, children: <VideoPlayer value={record.video_url} duration={record.video_duration} size={record.video_size} poster={record.video_cover} /> }]
          : []),
        { key: 'studentName', label: '提交学生', children: record.student.username || record.student.nickname || '-' },
      ],
    };
  };

  return (
    <div>
      {/* ===== 顶部统计 ===== */}
      <Card style={{ borderRadius: 16, border: 'none', marginBottom: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
        <Row gutter={16} align="middle">
          <Col flex="none">
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,#722ed1,#b37feb)', color: '#fff', fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <AuditOutlined />
            </div>
          </Col>
          <Col flex="auto">
            <div style={{ fontSize: 17, fontWeight: 700 }}>打卡审核</div>
            <div style={{ fontSize: 13, color: '#8c8c8c', marginTop: 4 }}>学生提交打卡后进入这里，通过即完成任务并得 10 分</div>
          </Col>
          <Col flex="none">
            <Statistic title="待审核打卡" value={count} suffix="条" valueStyle={{ color: '#722ed1' }} />
          </Col>
          <Col flex="none">
            <Button icon={<ReloadOutlined />} onClick={() => load()} />
          </Col>
        </Row>
      </Card>

      {/* ===== 待审核打卡卡片网格（2 列等宽，Badge.Ribbon 状态绑带，与任务管理卡片页一致） ===== */}
      {loading ? (
        <PageSkeleton type="cards" twoCol noCover />
      ) : list.length === 0 ? (
        <Card style={{ borderRadius: 16, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待审核打卡，学生提交打卡后会自动出现在这里" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {list.map(r => (
            <Col span={12} key={r.checkin_id}>
              <Badge.Ribbon text="待审核" color="warning" rootClassName="kxm-task-ribbon">
                <Card style={{ height: '100%', display: 'flex', flexDirection: 'column' }} styles={{ body: { flex: 1, padding: '46px 16px 16px' } }}>
                  <TaskCard {...buildCard(r)} />
                </Card>
              </Badge.Ribbon>
            </Col>
          ))}
        </Row>
      )}

      {/* ===== 驳回弹窗 ===== */}
      <Modal
        title="审核不通过"
        open={rejectVisible}
        onOk={submitReject}
        onCancel={() => setRejectVisible(false)}
        destroyOnClose
        confirmLoading={submitting}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        width={520}
      >
        {rejectItem && (
          <div style={{ marginBottom: 8, color: '#8c8c8c', fontSize: 13 }}>
            {rejectItem.student.nickname || '学生'} · {rejectItem.task_title || ''}
          </div>
        )}
        <Form form={form} layout="vertical">
          <Form.Item name="score" label="评分（0-10）" rules={[{ required: true, message: '请选择评分' }]}>
            <Select options={SCORE_OPTIONS} placeholder="请选择评分" />
          </Form.Item>
          <Form.Item name="note" label="审核说明 / 原因">
            <Input.TextArea rows={3} maxLength={500} placeholder="请填写不通过原因（选填）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
