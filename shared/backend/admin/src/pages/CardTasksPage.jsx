// 任务管理（卡片模式）
// 与「任务管理」模块功能完全一致（增删改/复制/打卡/时间轴/详情/合集/按用户过滤/搜索/分页），仅布局不同：
// 手动 Row/Col + Card 卡片网格（每行 2 列等宽，Badge.Ribbon 状态绑带包住整张卡片），
// 复用 MODULES.tasks 的字段配置与后端 /admin/api/tasks 接口。
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Button, Modal, Form, Input, Select, Space, message, DatePicker, Row, Col,
  Image, Tag, Badge, Card, Pagination, Empty, Spin,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, EditOutlined, DeleteOutlined, CalendarOutlined,
  FolderOutlined, HistoryOutlined, CopyOutlined, PictureOutlined, LinkOutlined,
} from '@ant-design/icons';
import { crudApi, uploadApi } from '../services/api';
import DetailDrawer from '../components/DetailDrawer.jsx';
import TimelineDrawer from '../components/TimelineDrawer.jsx';
import {
  ImageUploader, AssigneeSelect, parseImages, imagesToJson, toThumbUrl,
  IMG_FALLBACK, fmtDateOnly, fmtDateTime, DictTag, ColorTag,
} from '../components/fields.jsx';
import { MODULES, taskProgressOf } from '../config/modules.jsx';
import TaskCard, { TaskImages } from '../components/TaskCard.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import dayjs from 'dayjs';

const TASKS_CFG = MODULES.tasks;

// 任务状态文案与颜色统一取自 task_status 数据字典；进度由任务独立字段 progress 驱动（taskProgressOf 兜底状态）
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

export default function CardTasksPage() {
  const keywordRef = useRef('');
  const filterRef = useRef({});
  const pageRef = useRef(1);
  const pageSizeRef = useRef(16);
  const [filterValues, setFilterValues] = useState({});
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const [drawerRecord, setDrawerRecord] = useState(null);
  const [timelineRecord, setTimelineRecord] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  const [checkinOpen, setCheckinOpen] = useState(false);
  const [checkinTask, setCheckinTask] = useState(null);
  const [checkinForm] = Form.useForm();
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [recBlob, setRecBlob] = useState(null);
  const [recUrl, setRecUrl] = useState('');
  const [recDuration, setRecDuration] = useState(0);
  const recRef = useRef(null);
  const streamRef = useRef(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKw, setPickerKw] = useState('');
  const [pickerList, setPickerList] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const [dynamicOptions, setDynamicOptions] = useState({});
  const [collectionOptions, setCollectionOptions] = useState([]);
  const [staffFilterOptions, setStaffFilterOptions] = useState([]);
  const [staffIdInput, setStaffIdInput] = useState('');
  // 任务状态字典：value -> { label, color }（直接取自字典，前端不另起炉灶）
  const [statusDict, setStatusDict] = useState({});
  const [statusOptions, setStatusOptions] = useState([]);

  let currentStaff = {};
  try { currentStaff = JSON.parse(localStorage.getItem('admin_user') || '{}'); } catch (_) {}
  const isAdmin = currentStaff.role === 'admin';

  const stopMedia = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

  // ==================== 动态下拉（表单字段 optionsSource + 筛选 optionsSource） ====================
  const loadOptions = useCallback(async (src, params) => {
    const key = `${src}:${JSON.stringify(params || {})}`;
    if (dynamicOptions[key]) return;
    try {
      const res = await crudApi.list(src, { page: 1, pageSize: 100, ...(params || {}) });
      setDynamicOptions(prev => ({ ...prev, [key]: res.data.list || [] }));
    } catch (_) {}
  }, [dynamicOptions]);

  useEffect(() => {
    TASKS_CFG.formFields.filter(f => f.optionsSource).forEach(f => loadOptions(f.optionsSource, f.optionsParams));
  }, [loadOptions]);

  const buildSourceOptions = (f) => {
    const key = `${f.optionsSource}:${JSON.stringify(f.optionsParams || {})}`;
    const map = f.optionsMap || {};
    return (dynamicOptions[key] || []).map(item => {
      const text = item[map.label];
      const color = item.color || item[map.color] || '';
      return {
        value: item[map.value],
        searchText: String(text ?? ''),
        label: color ? <ColorTag value={text} color={color} /> : (text ?? ''),
      };
    });
  };

  // 合集筛选下拉
  const loadCollectionOptions = useCallback(async (kw) => {
    try {
      const res = await crudApi.list('task_collections', { page: 1, pageSize: 50, keyword: kw || '' });
      setCollectionOptions(res.data.list || []);
    } catch (_) {}
  }, []);

  // 合集弹窗列表
  const loadPickerList = useCallback(async (kw) => {
    setPickerLoading(true);
    try {
      const res = await crudApi.list('task_collections', { page: 1, pageSize: 100, keyword: kw || '' });
      setPickerList(res.data.list || []);
    } catch (_) {
      setPickerList([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCollectionOptions('');
  }, [loadCollectionOptions]);

  // 任务状态字典（label / color 直接取自字典，用于卡片绑带、进度条与状态筛选）
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
        setStatusOptions(list.map(it => ({ value: it.item_value, label: it.item_label || it.item_value })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 状态查询辅助：dict 兜底
  const statusOf = (v) => statusDict[v] || { label: v || '-', color: '#bfbfbf' };

  // 按用户过滤（仅管理员展示筛选入口）：全部员工下拉
  useEffect(() => {
    let alive = true;
    crudApi.list('staff', { page: 1, pageSize: 500 })
      .then((res) => {
        if (!alive) return;
        setStaffFilterOptions((res.data.list || []).map(s => ({
          value: s.staff_id,
          label: s.staff_nickname || s.staff_username || String(s.staff_id),
          searchText: `${s.staff_nickname || ''} ${s.staff_username || ''} ${s.staff_id || ''}`,
        })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // ==================== 列表加载（复用 /admin/api/tasks 通用 CRUD 接口） ====================
  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const q = {
        page: pageRef.current,
        pageSize: pageSizeRef.current,
        keyword: keywordRef.current,
        ...filterRef.current,
      };
      const res = await crudApi.list('tasks', q);
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
    setStaffIdInput('');
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

  const pickCollection = (id) => {
    filterRef.current.collection_id = id;
    setFilterValues(prev => ({ ...prev, collection_id: id }));
    setPickerOpen(false);
    reload(1);
  };

  const clearCollectionFilter = () => {
    filterRef.current.collection_id = undefined;
    setFilterValues(prev => ({ ...prev, collection_id: undefined }));
    setPickerOpen(false);
    reload(1);
  };

  // ==================== 新增/编辑/复制 ====================
  const setFormFromRecord = (record) => {
    form.setFieldsValue(record);
    TASKS_CFG.formFields.forEach(f => {
      if (f.type === 'date' && record[f.name]) {
        form.setFieldsValue({ [f.name]: dayjs(record[f.name]) });
      }
      if (f.type === 'tags' || f.type === 'images') {
        form.setFieldsValue({ [f.name]: parseImages(record[f.name]) });
      }
    });
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    if (TASKS_CFG.createDefaults) {
      const defaults = typeof TASKS_CFG.createDefaults === 'function' ? TASKS_CFG.createDefaults() : TASKS_CFG.createDefaults;
      form.setFieldsValue(defaults);
      TASKS_CFG.formFields.forEach(f => {
        if (f.type === 'date' && defaults[f.name]) {
          form.setFieldsValue({ [f.name]: dayjs(defaults[f.name]) });
        }
      });
    }
    if (TASKS_CFG.formFields.some(f => f.type === 'assignee') && !isAdmin && currentStaff.staff_id != null) {
      form.setFieldsValue({ assignee_ids: [Number(currentStaff.staff_id)] });
    }
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditing(record);
    form.resetFields();
    setFormFromRecord(record);
    setModalOpen(true);
  };

  const openCopy = (record) => {
    setEditing(null);
    form.resetFields();
    const copy = { ...record };
    TASKS_CFG.formFields.forEach(f => {
      if (f.type === 'date') {
        copy[f.name] = dayjs();
      } else if (f.type === 'tags' || f.type === 'images') {
        copy[f.name] = parseImages(record[f.name]);
      }
    });
    if (TASKS_CFG.formFields.some(f => f.type === 'assignee') && !isAdmin && currentStaff.staff_id != null) {
      copy.assignee_ids = [Number(currentStaff.staff_id)];
    }
    if (Array.isArray(TASKS_CFG.copyReset)) {
      TASKS_CFG.copyReset.forEach(f => { if (TASKS_CFG.formFields.some(ff => ff.name === f)) copy[f] = 0; });
    }
    if (TASKS_CFG.copyResetValues) {
      Object.entries(TASKS_CFG.copyResetValues).forEach(([f, v]) => {
        if (TASKS_CFG.formFields.some(ff => ff.name === f)) copy[f] = v;
      });
    }
    if (TASKS_CFG.titlePk) delete copy[TASKS_CFG.titlePk.field];
    form.setFieldsValue(copy);
    setModalOpen(true);
  };

  const onSubmit = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch (e) {
      if (e?.errorFields) return;
      return;
    }
    setSubmitting(true);
    TASKS_CFG.formFields.forEach(f => {
      if (f.type === 'date' && values[f.name]) {
        values[f.name] = dayjs(values[f.name]).format('YYYY-MM-DD');
      }
      if (f.type === 'number' && values[f.name] !== undefined && values[f.name] !== null && values[f.name] !== '') {
        values[f.name] = Number(values[f.name]);
      }
      if (f.type === 'images' || f.type === 'tags') {
        values[f.name] = imagesToJson(values[f.name]);
      }
    });
    try {
      if (editing) {
        await crudApi.update('tasks', editing.task_id, values);
        message.success('更新成功');
      } else {
        await crudApi.create('tasks', values);
        message.success('创建成功');
      }
      setModalOpen(false);
      fetchList();
    } catch (_) {
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== 删除（级联提醒复用 MODULES.tasks.deleteTip） ====================
  const openDeleteConfirm = async (record) => {
    let tip = '';
    if (TASKS_CFG.deleteTip) {
      try { tip = await TASKS_CFG.deleteTip(record); } catch (_) {}
    }
    setConfirmState({ record, tip });
  };

  const onDelete = async (record) => {
    try {
      await crudApi.remove('tasks', record.task_id);
      message.success('已删除');
      setConfirmState(null);
      fetchList();
    } catch (_) {}
  };

  // ==================== 打卡（图文 + 语音） ====================
  const isVoiceTask = !!(checkinTask && checkinTask.checkin_type === 'voice');

  const openCheckin = (task) => {
    setCheckinTask(task);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    checkinForm.setFieldsValue({
      date: dayjs(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`),
      note: '',
      images: '',
    });
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
    if (recRef.current && recording) recRef.current.stop();
  };

  const reRecord = () => {
    if (recUrl) URL.revokeObjectURL(recUrl);
    setRecorded(false);
    setRecBlob(null);
    setRecUrl('');
    setRecDuration(0);
  };

  const submitCheckin = async () => {
    let values;
    try {
      values = await checkinForm.validateFields();
    } catch (e) {
      if (e?.errorFields) return;
      return;
    }
    setSubmitting(true);
    try {
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
          taskId: checkinTask.task_id,
          date: values.date ? values.date.format('YYYY-MM-DD') : '',
          note: values.note,
          voiceUrl: path,
          voiceDuration: recDuration || 1,
        });
      } else {
        await crudApi.taskCheckin({
          taskId: checkinTask.task_id,
          date: values.date ? values.date.format('YYYY-MM-DD') : '',
          note: values.note,
          images: parseImages(values.images).slice(0, 9),
        });
      }
      message.success('打卡成功，等待老师审核');
      setCheckinOpen(false);
      fetchList();
    } catch (e) {
      if (e?.errorFields) return;
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== 行权限（与任务管理一致） ====================
  const isLocked = (record) => (TASKS_CFG.lockFn ? !!TASKS_CFG.lockFn(record, { isAdmin }) : false);
  const lockTipOf = (record) => (TASKS_CFG.lockFn ? (TASKS_CFG.lockFn(record, { isAdmin }) || undefined) : undefined);
  const isOwnRow = (record) => !TASKS_CFG.ownField || String(record[TASKS_CFG.ownField] || '') === String(currentStaff.staff_id || '');
  const ownOnly = (record) => !isAdmin && !isOwnRow(record);

  // ==================== 卡片渲染 ====================
  const todayStr = dayjs().format('YYYY-MM-DD');

  // 组装卡片参数（author / actions / items / progress），复用 TaskCard 组件：
  // actions 数组即按钮权限控制——管理端传全部操作，被锁定/非本人记录按需禁用或隐藏
  const buildCard = (record, progress) => {
    const desc = record.description;
    const overdue = record.deadline && String(record.deadline).slice(0, 10) < todayStr && record.task_status !== 'done';
    const checkinTypeLabel = (CHECKIN_TYPE_MAP[record.checkin_type] || {}).label || record.checkin_type || '-';
    const assignees = Array.isArray(record.assignee_names) && record.assignee_names.length > 0
      ? record.assignee_names.join('、')
      : (record.assignee_names || '-');
    const tags = parseImages(record.tags);
    const locked = isLocked(record);
    const lockTip = lockTipOf(record);
    const ownHidden = ownOnly(record);
    const name = record._creatorNickname || `#${record.created_by}`;
    return {
      author: { name, sub: `#${record.created_by}` },
      actions: [
        { key: 'checkin', type: 'primary', icon: <CalendarOutlined />, disabled: locked, title: lockTip, onClick: () => openCheckin(record), children: '打卡' },
        { key: 'detail', icon: <EyeOutlined />, onClick: () => setDrawerRecord(record), children: '详情' },
        { key: 'timeline', icon: <HistoryOutlined />, onClick: () => setTimelineRecord(record), children: '流程' },
        ...(ownHidden ? [] : [
          { key: 'edit', icon: <EditOutlined />, disabled: locked, title: lockTip, onClick: () => openEdit(record), children: '编辑' },
          { key: 'copy', icon: <CopyOutlined />, onClick: () => openCopy(record), children: '复制' },
          { key: 'delete', type: 'primary', danger: true, ghost: true, disabled: locked, title: lockTip, onClick: () => openDeleteConfirm(record), children: '删除' },
        ]),
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

  // ==================== 表单字段渲染（复用 MODULES.tasks.formFields） ====================
  const renderField = (f) => {
    const autoPlaceholder = () => {
      if (f.placeholder) return f.placeholder;
      const base = String(f.label || '').replace(/[（(].*?[)）]/g, '').trim();
      if (f.type === 'date') return base ? `请选择${base}` : '请选择日期';
      if (f.type === 'select') return base ? `请选择${base}` : '请选择';
      return base ? `请输入${base}` : '请输入';
    };
    if (f.type === 'select') {
      const options = f.options || (f.optionsSource ? buildSourceOptions(f) : []);
      return (
        <Select
          options={options}
          placeholder={autoPlaceholder()}
          disabled={(f.disabledWhenCreate && !editing) || (typeof f.disabled === 'function' ? f.disabled() : f.disabled)}
          showSearch={f.showSearch}
          allowClear={f.allowClear}
          filterOption={f.showSearch ? (input, option) => String(option?.searchText ?? option?.value ?? '').toLowerCase().includes(String(input || '').toLowerCase()) : true}
        />
      );
    }
    if (f.type === 'textarea') return <Input.TextArea rows={3} placeholder={autoPlaceholder()} />;
    if (f.type === 'number') return <Input type="number" placeholder={autoPlaceholder()} />;
    if (f.type === 'date') return <DatePicker style={{ width: '100%' }} placeholder={autoPlaceholder()} />;
    if (f.type === 'images') return <ImageUploader max={f.max || 9} biz={f.biz || 'tasks'} size={f.size || 96} square={f.square} />;
    if (f.type === 'assignee') return <AssigneeSelect disabled={!isAdmin} />;
    if (f.type === 'tags') return <Select mode="tags" style={{ width: '100%' }} placeholder={f.placeholder || '输入后回车添加'} tokenSeparators={[',']} open={false} />;
    return <Input placeholder={autoPlaceholder()} />;
  };

  const splitForm = TASKS_CFG.formFields.some(f => f.side === 'right');
  const leftFields = TASKS_CFG.formFields.filter(f => f.side !== 'right');
  const rightFields = TASKS_CFG.formFields.filter(f => f.side === 'right');

  const renderFormField = (f) => {
    const span = f.span || ((TASKS_CFG.formColumns > 1) ? 12 : 24);
    const extra = (f.type === 'assignee' && !isAdmin)
      ? '学生自建任务派发固定为本人，不可修改'
      : (typeof f.tip === 'function' ? f.tip({ editing }) : f.tip);
    return (
      <Col key={f.name} span={span}>
        <Form.Item name={f.name} label={f.label} rules={f.rules || []} extra={extra} style={{ marginBottom: 16 }}>
          {renderField(f)}
        </Form.Item>
      </Col>
    );
  };

  const formFieldsToRender = TASKS_CFG.formFields.filter(f => !(f.hideWhenKind && f.hideWhenKind.length > 0));

  // ==================== 筛选栏 ====================
  const filterSelects = (
    <Space size={8} wrap>
      {isAdmin && (
        <Space.Compact>
          <Select
            placeholder="选择用户"
            allowClear
            showSearch
            style={{ width: 170 }}
            value={filterValues.staff_id}
            options={staffFilterOptions}
            filterOption={(input, option) => String(option?.searchText ?? option?.label ?? '').toLowerCase().includes(String(input || '').toLowerCase())}
            onChange={(v) => onFilterChange('staff_id', v)}
          />
          <Input
            placeholder="或输入staff_id"
            allowClear
            style={{ width: 132 }}
            value={staffIdInput}
            onChange={(e) => setStaffIdInput(e.target.value)}
            onPressEnter={() => {
              const v = String(staffIdInput || '').trim();
              onFilterChange('staff_id', v ? v : undefined);
            }}
          />
        </Space.Compact>
      )}
      <Select
        placeholder="任务状态"
        allowClear
        value={filterValues.task_status}
        style={{ width: 130 }}
        options={statusOptions}
        onChange={(v) => onFilterChange('task_status', v)}
      />
      <Select
        placeholder="科目"
        allowClear
        showSearch
        value={filterValues.subject}
        style={{ width: 130 }}
        options={TASKS_CFG.filters.find(f => f.name === 'subject') ? buildSourceOptions({ optionsSource: 'dict_items', optionsParams: { dict_code: 'subject' }, optionsMap: { value: 'item_value', label: 'item_label' } }) : []}
        onChange={(v) => onFilterChange('subject', v)}
      />
      <Select
        placeholder="合集"
        allowClear
        showSearch
        filterOption={false}
        value={filterValues.collection_id}
        style={{ width: 160 }}
        options={collectionOptions.map(c => ({ value: c.collection_id, label: c.name }))}
        onFocus={() => loadCollectionOptions('')}
        onSearch={loadCollectionOptions}
        onChange={(v) => onFilterChange('collection_id', v)}
      />
      <Select
        placeholder="发布来源"
        allowClear
        value={filterValues.source}
        style={{ width: 130 }}
        options={[{ value: 'web', label: 'Web后台' }, { value: 'miniprogram', label: '小程序' }]}
        onChange={(v) => onFilterChange('source', v)}
      />
      <Button onClick={onFilterReset}>重置</Button>
    </Space>
  );

  return (
    <>
      {/* ==================== 工具栏：筛选 + 搜索 + 合集 + 新增 ==================== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        {filterSelects}
        <Input.Search
          placeholder="搜索标题/科目"
          allowClear
          style={{ width: 200 }}
          onSearch={(v) => {
            keywordRef.current = v;
            reload(1);
          }}
        />
        <Button icon={<FolderOutlined />} onClick={() => { setPickerKw(''); loadPickerList(''); setPickerOpen(true); }}>合集</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增</Button>
      </div>

      {/* ==================== 卡片网格（2 列等宽，Badge.Ribbon 包住整张卡片，状态绑带挂右上角） ==================== */}
      {loading ? (
        <PageSkeleton type="cards" twoCol noCover toolbar />
      ) : list.length === 0 ? (
        <Card><Empty description="暂无任务" /></Card>
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

      {/* ==================== 新增/编辑 弹窗（复用 MODULES.tasks 表单布局） ==================== */}
      <Modal
        title={editing
          ? `编辑任务${TASKS_CFG.titlePk ? `（${TASKS_CFG.titlePk.label}：${editing[TASKS_CFG.titlePk.field] ?? ''}）` : ''}`
          : '新增任务'}
        open={modalOpen}
        onOk={onSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        width={1000}
      >
        <Form form={form} layout="vertical">
          {splitForm ? (
            <Row gutter={24} wrap={false}>
              <Col flex="auto" style={{ minWidth: 0 }}>
                <Row gutter={16}>{leftFields.map(renderFormField)}</Row>
              </Col>
              <Col flex="0 0 420px">
                <Row gutter={16}>{rightFields.map(renderFormField)}</Row>
              </Col>
            </Row>
          ) : (
            <Row gutter={16}>{formFieldsToRender.map(renderFormField)}</Row>
          )}
        </Form>
      </Modal>

      {/* ==================== 删除确认（级联删除提醒） ==================== */}
      <Modal
        title="确认删除"
        open={!!confirmState}
        onOk={() => confirmState && onDelete(confirmState.record)}
        onCancel={() => setConfirmState(null)}
        okText="删除"
        okButtonProps={{ danger: true }}
        confirmLoading={submitting}
      >
        <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {confirmState ? (confirmState.tip || '删除后不可恢复，确定删除该记录吗？') : ''}
        </p>
      </Modal>

      {/* ==================== 任务打卡（图文 + 语音） ==================== */}
      <Modal
        title={`任务打卡${checkinTask ? `：${checkinTask.title || ''}` : ''}`}
        open={checkinOpen}
        onOk={submitCheckin}
        onCancel={() => setCheckinOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        width={560}
        okText="提交打卡"
      >
        <Form form={checkinForm} layout="vertical">
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
          ) : (
            <Form.Item name="images" label="打卡图片（最多9张）">
              <ImageUploader max={9} biz="tasks" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ==================== 合集弹窗：选择合集过滤任务 ==================== */}
      <Modal
        title="选择合集（过滤任务）"
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        footer={null}
        width={600}
      >
        <Input.Search
          placeholder="搜索合集名称"
          allowClear
          value={pickerKw}
          onChange={(e) => setPickerKw(e.target.value)}
          onSearch={(v) => loadPickerList(v)}
          style={{ marginBottom: 12 }}
        />
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button size="small" type={!filterValues.collection_id ? 'primary' : 'default'} onClick={clearCollectionFilter}>
            全部合集
          </Button>
          <span style={{ color: '#999', fontSize: 12 }}>
            {filterValues.collection_id
              ? `当前筛选：${(collectionOptions.find(c => String(c.collection_id) === String(filterValues.collection_id)) || {}).name || `合集#${filterValues.collection_id}`}`
              : '当前显示全部任务'}
          </span>
        </div>
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <Spin spinning={pickerLoading}>
            {pickerList.length === 0 ? (
              <Empty description="暂无合集，请先到「合集管理」创建" />
            ) : (
              pickerList.map(item => {
                const active = String(filterValues.collection_id) === String(item.collection_id);
                const cover = parseImages(item.cover_images)[0];
                return (
                  <div
                    key={item.collection_id}
                    onClick={() => pickCollection(item.collection_id)}
                    style={{
                      cursor: 'pointer', padding: '12px 16px', borderRadius: 6,
                      background: active ? '#e6f4ff' : undefined,
                      display: 'flex', alignItems: 'center', gap: 12,
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <div style={{ width: 64, height: 64, borderRadius: 6, overflow: 'hidden', background: '#f5f5f5', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {cover
                        ? <Image src={toThumbUrl(cover, 128)} fallback={IMG_FALLBACK} width={64} height={64} style={{ objectFit: 'cover' }} preview={false} />
                        : <PictureOutlined style={{ fontSize: 24, color: '#c6d2e4' }} />}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{item.name || '未命名合集'}</div>
                      <div style={{ color: '#999', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.description || '暂无描述'}
                      </div>
                    </div>
                    <span style={{ color: '#999', whiteSpace: 'nowrap', fontSize: 12 }}>{item.task_count || 0} 个任务</span>
                  </div>
                );
              })
            )}
          </Spin>
        </div>
      </Modal>

      <DetailDrawer
        title="任务详情"
        open={!!drawerRecord}
        record={drawerRecord}
        fields={TASKS_CFG.detailFields}
        width={820}
        column={2}
        onClose={() => setDrawerRecord(null)}
      />

      <TimelineDrawer
        title="任务时间轴"
        open={!!timelineRecord}
        record={timelineRecord}
        paramField="task_id"
        paramName="taskId"
        onClose={() => setTimelineRecord(null)}
      />
    </>
  );
}
