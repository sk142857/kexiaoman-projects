import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Button, Modal, Form, Input, Space, message, DatePicker, Row, Col,
  Tag, Badge, Card, Empty, Statistic, Typography,
} from 'antd';
import { CalendarOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { crudApi, uploadApi } from '../services/api';
import {
  ImageUploader, parseImages, fmtDateOnly, fmtDateTime, DictTag,
} from '../components/fields.jsx';
import { taskProgressOf } from '../config/modules.jsx';
import TaskCard, { TaskImages } from '../components/TaskCard.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import dayjs from 'dayjs';

// 打卡方式（与任务管理卡片页一致）
const CHECKIN_TYPE_MAP = {
  image: { label: '图文打卡', color: 'blue' },
  voice: { label: '语音打卡', color: 'warning' },
  video: { label: '视频打卡', color: 'cyan' },
};
// 发布来源（Web 后台 / 小程序）
const TASK_SOURCE_MAP = {
  web: { label: 'Web后台', color: 'purple' },
  miniprogram: { label: '小程序', color: 'blue' },
};

/** 读取音频时长（秒），元数据加载失败返回 0 */
const readAudioDuration = (url) => new Promise((resolve) => {
  const a = new Audio();
  a.preload = 'metadata';
  a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? Math.round(a.duration) : 0);
  a.onerror = () => resolve(0);
  a.src = url;
});

/** Blob → base64 dataURL */
const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(new Error('读取录音失败'));
  fr.readAsDataURL(blob);
});

export default function TodoTasksPage() {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState([]);
  const [count, setCount] = useState(0);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [current, setCurrent] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  // 任务状态字典：value -> { label, color }（直接取自字典，前端不另起炉灶）
  const [statusDict, setStatusDict] = useState({});
  // 语音打卡（浏览器 MediaRecorder）
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [recBlob, setRecBlob] = useState(null);
  const [recUrl, setRecUrl] = useState('');
  const [recDuration, setRecDuration] = useState(0);
  const recRef = useRef(null);
  const streamRef = useRef(null);

  const isVoiceTask = !!(current && current.checkin_type === 'voice');
  const isVideoTask = !!(current && current.checkin_type === 'video');

  const stopMedia = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

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

  // 任务状态字典（label / color 直接取自字典，供状态绑带展示）
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
  useEffect(() => {
    return () => {
      stopMedia();
      if (recRef.current && recording) { try { recRef.current.stop(); } catch (_) {} }
      if (recUrl) URL.revokeObjectURL(recUrl);
    };
  }, [recUrl, recording]);

  const openCheckin = (task) => {
    setCurrent(task);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    form.setFieldsValue({
      date: dayjs(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`),
      note: '',
      images: '',
    });
    // 重置录音状态
    stopMedia();
    if (recRef.current) { try { recRef.current.stop(); } catch (_) {} }
    recRef.current = null;
    setRecording(false);
    setRecorded(false);
    setRecBlob(null);
    if (recUrl) URL.revokeObjectURL(recUrl);
    setRecUrl('');
    setRecDuration(0);
    setCheckinOpen(true);
  };

  const startRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : (MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '');
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stopMedia();
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        if (blob.size === 0) {
          message.error('录音内容为空，请重试');
          setRecording(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        setRecBlob(blob);
        setRecUrl(url);
        const dur = await readAudioDuration(url);
        setRecDuration(Math.max(1, Math.min(60, dur || 1)));
        setRecorded(true);
        setRecording(false);
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (_) {
      message.error('无法访问麦克风，请授权后重试');
    }
  };

  const stopRecord = () => {
    if (recRef.current && recording) {
      recRef.current.stop();
    }
  };

  const reRecord = () => {
    if (recUrl) URL.revokeObjectURL(recUrl);
    setRecorded(false);
    setRecBlob(null);
    setRecUrl('');
    setRecDuration(0);
  };

  const submitCheckin = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (isVideoTask) {
        message.warning('视频打卡请在微信小程序端提交');
        return;
      }
      if (isVoiceTask) {
        if (!recorded || !recBlob) {
          message.warning('请先录制语音');
          return;
        }
        const dataUrl = await blobToDataURL(recBlob);
        const up = await uploadApi.upload('voice', dataUrl);
        const path = (up.data && up.data.path) || '';
        if (!path) throw new Error('语音上传失败');
        await crudApi.taskCheckin({
          taskId: current.task_id,
          date: values.date ? values.date.format('YYYY-MM-DD') : '',
          note: values.note,
          voiceUrl: path,
          voiceDuration: recDuration || 1,
        });
      } else {
        await crudApi.taskCheckin({
          taskId: current.task_id,
          date: values.date ? values.date.format('YYYY-MM-DD') : '',
          note: values.note,
          images: parseImages(values.images).slice(0, 9),
        });
      }
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

  // 组装卡片参数（author / actions / items / progress），复用 TaskCard 组件：
  // actions 仅保留「打卡」操作，其余管理按钮不传即不显示
  const buildCard = (record, progress) => {
    const desc = record.description;
    const overdue = record.deadline && String(record.deadline).slice(0, 10) < todayStr;
    const checkinTypeLabel = (CHECKIN_TYPE_MAP[record.checkin_type] || {}).label || record.checkin_type || '-';
    const assignees = Array.isArray(record.assignee_names) && record.assignee_names.length > 0
      ? record.assignee_names.join('、')
      : (record.assignee_names || '-');
    const tags = parseImages(record.tags);
    const name = record._creatorNickname || `#${record.created_by}`;
    return {
      author: { name, sub: `#${record.created_by}` },
      actions: [
        { key: 'checkin', type: 'primary', icon: <CalendarOutlined />, onClick: () => openCheckin(record), children: '打卡' },
      ],
      items: [
        {
          key: 'title',
          label: '任务标题',
          children: (
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {record.subject && <DictTag code="subject" value={record.subject} />}
              {overdue && <Tag color="red">已逾期</Tag>}
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.title || '-'}</span>
            </div>
          ),
        },
        {
          key: 'desc',
          label: '任务描述',
          children: (
            <div style={{ minHeight: 88, display: 'flex', alignItems: 'center', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {desc || '-'}
            </div>
          ),
        },
        { key: 'images', label: '任务图片', span: 2, children: <TaskImages images={record.images} /> },
        {
          key: 'link',
          label: '任务链接',
          span: 2,
          children: record.task_link ? (
            <a href={record.task_link} target="_blank" rel="noopener noreferrer">
              <LinkOutlined style={{ marginRight: 6, color: '#1677ff' }} />{record.task_link}
            </a>
          ) : '-',
        },
        { key: 'collection', label: '归属合集', children: record.collection_name || '-' },
        { key: 'checkinType', label: '打卡方式', children: checkinTypeLabel },
        { key: 'source', label: '发布来源', children: (() => { const c = TASK_SOURCE_MAP[record.source] || {}; return record.source ? <Tag color={c.color}>{c.label || record.source}</Tag> : '-'; })() },
        { key: 'score', label: '任务评分', children: record.score > 0 ? `${record.score}分` : '-' },
        {
          key: 'period',
          label: '任务周期',
          children: (
            <span style={overdue ? { color: '#f5222d' } : undefined}>
              {fmtDateOnly(record.start_date)} ~ {fmtDateOnly(record.deadline)}{overdue ? '（已逾期）' : ''}
            </span>
          ),
        },
        { key: 'checkinCount', label: '打卡次数', children: `${record.checkin_count || 0} 次` },
        { key: 'assignee', label: '派发学生', children: assignees },
        {
          key: 'tags',
          label: '任务标签',
          children: tags.length > 0
            ? <Space size={4} wrap>{tags.map((t, i) => <Tag key={`tag-${i}`} color="purple">{t}</Tag>)}</Space>
            : '-',
        },
        { key: 'taskId', label: '任务编号', children: record.task_id },
        { key: 'createdAt', label: '创建时间', children: fmtDateTime(record.created_at) },
        { key: 'updatedAt', label: '更新时间', children: fmtDateTime(record.updated_at) },
      ],
      progress,
    };
  };

  return (
    <div>
      {/* ===== 顶部统计 ===== */}
      <Card style={{ borderRadius: 16, border: 'none', marginBottom: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
        <Row gutter={16} align="middle">
          <Col flex="none">
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,#1677ff,#69b1ff)', color: '#fff', fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <CalendarOutlined />
            </div>
          </Col>
          <Col flex="auto">
            <div style={{ fontSize: 17, fontWeight: 700 }}>我的待办任务</div>
            <div style={{ fontSize: 13, color: '#8c8c8c', marginTop: 4 }}>完成学习后记得打卡，坚持就是进步</div>
          </Col>
          <Col flex="none">
            <Statistic title="待完成任务" value={count} suffix="条" valueStyle={{ color: '#1677ff' }} />
          </Col>
          <Col flex="none">
            <Button icon={<ReloadOutlined />} onClick={() => load()} />
          </Col>
        </Row>
      </Card>

      {/* ===== 待办任务卡片网格（2 列等宽，Badge.Ribbon 状态绑带，与任务管理卡片页一致） ===== */}
      {loading ? (
        <PageSkeleton type="cards" twoCol noCover />
      ) : list.length === 0 ? (
        <Card style={{ borderRadius: 16, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="太棒了，没有待办任务，可以放松一下啦" />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {list.map(record => {
            const status = statusOf(record.task_status);
            const progress = taskProgressOf(record);
            return (
              <Col span={12} key={record.task_id}>
                <Badge.Ribbon text={status.label} color={status.color} rootClassName="kxm-task-ribbon">
                  <Card style={{ height: '100%', display: 'flex', flexDirection: 'column' }} styles={{ body: { flex: 1, padding: '46px 16px 16px' } }}>
                    <TaskCard {...buildCard(record, progress)} />
                  </Card>
                </Badge.Ribbon>
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

          {isVoiceTask ? (
            <Form.Item label="语音打卡" extra="录制一段语音完成打卡（最长 60 秒）">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                {!recording && !recorded && (
                  <Button type="primary" onClick={startRecord}>开始录音</Button>
                )}
                {recording && (
                  <Button danger onClick={stopRecord}>录音中… 点击停止</Button>
                )}
                {recorded && (
                  <>
                    <audio controls src={recUrl} style={{ height: 36, maxWidth: 220 }} />
                    <span style={{ color: '#595959' }}>已录 {recDuration} 秒</span>
                    <Button onClick={reRecord}>重新录制</Button>
                  </>
                )}
              </div>
            </Form.Item>
          ) : isVideoTask ? (
            <Form.Item label="视频打卡">
              <Typography.Text type="warning">视频打卡请在微信小程序端操作：上传 ≤1GB 视频，提交后系统自动压缩存储。</Typography.Text>
            </Form.Item>
          ) : (
            <Form.Item name="images" label="打卡图片（最多9张）">
              <ImageUploader max={9} biz="tasks" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
