import React, { useState, useEffect, useCallback } from 'react';
import { Card, Row, Col, Tag, Button, Modal, Form, DatePicker, Input, Empty, Spin, Space, message, Tooltip, Image } from 'antd';
import { FlagOutlined, CalendarOutlined, PictureOutlined } from '@ant-design/icons';
import { ImageUploader, parseImages, toImageUrl, toThumbUrl, IMG_FALLBACK, fmtDateOnly } from '../components/fields.jsx';
import { crudApi } from '../services/api';
import dayjs from 'dayjs';

// 科目标签配色（柔和浅色系，不刺眼）
const SUBJECT_TAG = {
  语文: { bg: '#f0f5ff', color: '#2f54eb' },
  数学: { bg: '#f9f0ff', color: '#722ed1' },
  英语: { bg: '#fff0f6', color: '#c41d7f' },
  阅读: { bg: '#f6ffed', color: '#389e0d' },
  作业: { bg: '#fff7e6', color: '#d46b08' },
  运动: { bg: '#e6fffb', color: '#08979c' },
};
const FALLBACK_TAG_COLORS = [
  { bg: '#f0f5ff', color: '#2f54eb' },
  { bg: '#f9f0ff', color: '#722ed1' },
  { bg: '#e6fffb', color: '#08979c' },
  { bg: '#f6ffed', color: '#389e0d' },
];
const subjectTag = (subject) => {
  if (SUBJECT_TAG[subject]) return SUBJECT_TAG[subject];
  let h = 0;
  for (const ch of String(subject || '任务')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_TAG_COLORS[h % FALLBACK_TAG_COLORS.length];
};

const STATUS_MAP = {
  todo: { label: '未开始', color: 'default' },
  doing: { label: '进行中', color: 'processing' },
};

export default function TodoTasksPage() {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);
  const [count, setCount] = useState(0);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [current, setCurrent] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const res = await crudApi.todoTasks();
      setList(res.data.list || []);
      setCount(res.data.count || 0);
    } catch (_) {}
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCheckin = (task) => {
    setCurrent(task);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    form.setFieldsValue({
      date: dayjs(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`),
      note: '',
      images: '',
    });
    setCheckinOpen(true);
  };

  const submitCheckin = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await crudApi.taskCheckin({
        taskId: current.task_id,
        date: values.date ? values.date.format('YYYY-MM-DD') : '',
        note: values.note,
        images: parseImages(values.images).slice(0, 9),
      });
      message.success('打卡成功，等待老师审核');
      setCheckinOpen(false);
      load();
    } catch (e) {
      if (e?.errorFields) return;
    } finally {
      setSubmitting(false);
    }
  };

  const todayStr = dayjs().format('YYYY-MM-DD');

  return (
    <div>
      {/* ===== 顶部欢迎条（浅蓝清爽风格） ===== */}
      <Card style={{ borderRadius: 14, border: '1px solid #e8eef7', marginBottom: 16, overflow: 'hidden', boxShadow: '0 4px 16px rgba(31,56,105,0.08)' }} styles={{ body: { padding: 0 } }}>
        <div style={{ padding: '24px 28px', background: 'linear-gradient(120deg,#f2f7ff 0%,#e8f1ff 100%)', color: '#1f3a5f' }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: '#fff', border: '1px solid #d6e4ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: '#2f54eb' }}>
              <CalendarOutlined />
            </div>
            <div style={{ minWidth: 200 }}>
              <div style={{ fontSize: 19, fontWeight: 700 }}>我的待办任务</div>
              <div style={{ fontSize: 13, color: '#5a7ba8', marginTop: 4 }}>完成学习后记得打卡，坚持就是进步</div>
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ textAlign: 'center', padding: '0 18px', minWidth: 100 }}>
              <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1, color: '#2f54eb' }}>{count}</div>
              <div style={{ fontSize: 13, color: '#5a7ba8', marginTop: 4 }}>待完成任务</div>
            </div>
          </div>
        </div>
      </Card>

      {/* ===== 任务卡片 ===== */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 90 }}><Spin size="large" /></div>
      ) : list.length === 0 ? (
        <Card>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="太棒了，没有待办任务，可以放松一下啦 🎉" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {list.map(t => {
            const status = STATUS_MAP[t.task_status] || { label: t.task_status, color: 'default' };
            const overdue = t.deadline && String(t.deadline).slice(0, 10) < todayStr;
            const tag = subjectTag(t.subject);
            // 任务图片：默认取第一张作为封面，全铺展示
            const cover = parseImages(t.images)[0];
            return (
              <Col xs={24} sm={12} lg={8} xl={6} key={t.task_id}>
                <Card
                  hoverable
                  style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid #eef1f5', boxShadow: '0 2px 10px rgba(0,0,0,0.05)' }}
                  styles={{ body: { padding: 0 } }}
                >
                  {/* 封面图（第一张，全铺；加载失败回退占位图） */}
                  {cover ? (
                    <div style={{ position: 'relative', width: '100%', height: 150, overflow: 'hidden', background: '#f5f6f8' }}>
                      <Image
                        src={toThumbUrl(cover, 600)}
                        fallback={IMG_FALLBACK}
                        alt=""
                        width="100%"
                        height={150}
                        style={{ objectFit: 'cover', display: 'block' }}
                        preview={false}
                      />
                      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}>
                        <Tag color={status.color} style={{ margin: 0, fontSize: 12 }}>{status.label}</Tag>
                      </div>
                    </div>
                  ) : (
                    <div style={{ position: 'relative', width: '100%', height: 150, background: 'linear-gradient(120deg,#f7f9fc 0%,#eef3fa 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <PictureOutlined style={{ fontSize: 36, color: '#c6d2e4' }} />
                      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}>
                        <Tag color={status.color} style={{ margin: 0, fontSize: 12 }}>{status.label}</Tag>
                      </div>
                    </div>
                  )}

                  <div style={{ padding: '16px 16px 18px' }}>
                    {/* 标题 + 标签 */}
                    <div style={{ fontSize: 15, fontWeight: 600, color: '#1f2329', lineHeight: 1.5, marginBottom: 10, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {t.title || `任务 #${t.task_id}`}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                      {t.subject && <Tag style={{ background: tag.bg, color: tag.color, borderColor: 'transparent', margin: 0, fontSize: 12 }}>{t.subject}</Tag>}
                      {t.collection_name && <Tag style={{ background: '#f5f5f5', color: '#595959', borderColor: '#e8e8e8', margin: 0, fontSize: 12 }}>{t.collection_name}</Tag>}
                    </div>

                    {/* 截止 / 评分 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <Space size={8}>
                        <FlagOutlined style={{ color: overdue ? '#f5222d' : '#8c8c8c', fontSize: 13 }} />
                        <span style={{ color: overdue ? '#f5222d' : '#595959', fontSize: 13 }}>
                          {t.deadline ? `截止 ${fmtDateOnly(t.deadline)}${overdue ? '（已逾期）' : ''}` : '无截止日期'}
                        </span>
                      </Space>
                      {t.score > 0 && (
                        <Tooltip title="任务评分">
                          <Space size={4}><span style={{ color: '#fa8c16', fontWeight: 600, fontSize: 13 }}>{t.score}分</span></Space>
                        </Tooltip>
                      )}
                    </div>

                    {/* 打卡次数（真实计数，不做伪进度条） */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                      <Space size={6}>
                        <CalendarOutlined style={{ color: '#1677ff', fontSize: 13 }} />
                        <span style={{ fontSize: 13, color: '#595959' }}>已打卡 <b style={{ color: '#1677ff' }}>{t.checkin_count || 0}</b> 次</span>
                      </Space>
                      <span style={{ fontSize: 12, color: '#bfbfbf' }}>开始 {t.start_date ? fmtDateOnly(t.start_date) : '-'}</span>
                    </div>

                    {/* 打卡按钮 */}
                    <Button
                      type="primary"
                      block
                      size="large"
                      style={{ marginTop: 16, borderRadius: 8, height: 42, fontWeight: 500, background: '#1677ff', border: 'none' }}
                      icon={<CalendarOutlined />}
                      onClick={() => openCheckin(t)}
                    >
                      去打卡
                    </Button>
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      {/* ===== 打卡弹窗 ===== */}
      <Modal
        title={`任务打卡${current ? `：${current.title || ''}` : ''}`}
        open={checkinOpen}
        onOk={submitCheckin}
        onCancel={() => setCheckinOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        width={560}
        okText="提交打卡"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="date" label="打卡日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="打卡备注">
            <Input.TextArea rows={3} maxLength={200} placeholder="记录本次学习情况..." />
          </Form.Item>
          <Form.Item name="images" label="打卡图片（最多9张）">
            <ImageUploader max={9} biz="tasks" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
