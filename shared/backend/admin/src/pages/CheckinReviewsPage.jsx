import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Button, Tag, Space, Modal, Form, Input, Select, Avatar, message, Statistic, Row, Col } from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined, AuditOutlined } from '@ant-design/icons';
import { ImageList, fmtDateTime, EmptyText } from '../components/fields.jsx';
import { crudApi } from '../services/api';

const STATUS_MAP = { todo: '未开始', doing: '进行中', done: '已完成' };
const STATUS_COLOR = { todo: 'default', doing: 'processing', done: 'success' };
const SCORE_OPTIONS = [0, 3, 5, 7, 9, 10].map(v => ({ value: v, label: `${v}分` }));

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

  const columns = [
    {
      title: '学生', dataIndex: ['student', 'nickname'], key: 'student', width: 140,
      render: (_, r) => (
        <Space size={8}>
          <Avatar style={{ background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', color: '#fff' }}>
            {String(r.student.nickname || '生').charAt(0)}
          </Avatar>
          <div>
            <div style={{ fontWeight: 600 }}>{r.student.nickname || '学生'}</div>
            <div style={{ fontSize: 12, color: '#999' }}>{r.student.username}</div>
          </div>
        </Space>
      ),
    },
    { title: '任务', dataIndex: 'task_title', key: 'task_title', width: 200, ellipsis: true },
    { title: '任务状态', dataIndex: 'task_status', key: 'task_status', width: 90, render: (v) => <Tag color={STATUS_COLOR[v] || 'default'}>{STATUS_MAP[v] || v || '-'}</Tag> },
    { title: '打卡日期', dataIndex: 'checkin_date', key: 'checkin_date', width: 110 },
    { title: '备注', dataIndex: 'checkin_note', key: 'checkin_note', width: 220, render: (v) => (v ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{v}</div> : <EmptyText />) },
    { title: '图片', dataIndex: 'images', key: 'images', width: 170, render: (v) => <ImageList value={v || []} thumb={44} /> },
    { title: '提交时间', dataIndex: 'created_at', key: 'created_at', width: 150, render: (v) => fmtDateTime(v) },
    {
      title: '操作', key: 'op', width: 150, fixed: 'right',
      render: (_, r) => (
        <Space size={0}>
          <Button type="link" size="small" style={{ color: '#52c41a' }} icon={<CheckOutlined />} onClick={() => onApprove(r)}>通过</Button>
          <Button type="link" size="small" danger icon={<CloseOutlined />} onClick={() => openReject(r)}>驳回</Button>
        </Space>
      ),
    },
  ];

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

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="checkin_id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={list}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{ emptyText: '暂无待审核打卡，学生提交打卡后会自动出现在这里' }}
          scroll={{ x: 1200 }}
        />
      </Card>

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
