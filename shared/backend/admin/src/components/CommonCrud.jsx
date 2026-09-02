import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Button, Modal, Form, Input, Select, Space, message, Tree, DatePicker, Row, Col, List } from 'antd';
import { PlusOutlined, EyeOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, CalendarOutlined, FolderOutlined, HistoryOutlined, CopyOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { crudApi, menuApi } from '../services/api';
import DetailDrawer from './DetailDrawer.jsx';
import TimelineDrawer from './TimelineDrawer.jsx';
import PageSkeleton from './PageSkeleton.jsx';
import { ImageUploader, CoverThumb, parseImages, imagesToJson, ColorTag, fmtDateTime, AssigneeSelect, ScoreRate } from './fields.jsx';
import dayjs from 'dayjs';

// 邀请码归属账号联动下拉：按表单 kind 值加载对应角色的员工列表（学生码→学生；家长码/家属共享码→主家长）
// 避免后台创建家长码时选中非主家长账号而报「归属账号必须是有效主家长账号」
const StaffByRoleSelect = ({ value, onChange, placeholder = '请选择归属账号' }) => {
  const form = Form.useFormInstance();
  const kind = Form.useWatch('kind', form);
  const [options, setOptions] = useState([]);
  useEffect(() => {
    const role = kind === 'student' ? 'student' : 'parent';
    let mounted = true;
    crudApi.list('staff', { page: 1, pageSize: 500, staff_role: role })
      .then((res) => {
        if (!mounted) return;
        setOptions((res.data.list || []).map(s => ({
          value: s.staff_id,
          label: s.staff_nickname || s.staff_username || String(s.staff_id),
        })));
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [kind]);
  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      options={options}
      filterOption={(input, option) => String(option?.label ?? option?.value ?? '').toLowerCase().includes(String(input || '').toLowerCase())}
    />
  );
};

/**
 * 通用 CRUD 页面（ProTable 版）
 * 审核/删除/打卡均使用页面级弹窗（Modal），禁用行级 Popconfirm
 * @param {object} props
 *  - biz / title / columns / detailFields / formFields / searchable / readonly
 *  - pk: 主键字段（默认取第一列 key；users 等首列非主键的模块必须显式传 pk，否则增删改/审核 id 错配）
 *  - review: 是否内容审核模块（reviewField/reviewEndpoint 自定义审核字段与接口）
 *  - checkin: 是否支持任务打卡（tasks 模块）
 *  - gridOps: 操作列渲染为 2行3列 网格（否则单行排列，如 tasks 模块）
 *  - copyCreate: 操作列渲染「复制」按钮，预填记录数据并重置时间字段后进入新增弹窗（如 tasks 模块）
  * - allowDelete: 只读模块是否仍允许删除（如 task_checkins）
  * - allowBatchDelete: 是否支持多选批量删除（如 file_uploads，物理删除腾讯云存储）
 *  - menuTree: 角色模块菜单分配树
 *  - formColumns: 新增/编辑表单列数（1=单列，2=两列），字段可用 span 控制跨列
 *  - filters: 等值筛选（optionsSource/optionsParams 可动态加载；type:'date' 用日期选择器）
 */
export default function CommonCrud({
  biz, title, columns, detailFields = [], formFields = [], searchable = [], readonly = false,
  searchKey, drawerWidth, drawerColumns, review = false, reviewField = 'review_status',
  reviewEndpoint = 'review', filters = [], checkin = false, allowDelete = false, menuTree = false,
  noCreate = false, formColumns = 1, disableWhen = null, createDefaults = null,
  allowBatchDelete = false, modalWidth = null,
  // 默认禁止横滚动条（与任务管理一致）；需横向滚动时由模块显式传 { x: ... }
  tableScroll = false, hideDetailBtn = false, rowDblClick = false, gridOps = false,
  // 操作列额外加宽（像素），模块配置用（如文件上传记录操作列 +20）
  opWidthExtra = 0,
  copyCreate = false,
  // 复制创建时需重置为 0 的字段（如任务评分，与新增默认 0 分保持一致）
  copyReset = null,
  // 复制创建时需置为指定值的字段映射（如任务状态重置为 todo），值固定覆盖
  copyResetValues = null,
  // 角色感知锁定：(record, { isAdmin }) => tip|null。命中则禁止编辑/删除/打卡（如学生操作已完成任务）
  lockFn = null,
  // 主键展示在窗口标题：{ field, label }，编辑时窗口标题追加（任务ID：xxx），表单内不再展示
  titlePk = null,
  ownField = null, collectionPicker = false, entityName = null,
  // 删除确认提醒：async (record) => string，返回自定义删除确认文案（如任务级联删除提醒），缺省用通用文案
  deleteTip = null,
  // 行级“是否允许普通删除”：(record, { isAdmin }) => bool（缺省全部允许）。
  // 用于把“业务身份删除”收敛到“物理清除”等带审计入口（如管理员管理：业务角色禁用普通删除）。
  deleteShow = null,
  // 业务时间轴：{ paramField, paramName, title }，操作列渲染「时间轴」按钮并打开 TimelineDrawer
  timeline = null,
  pk = null,
  // 日志类模块默认时间范围（天）：设置后列表默认只查询最近 N 天，过滤栏提供时间范围选择（如最近1/3/7/30天）
  defaultDays = null,
  // 自定义操作列按钮：[{ label, icon, color, show:(record,ctx)=>bool, confirm:'确认文案', onClick:(record)=>Promise }]
  // 用于模块级特殊操作（如生成/作废课小满邀请码）
  customActions = null,
  // 工具栏自定义按钮（如新建绑定）：[{ label, icon, color, type, modal:{title,width,fields}, onClick:(ctx, values)=>Promise }]
  // 用于不依赖具体行数据的模块级操作（如课小满「新建家长-孩子绑定」）
  toolbarActions = null,
}) {
  const actionRef = useRef();
  const keywordRef = useRef('');
  const filterRef = useRef({});
  const [filterValues, setFilterValues] = useState({});
  // 日志类默认时间范围：默认最近 N 天（含当天），用户可在过滤栏调整/清空（清空后查询全部数据）
  const timeRangeRef = useRef(defaultDays ? [dayjs().subtract(defaultDays - 1, 'day').startOf('day'), dayjs().endOf('day')] : null);
  const [timeRange, setTimeRange] = useState(timeRangeRef.current);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [drawerRecord, setDrawerRecord] = useState(null);
  const [timelineRecord, setTimelineRecord] = useState(null);
  const [confirmState, setConfirmState] = useState(null);   // { type, record }
  const [reviewNote, setReviewNote] = useState('');          // 审核驳回/通过原因（留痕）
  const [submitting, setSubmitting] = useState(false);       // 弹窗提交防重复
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [checkinTask, setCheckinTask] = useState(null);
  const [checkinForm] = Form.useForm();
  const [form] = Form.useForm();
  // 表单 kind 值（联动字段显隐/下拉角色过滤用）：hideWhenKind 字段在对应 kind 下隐藏
  const watchKind = Form.useWatch('kind', form);
  // 自定义操作弹窗（customActions 中带 modal 配置的操作）：{ action, record }
  const [customModal, setCustomModal] = useState(null);
  const [customForm] = Form.useForm();
  const [menuTreeData, setMenuTreeData] = useState([]);
  const [menuChecked, setMenuChecked] = useState([]);
  const [menuHalfChecked, setMenuHalfChecked] = useState([]);
  // 首次加载骨架屏：数据未就绪时隐藏表格本体并展示骨架屏，就绪后切换（onLoad/onRequestError 均会解除）
  const [firstLoading, setFirstLoading] = useState(true);
  const [dynamicOptions, setDynamicOptions] = useState({});  // source -> options[]
  // 合集相关：筛选下拉选项 + 合集弹窗列表
  const [collectionOptions, setCollectionOptions] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKw, setPickerKw] = useState('');
  const [pickerList, setPickerList] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState([]);
  // 按用户过滤（staffId 类型）：员工下拉选项 + 手输 staff_id
  const [staffFilterOptions, setStaffFilterOptions] = useState([]);
  const [staffIdInput, setStaffIdInput] = useState('');

  // 当前登录人信息（含 role / staff_id），用于按创建人控制编辑/删除按钮显隐
  let currentStaff = {};
  try { currentStaff = JSON.parse(localStorage.getItem('admin_user') || '{}'); } catch (_) {}
  const isAdmin = currentStaff.role === 'admin';

  // 业务实体名：新增/编辑弹窗、详情抽屉标题用「实体」而非「模块功能名」（任务管理 → 任务）
  // entityName 显式配置优先；否则去掉标题末尾的「管理」
  const displayName = entityName || (String(title || '').replace(/管理$/, '') || title);

  // 主键字段：显式 pk 优先（users 等首列非主键的模块），否则取第一列 key，兜底 '_id'
  const rowKey = pk || columns[0]?.key || columns[0]?.dataIndex || '_id';

  // 动态下拉：表单字段 + 筛选字段（支持 optionsSource + optionsParams）
  const loadOptions = useCallback(async (src, params) => {
    const key = `${src}:${JSON.stringify(params || {})}`;
    if (dynamicOptions[key]) return;
    try {
      const res = await crudApi.list(src, { page: 1, pageSize: 100, ...(params || {}) });
      setDynamicOptions(prev => ({ ...prev, [key]: res.data.list || [] }));
    } catch (_) {}
  }, [dynamicOptions]);

  useEffect(() => {
    formFields.filter(f => f.optionsSource).forEach(f => loadOptions(f.optionsSource, f.optionsParams));
    filters.filter(f => f.optionsSource).forEach(f => loadOptions(f.optionsSource, f.optionsParams));
  }, [formFields, filters, loadOptions]);

  // 角色模块：加载全量菜单树
  const loadMenuTree = useCallback(async () => {
    try {
      const res = await menuApi.all();
      setMenuTreeData(res.data.menus || []);
    } catch (_) {}
  }, []);
  useEffect(() => {
    if (menuTree) loadMenuTree();
  }, [menuTree, loadMenuTree]);

  // ==================== 合集：筛选下拉 + 弹窗列表 ====================
  const loadCollectionOptions = useCallback(async (kw) => {
    try {
      const res = await crudApi.list('task_collections', { page: 1, pageSize: 50, keyword: kw || '' });
      setCollectionOptions(res.data.list || []);
    } catch (_) {}
  }, []);

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

  const openPicker = () => {
    setPickerOpen(true);
    setPickerKw('');
    loadPickerList('');
  };

  // 选中合集 → 设置任务列表合集过滤条件并刷新
  const pickCollection = (id) => {
    filterRef.current.collection_id = id;
    setFilterValues(prev => ({ ...prev, collection_id: id }));
    setPickerOpen(false);
    actionRef.current?.reload();
  };

  // 清除合集过滤
  const clearCollectionFilter = () => {
    filterRef.current.collection_id = undefined;
    setFilterValues(prev => ({ ...prev, collection_id: undefined }));
    setPickerOpen(false);
    actionRef.current?.reload();
  };

  useEffect(() => {
    if (collectionPicker) loadCollectionOptions('');
  }, [collectionPicker, loadCollectionOptions]);

  // 按用户过滤（staffId）：仅当模块配置了该筛选时加载全部员工下拉选项
  const hasStaffFilter = filters.some(f => f.type === 'staffId');
  useEffect(() => {
    if (!hasStaffFilter) return;
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
  }, [hasStaffFilter]);

  const currentCollectionName = (collectionOptions.find(c => String(c.collection_id) === String(filterValues.collection_id)) || {}).name || '';

  // 防御：若行内字段值混入 React 元素（如 Typography 内部节点），取其文本子节点，避免被序列化到界面
  const sanitizeRows = (rows) => (rows || []).map((row) => {
    const o = { ...row };
    Object.keys(o).forEach((k) => {
      const v = o[k];
      if (v && typeof v === 'object' && v.$$typeof) {
        o[k] = typeof v.props?.children === 'string' ? v.props.children : '';
      }
    });
    return o;
  });

  const loadData = async (params = {}) => {
    const q = {
      page: params.current || 1,
      pageSize: params.pageSize || 20,
      keyword: keywordRef.current,
      ...filterRef.current,
    };
    // 日志类模块时间范围过滤（后端按 created_at 等 timeField 走 gte/lte）
    const range = timeRangeRef.current;
    if (range) {
      q.startTime = range[0].format('YYYY-MM-DD HH:mm:ss');
      q.endTime = range[1].format('YYYY-MM-DD HH:mm:ss');
    }
    const res = await crudApi.list(biz, q);
    return { data: sanitizeRows(res.data.list), total: res.data.total || 0, success: true };
  };

  const onFilterChange = (name, value) => {
    filterRef.current[name] = value || undefined;
    setFilterValues(prev => ({ ...prev, [name]: value }));
    actionRef.current?.reload();
  };

  // 日志类时间范围切换：同步更新 ref（供 loadData 读取）与 UI 展示后刷新
  const onTimeRangeChange = (range) => {
    timeRangeRef.current = range ? [range[0], range[1]] : null;
    setTimeRange(timeRangeRef.current);
    actionRef.current?.reload();
  };

  const onFilterReset = () => {
    filterRef.current = {};
    setFilterValues({});
    setStaffIdInput('');
    // 日志类模块重置时恢复默认最近 N 天；普通模块清空时间范围（查全部）
    timeRangeRef.current = defaultDays
      ? [dayjs().subtract(defaultDays - 1, 'day').startOf('day'), dayjs().endOf('day')]
      : null;
    setTimeRange(timeRangeRef.current);
    actionRef.current?.reload();
  };

  // 日志类时间范围快捷选项：最近 1/3/7/30 天（含当天）
  const timeRangePresets = defaultDays ? [
    { label: '最近1天', value: [dayjs().startOf('day'), dayjs().endOf('day')] },
    { label: '最近3天', value: [dayjs().subtract(2, 'day').startOf('day'), dayjs().endOf('day')] },
    { label: '最近7天', value: [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')] },
    { label: '最近30天', value: [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')] },
  ] : [];

  // ==================== 新增/编辑 ====================
  // 存在派发学生字段时：学生创建/复制的任务派发固定为本人（禁止派发给他人），管理员可多选
  const hasAssigneeField = formFields.some(f => f.type === 'assignee');
  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    // 新增默认值：日期字段字符串 → dayjs（DatePicker 需要）；tags 字段 JSON/逗号 → 数组
    if (createDefaults) {
      const defaults = typeof createDefaults === 'function' ? createDefaults() : createDefaults;
      form.setFieldsValue(defaults);
      formFields.forEach(f => {
        if (f.type === 'date' && defaults[f.name]) {
          form.setFieldsValue({ [f.name]: dayjs(defaults[f.name]) });
        }
        if (f.type === 'tags' && defaults[f.name]) {
          form.setFieldsValue({ [f.name]: parseImages(defaults[f.name]) });
        }
      });
    }
    if (hasAssigneeField && !isAdmin && currentStaff.staff_id != null) {
      form.setFieldsValue({ assignee_ids: [Number(currentStaff.staff_id)] });
    }
    setMenuChecked([]);
    setMenuHalfChecked([]);
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditing(record);
    form.setFieldsValue(record);
    // 日期字段：字符串 → dayjs（DatePicker 需要）；标签字段：JSON 字符串 → 数组（Select tags 需要）
    formFields.forEach(f => {
      if (f.type === 'date' && record[f.name]) {
        form.setFieldsValue({ [f.name]: dayjs(record[f.name]) });
      }
      if (f.type === 'tags') {
        form.setFieldsValue({ [f.name]: parseImages(record[f.name]) });
      }
    });
    setModalOpen(true);
    if (menuTree) {
      setMenuChecked(record.menuIds || []);
      setMenuHalfChecked([]);
    }
  };

  // 复制创建：弹出新增弹窗并预填选中记录数据，仅重置时间字段（日期类字段），其余保持不变，便于快速创建
  const openCopy = (record) => {
    setEditing(null);
    form.resetFields();
    const copy = { ...record };
    formFields.forEach(f => {
      if (f.type === 'date') {
        copy[f.name] = dayjs();
      } else if (f.type === 'pk') {
        delete copy[f.name];
      } else if (f.type === 'tags' || f.type === 'images') {
        copy[f.name] = parseImages(record[f.name]);
      }
    });
    // 学生复制任务：新任务归本人所有，派发重置为本人（后台强制，前端保持一致展示）
    if (hasAssigneeField && !isAdmin && currentStaff.staff_id != null) {
      copy.assignee_ids = [Number(currentStaff.staff_id)];
    }
    // 复制创建需归零的字段（如任务评分），与新增默认保持一致
    if (Array.isArray(copyReset)) {
      copyReset.forEach(f => { if (formFields.some(ff => ff.name === f)) copy[f] = 0; });
    }
    // 复制创建需置为指定值的字段（如任务状态重置为 todo，保证副本可重新打卡）
    if (copyResetValues) {
      Object.entries(copyResetValues).forEach(([f, v]) => { if (formFields.some(ff => ff.name === f)) copy[f] = v; });
    }
    // 主键（如任务ID）展示在编辑窗口标题，复制创建时不携带原记录主键
    if (titlePk) delete copy[titlePk.field];
    form.setFieldsValue(copy);
    setMenuChecked([]);
    setMenuHalfChecked([]);
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
    // 日期字段：dayjs → yyyy-MM-dd 字符串；图片/标签字段：统一为 JSON 数组字符串（无图为 '[]'，避免 null 入库）
    formFields.forEach(f => {
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
    if (menuTree) {
      values.menuIds = menuChecked;
    }
    try {
      if (editing) {
        await crudApi.update(biz, editing[rowKey], values);
        message.success('更新成功');
      } else {
        await crudApi.create(biz, values);
        message.success('创建成功');
      }
      setModalOpen(false);
      actionRef.current?.reload();
    } catch (_) {
      // 错误已在拦截器提示
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== 删除（页面级弹窗确认） ====================
  const onDelete = async (record) => {
    try {
      await crudApi.remove(biz, record[rowKey]);
      message.success('已删除');
      actionRef.current?.reload();
    } catch (_) {}
  };

  // ==================== 审核（页面级弹窗确认，驳回/通过原因留痕） ====================
  const onReview = async (record, action, note) => {
    try {
      await crudApi.review(biz, record[rowKey], action, reviewEndpoint, note || '');
      message.success(action === 'reject' ? '已驳回' : '审核通过');
      actionRef.current?.reload();
    } catch (_) {}
  };

  const openConfirm = async (type, record) => {
    // 删除前先获取自定义提醒（如任务级联删除提醒），失败时回退通用文案
    let tip = '';
    if (type === 'delete' && deleteTip) {
      try { tip = await deleteTip(record); } catch (_) {}
    }
    setReviewNote('');
    setConfirmState({ type, record, tip });
  };
  const handleConfirm = async () => {
    const { type, record } = confirmState || {};
    setSubmitting(true);
    try {
      if (type === 'delete') await onDelete(record);
      else if (type === 'batchDelete') await onBatchDelete();
      else if (type === 'approve' || type === 'reject') await onReview(record, type, reviewNote);
    } finally {
      setSubmitting(false);
      setConfirmState(null);
    }
  };

  // ==================== 批量删除（物理删除腾讯云存储，file_uploads 等模块用） ====================
  const onBatchDelete = async () => {
    if (!selectedKeys.length) return;
    try {
      const res = await crudApi.batchDelete(biz, selectedKeys);
      message.success(res?.msg || '已删除');
      setSelectedKeys([]);
      actionRef.current?.reload();
    } catch (_) {}
  };

  // ==================== 任务打卡（页面级弹窗） ====================
  const openCheckin = (record) => {
    setCheckinTask(record);
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    checkinForm.setFieldsValue({
      date: dayjs(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`),
      note: '已经完成了',
      images: '',
    });
    setCheckinOpen(true);
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
      await crudApi.taskCheckin({
        taskId: checkinTask[rowKey],
        date: values.date ? values.date.format('YYYY-MM-DD') : '',
        note: values.note,
        images: parseImages(values.images).slice(0, 9),
      });
      message.success('打卡成功');
      setCheckinOpen(false);
      actionRef.current?.reload();
    } catch (_) {
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== 自定义操作弹窗（customActions / toolbarActions 的 modal 配置） ====================
  // 弹窗表单字段复用 renderField（select/date/number/tags/images 等），
  // 行级操作确认后以 (record, ctx, values) 调用 onClick；工具栏操作 record 为 null，以 (null, ctx, values) 调用
  // 统一入口：重置表单 + 预加载动态下拉（optionsSource）后打开弹窗
  const openCustomModal = (action, record) => {
    customForm.resetFields();
    (action.modal.fields || []).filter(f => f.optionsSource).forEach(f => loadOptions(f.optionsSource, f.optionsParams));
    setCustomModal({ action, record });
  };

  const onSubmitCustomModal = async () => {
    const { action, record } = customModal || {};
    if (!action) return;
    let values;
    try {
      values = await customForm.validateFields();
    } catch (e) {
      if (e?.errorFields) return;
      return;
    }
    if (action.modal && action.modal.fields) {
      action.modal.fields.forEach(f => {
        if (f.type === 'date' && values[f.name]) {
          values[f.name] = dayjs(values[f.name]).format('YYYY-MM-DD');
        }
        if (f.type === 'number' && values[f.name] !== undefined && values[f.name] !== null && values[f.name] !== '') {
          values[f.name] = Number(values[f.name]);
        }
      });
    }
    setSubmitting(true);
    try {
      await action.onClick(record, { refresh: () => actionRef.current && actionRef.current.reload() }, values);
      setCustomModal(null);
    } catch (_) {
    } finally {
      setSubmitting(false);
    }
  };

  // ==================== 操作列 ====================
  const canDelete = !readonly || allowDelete;
  // 操作按钮不换行，按实际渲染的按钮数量动态计算列宽（详情可隐藏）
  const btnCount = (!hideDetailBtn ? 1 : 0) + (canDelete ? 1 : 0) + (!readonly ? 1 : 0) + (checkin ? 1 : 0) + (review ? 2 : 0) + (timeline ? 1 : 0) + (copyCreate ? 1 : 0) + ((customActions && customActions.length) || 0);
  // gridOps 网格：3 列固定，按列数 × 单列宽动态计算；其余模式按按钮数量计算
  const opWidth = gridOps
    ? Math.min(Math.max(btnCount, 1), 3) * 76 + 12 + opWidthExtra
    : btnCount * 50 + 12 + opWidthExtra;
  // 命中禁用条件（如任务已完成）时禁止修改/删除
  const isLocked = (record) => {
    if (disableWhen && record[disableWhen.field] === disableWhen.value) return true;
    if (lockFn) return !!lockFn(record, { isAdmin });
    return false;
  };
  const lockTipOf = (record) => {
    if (disableWhen && record[disableWhen.field] === disableWhen.value) return disableWhen.tip;
    if (lockFn) return lockFn(record, { isAdmin }) || undefined;
    return undefined;
  };
  // 非管理员按创建人控制编辑/删除：只能操作自己创建的数据（ownField 如 created_by）
  const isOwnRow = (record) => !ownField || String(record[ownField] || '') === String(currentStaff.staff_id || '');

  // 时间列统一格式化：dataIndex 以 _at/_time 结尾（created_at/updated_at/reviewed_at/start_time 等）且未自定义 render 时，
  // 补默认 render 将原始 ISO 串格式化为 YYYY-MM-DD HH:mm:ss，与详情抽屉/仪表盘展示保持一致。
  const tableColumns = [
    ...columns.map((col) => {
      if (col.render) return col;
      const idx = col.dataIndex || col.key;
      if (typeof idx === 'string' && /_(at|time)$/.test(idx)) {
        return { ...col, render: (v) => <span>{fmtDateTime(v)}</span> };
      }
      return col;
    }),
    {
      title: '操作',
      valueType: 'option',
      fixed: 'right',
      align: 'left',
      width: opWidth,
      render: (_, record) => {
        const locked = isLocked(record);
        const lockTip = lockTipOf(record);
        // 非管理员且非本人创建 → 隐藏编辑/删除（管理员始终可见）
        const ownOnly = !isAdmin && !isOwnRow(record);
        const btns = [];
        if (!hideDetailBtn) {
          btns.push(<Button key="detail" size="small" type="link" icon={<EyeOutlined />} onClick={() => setDrawerRecord(record)}>详情</Button>);
        }
        // 自定义操作列按钮（模块配置 customActions）
        // 支持 modal 配置：按钮点击先弹出表单弹窗，确认后以 (record, ctx, values) 调用 onClick
        if (customActions && customActions.length) {
          customActions.forEach((act, i) => {
            if (act.show && !act.show(record, { isAdmin, isOwnRow })) return;
            btns.push(
              <Button
                key={`ca-${i}`}
                size="small"
                type="link"
                style={act.color ? { color: act.color } : undefined}
                icon={act.icon}
                onClick={() => {
                  if (act.modal) {
                    openCustomModal(act, record);
                    return;
                  }
                  const run = () => act.onClick(record, { refresh: () => actionRef.current && actionRef.current.reload() });
                  if (act.confirm) {
                    Modal.confirm({
                      title: act.confirm,
                      okText: '确定',
                      cancelText: '取消',
                      onOk: () => run(),
                    });
                  } else {
                    run();
                  }
                }}
              >{act.label}</Button>
            );
          });
        }
        if (checkin) {
          btns.push(<Button key="checkin" size="small" type="link" disabled={locked} title={lockTip} icon={<CalendarOutlined />} style={{ color: '#1677ff' }} onClick={() => openCheckin(record)}>打卡</Button>);
        }
        if (timeline) {
          btns.push(<Button key="timeline" size="small" type="link" icon={<HistoryOutlined />} style={{ color: '#722ed1' }} onClick={() => setTimelineRecord(record)}>{timeline.buttonText || '时间轴'}</Button>);
        }
        if (review) {
          if (record[reviewField] !== 'approved') {
            btns.push(<Button key="approve" size="small" type="link" style={{ color: '#52c41a' }} icon={<CheckOutlined />} onClick={() => openConfirm('approve', record)}>通过</Button>);
          }
          if (record[reviewField] !== 'rejected') {
            btns.push(<Button key="reject" size="small" type="link" danger icon={<CloseOutlined />} onClick={() => openConfirm('reject', record)}>驳回</Button>);
          }
        }
        if (!readonly && !ownOnly) {
          btns.push(<Button key="edit" size="small" type="link" disabled={locked} title={lockTip} icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>);
        }
        if (copyCreate && !ownOnly) {
          btns.push(<Button key="copy" size="small" type="link" icon={<CopyOutlined />} onClick={() => openCopy(record)}>复制</Button>);
        }
        if (canDelete && !ownOnly && (!deleteShow || deleteShow(record, { isAdmin }))) {
          btns.push(<Button key="delete" size="small" type="link" danger disabled={locked} title={lockTip} icon={<DeleteOutlined />} onClick={() => openConfirm('delete', record)}>删除</Button>);
        }
        return gridOps ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '4px 8px', justifyContent: 'start' }}>
            {btns}
          </div>
        ) : (
          <Space size={0}>{btns}</Space>
        );
      },
    },
  ];

  // 动态下拉：optionsSource（如 dict_items）→ 选项列表；带 color 时 label 渲染为着色 Tag（供搜索仍保留 searchText）
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

  const buildFilterOptions = (f) => {
    if (f.options) return f.options;
    if (f.optionsSource) return buildSourceOptions(f);
    return [];
  };

  const filterSelects = filters.map((f) => (
    f.type === 'staffId' ? (
      <span key={f.name} style={{ display: 'inline-flex', marginRight: 8 }}>
        <Select
          placeholder="选择用户"
          allowClear
          showSearch
          style={{ width: 170 }}
          value={filterValues[f.name]}
          options={staffFilterOptions}
          filterOption={(input, option) => String(option?.searchText ?? option?.label ?? '').toLowerCase().includes(String(input || '').toLowerCase())}
          onChange={(v) => onFilterChange(f.name, v)}
        />
        <Input
          placeholder="或输入staff_id"
          allowClear
          style={{ width: 132 }}
          value={staffIdInput}
          onChange={(e) => setStaffIdInput(e.target.value)}
          onPressEnter={() => {
            const v = String(staffIdInput || '').trim();
            onFilterChange(f.name, v ? v : undefined);
          }}
        />
      </span>
    ) : f.type === 'collection' ? (
      <Select
        key={f.name}
        placeholder={f.label}
        allowClear
        showSearch
        filterOption={false}
        value={filterValues[f.name]}
        style={{ width: 160, marginRight: 8 }}
        options={collectionOptions.map(c => ({ value: c.collection_id, label: c.name }))}
        onFocus={() => loadCollectionOptions('')}
        onSearch={loadCollectionOptions}
        onChange={(v) => onFilterChange(f.name, v)}
      />
    ) : f.type === 'date' ? (
      <DatePicker
        key={f.name}
        placeholder={f.label}
        allowClear
        value={filterValues[f.name] ? dayjs(filterValues[f.name]) : null}
        style={{ width: 140, marginRight: 8 }}
        onChange={(v) => onFilterChange(f.name, v ? v.format('YYYY-MM-DD') : undefined)}
      />
    ) : (
      <Select
        key={f.name}
        placeholder={f.label}
        allowClear
        showSearch={f.showSearch}
        filterOption={f.showSearch ? (input, option) => String(option?.searchText ?? option?.value ?? '').toLowerCase().includes(String(input || '').toLowerCase()) : true}
        value={filterValues[f.name]}
        style={{ width: f.width || 130, marginRight: 8 }}
        options={buildFilterOptions(f)}
        onChange={(v) => onFilterChange(f.name, v)}
      />
    )
  ));

  // ==================== 表单字段渲染 ====================
  // 未显式配置 placeholder 时，按字段类型自动生成（保证所有输入框都有空文案）
  const renderField = (f, opts = {}) => {
    const autoPlaceholder = () => {
      if (f.placeholder) return f.placeholder;
      const base = String(f.label || '').replace(/[（(].*?[)）]/g, '').trim();
      if (f.type === 'date') return base ? `请选择${base}` : '请选择日期';
      if (f.type === 'select') return base ? `请选择${base}` : '请选择';
      return base ? `请输入${base}` : '请输入';
    };
    if (f.type === 'staffByRole') {
      return <StaffByRoleSelect placeholder={autoPlaceholder()} />;
    }
    if (f.type === 'select') {
      const options = f.options || (f.optionsSource ? buildSourceOptions(f) : []);
      return (
        <Select
          options={options}
          placeholder={autoPlaceholder()}
          mode={f.multiple ? 'multiple' : undefined}
          disabled={(f.disabledWhenCreate && !editing) || (typeof f.disabled === 'function' ? f.disabled() : f.disabled)}
          showSearch={f.showSearch}
          allowClear={f.allowClear}
          filterOption={f.showSearch ? (input, option) => String(option?.searchText ?? option?.value ?? '').toLowerCase().includes(String(input || '').toLowerCase()) : true}
        />
      );
    }
    if (f.type === 'textarea') {
      // 左右布局右侧文本域：按窗口高度拉伸（多个右侧文本域均分高度），其余保持常规三行
      const tall = opts.tall || f.side === 'right';
      return (
        <Input.TextArea
          rows={tall ? 14 : 3}
          placeholder={autoPlaceholder()}
          style={tall ? { minHeight: opts.tallHeight || 'calc(100vh - 320px)' } : undefined}
        />
      );
    }
    if (f.type === 'rate') return <ScoreRate disabled={(f.disabledWhenCreate && !editing) || (typeof f.disabled === 'function' ? f.disabled() : f.disabled)} />;
    if (f.type === 'number') return <Input type="number" placeholder={autoPlaceholder()} />;
    if (f.type === 'password') return <Input.Password placeholder={f.placeholder || '请输入密码'} autoComplete="new-password" />;
    if (f.type === 'date') return <DatePicker style={{ width: '100%' }} placeholder={autoPlaceholder()} />;
    if (f.type === 'images') return <ImageUploader max={f.max || 9} biz={f.biz || 'tasks'} size={f.size || 96} square={f.square} />;
    if (f.type === 'assignee') return <AssigneeSelect disabled={!isAdmin} />;
    if (f.type === 'tags') return <Select mode="tags" style={{ width: '100%' }} placeholder={f.placeholder || '输入后回车添加'} tokenSeparators={[',']} open={false} />;
    return <Input placeholder={autoPlaceholder()} />;
  };

  // 左右布局：字段带 side:'right' 时右侧列渲染（如任务图片、任务描述、系统参数参数值），其余字段渲染在左侧列
  const splitForm = formFields.some(f => f.side === 'right');
  const leftFields = formFields.filter(f => f.side !== 'right');
  const rightFields = formFields.filter(f => f.side === 'right');
  // 右侧文本域数量（用于均分窗口高度）
  const rightTallCount = Math.max(rightFields.filter(f => f.type === 'textarea').length, 1);
  // 右侧文本域高度：整体约等于窗口高度（扣除模态框头/脚/边距），多个文本域均分
  const rightTallHeight = `calc((100vh - 380px) / ${rightTallCount})`;

  // 右侧列字段渲染：文本域拉伸占满高度，其余字段自适应
  const renderRightField = (f) => {
    const extra = typeof f.tip === 'function' ? f.tip({ editing }) : f.tip;
    const tall = f.type === 'textarea';
    return (
      <div key={f.name} style={{ flex: tall ? 1 : '0 0 auto' }}>
        <Form.Item name={f.name} label={f.label} rules={f.rules || []} extra={extra} style={{ marginBottom: 0 }}>
          {renderField(f, { tall: true, tallHeight: rightTallHeight })}
        </Form.Item>
      </div>
    );
  };

  const renderFormField = (f) => {
    const span = f.span || (formColumns > 1 ? 12 : 24);
    // 只读主键展示（如编辑任务时在标题右侧显示任务ID）；新增时提示创建后自动生成
    if (f.type === 'pk') {
      return (
        <Col key={f.name} span={span}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 6, color: 'rgba(0,0,0,0.88)', fontSize: 14 }}>{f.label}</div>
            <div
              style={{
                padding: '4px 11px', border: '1px solid #d9d9d9', borderRadius: 6, background: '#f5f5f5',
                minHeight: 32, lineHeight: '22px', fontSize: 14, color: editing ? 'rgba(0,0,0,0.88)' : '#999',
              }}
            >
              {editing ? (editing[rowKey] ?? '') : (f.createText || '创建后自动生成')}
            </div>
          </div>
        </Col>
      );
    }
    const extra = f.type === 'assignee' && !isAdmin ? '学生自建任务派发固定为本人，不可修改' : (typeof f.tip === 'function' ? f.tip({ editing }) : f.tip);
    return (
      <Col key={f.name} span={span}>
        <Form.Item name={f.name} label={f.label} rules={f.rules || []} extra={extra} style={{ marginBottom: 16 }}>
          {renderField(f)}
        </Form.Item>
      </Col>
    );
  };

  return (
    <>
      {firstLoading && <PageSkeleton type="table" />}
      <ProTable
        actionRef={actionRef}
        rowKey={rowKey}
        headerTitle={title}
        columns={tableColumns}
        request={loadData}
        // 首次加载：隐藏表格本体（仍保持挂载以触发 request），骨架屏占位；加载完成后展示
        style={firstLoading ? { display: 'none' } : undefined}
        onLoad={() => setFirstLoading(false)}
        onRequestError={() => setFirstLoading(false)}
        search={false}
        options={false}
        rowSelection={allowBatchDelete ? {
          selectedRowKeys: selectedKeys,
          onChange: (keys) => setSelectedKeys(keys),
        } : undefined}
        pagination={{ showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
        scroll={tableScroll}
        onRow={(record) => rowDblClick ? ({
          onDoubleClick: () => setDrawerRecord(record),
          style: { cursor: 'pointer' },
        }) : {}}
        toolBarRender={() => [
          (defaultDays || filters.length > 0) && (
            <Space key="filters" size={0} wrap>
              {defaultDays && (
                <DatePicker.RangePicker
                  key="timeRange"
                  value={timeRange}
                  allowClear
                  placeholder={['开始日期', '结束日期']}
                  presets={timeRangePresets}
                  style={{ marginRight: 8 }}
                  onChange={onTimeRangeChange}
                />
              )}
              {filterSelects}
              <Button size="middle" onClick={onFilterReset}>重置</Button>
            </Space>
          ),
          searchable.length > 0 && (
            <Input.Search
              key="search"
              placeholder="搜索"
              allowClear
              style={{ width: 200 }}
              onSearch={(v) => {
                keywordRef.current = v;
                actionRef.current?.reload();
              }}
            />
          ),
          collectionPicker && (
            <Button key="picker" icon={<FolderOutlined />} onClick={openPicker}>合集</Button>
          ),
          (toolbarActions || []).map((act, i) => (
            <Button
              key={`tb-${i}`}
              type={act.type || 'default'}
              icon={act.icon}
              style={act.color && act.type !== 'primary' ? { color: act.color } : undefined}
              onClick={() => {
                if (act.modal) {
                  openCustomModal(act, null);
                  return;
                }
                const run = () => act.onClick({ refresh: () => actionRef.current && actionRef.current.reload() });
                if (act.confirm) {
                  Modal.confirm({
                    title: act.confirm,
                    okText: '确定',
                    cancelText: '取消',
                    onOk: () => run(),
                  });
                } else {
                  run();
                }
              }}
            >{act.label}</Button>
          )),
          allowBatchDelete && selectedKeys.length > 0 && (
            <Button key="batchDelete" danger icon={<DeleteOutlined />} onClick={() => openConfirm('batchDelete', null)}>
              批量删除（{selectedKeys.length}）
            </Button>
          ),
          !readonly && !noCreate && (
            <Button key="add" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增</Button>
          ),
        ].filter(Boolean)}
      />

      {/* ==================== 新增/编辑 页面级弹窗 ==================== */}
      <Modal
        title={editing
          ? `编辑${displayName}${titlePk ? `（${titlePk.label}：${editing[titlePk.field] ?? ''}）` : ''}`
          : `新增${displayName}`}
        open={modalOpen}
        onOk={onSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        width={menuTree ? 640 : (modalWidth || (splitForm ? 1000 : (formColumns > 1 ? 680 : 520)))}
        bodyStyle={splitForm ? { maxHeight: 'calc(100vh - 220px)', overflow: 'auto' } : undefined}
      >
        <Form form={form} layout="vertical">
          {splitForm ? (
            <div style={{ display: 'flex', gap: 24 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Row gutter={16}>
                  {leftFields.map(f => (f.hideWhenKind && f.hideWhenKind.includes(watchKind) ? null : renderFormField(f)))}
                </Row>
              </div>
              <div style={{ flex: '0 0 520px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                {rightFields.map(renderRightField)}
              </div>
            </div>
          ) : (
            <Row gutter={16}>
              {formFields.map(f => (f.hideWhenKind && f.hideWhenKind.includes(watchKind) ? null : renderFormField(f)))}
            </Row>
          )}
        </Form>
        {menuTree && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>菜单权限</div>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 8, maxHeight: 360, overflow: 'auto' }}>
              {menuTreeData.length === 0 ? (
                <div style={{ color: '#999', padding: 12, textAlign: 'center' }}>暂无菜单数据</div>
              ) : (
                <Tree
                  checkable
                  defaultExpandAll
                  treeData={menuTreeData.map(n => ({ key: n.id, title: n.name, children: (n.children || []).map(c => ({ key: c.id, title: c.name })) }))}
                  checkedKeys={menuChecked}
                  onCheck={(keys, e) => {
                    setMenuChecked(keys);
                    setMenuHalfChecked(e.halfCheckedKeys || []);
                  }}
                />
              )}
            </div>
            <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>勾选该角色可访问的菜单（管理员默认拥有全部菜单）</div>
          </div>
        )}
      </Modal>

      {/* ==================== 审核/删除 页面级确认弹窗 ==================== */}
      <Modal
        title={confirmState?.type === 'delete' || confirmState?.type === 'batchDelete' ? '确认删除' : confirmState?.type === 'reject' ? '确认驳回' : '确认审核通过'}
        open={!!confirmState}
        onOk={handleConfirm}
        onCancel={() => setConfirmState(null)}
        okText={confirmState?.type === 'delete' || confirmState?.type === 'batchDelete' ? '删除' : confirmState?.type === 'reject' ? '驳回' : '通过'}
        okButtonProps={{ danger: confirmState?.type === 'delete' || confirmState?.type === 'batchDelete' || confirmState?.type === 'reject' }}
        confirmLoading={submitting}
      >
        <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {confirmState?.type === 'delete' && (confirmState.tip || '删除后不可恢复，确定删除该记录吗？')}
          {confirmState?.type === 'batchDelete' && `将从腾讯云存储物理删除选中的 ${selectedKeys.length} 个文件及其登记记录，删除后不可恢复，确定删除吗？`}
          {confirmState?.type === 'approve' && '确认审核通过该记录吗？'}
          {confirmState?.type === 'reject' && '确认驳回该记录吗？驳回后内容将对用户隐藏。'}
        </p>
        {(confirmState?.type === 'approve' || confirmState?.type === 'reject') && (
          <Input.TextArea
            rows={3}
            maxLength={500}
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="审核原因（选填，写入操作审计留痕，驳回时建议填写）"
          />
        )}
      </Modal>

      {/* ==================== 任务打卡 页面级弹窗 ==================== */}
      <Modal
        title={`任务打卡${checkinTask ? `：${checkinTask.title || checkinTask[rowKey] || ''}` : ''}`}
        open={checkinOpen}
        onOk={submitCheckin}
        onCancel={() => setCheckinOpen(false)}
        destroyOnClose
        confirmLoading={submitting}
        width={560}
      >
        <Form form={checkinForm} layout="vertical">
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

      {/* ==================== 自定义操作弹窗（如变更绑定：选择目标学生） ==================== */}
      <Modal
        title={(customModal && customModal.action && customModal.action.modal && customModal.action.modal.title) || '操作'}
        open={!!customModal}
        onOk={onSubmitCustomModal}
        onCancel={() => setCustomModal(null)}
        destroyOnClose
        confirmLoading={submitting}
        width={(customModal && customModal.action && customModal.action.modal && customModal.action.modal.width) || 520}
      >
        <Form form={customForm} layout="vertical">
          <Row gutter={16}>
            {(customModal && customModal.action && customModal.action.modal && customModal.action.modal.fields || []).map(f => (
              <Col key={f.name} span={f.span || 24}>
                <Form.Item name={f.name} label={f.label} rules={f.rules || []} style={{ marginBottom: 16 }}>
                  {renderField(f)}
                </Form.Item>
              </Col>
            ))}
          </Row>
        </Form>
      </Modal>

      {/* ==================== 合集弹窗列表：选择合集过滤任务 ==================== */}
      {collectionPicker && (
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
              {filterValues.collection_id ? `当前筛选：${currentCollectionName || `合集#${filterValues.collection_id}`}` : '当前显示全部任务'}
            </span>
          </div>
          <List
            loading={pickerLoading}
            dataSource={pickerList}
            locale={{ emptyText: '暂无合集，请先到「合集管理」创建' }}
            style={{ maxHeight: 420, overflow: 'auto' }}
            renderItem={(item) => {
              const active = String(filterValues.collection_id) === String(item.collection_id);
              return (
                <List.Item
                  onClick={() => pickCollection(item.collection_id)}
                  style={{ cursor: 'pointer', padding: '12px 16px', borderRadius: 6, background: active ? '#e6f4ff' : undefined }}
                  actions={[<span key="count" style={{ color: '#999', whiteSpace: 'nowrap' }}>{item.task_count || 0} 个任务</span>]}
                >
                  <List.Item.Meta
                    avatar={<CoverThumb value={item.cover_images} size={64} />}
                    title={<span>{item.name || '未命名合集'}</span>}
                    description={item.description || '暂无描述'}
                  />
                </List.Item>
              );
            }}
          />
        </Modal>
      )}

      <DetailDrawer
        title={`${displayName}详情`}
        open={!!drawerRecord}
        record={drawerRecord}
        fields={detailFields}
        width={drawerWidth || 720}
        column={drawerColumns || 2}
        onClose={() => setDrawerRecord(null)}
      />

      {/* ==================== 业务时间轴抽屉（任务/打卡全生命周期事件，审计用） ==================== */}
      {timeline && (
        <TimelineDrawer
          title={timeline.title || '时间轴'}
          open={!!timelineRecord}
          record={timelineRecord}
          paramField={timeline.paramField || 'task_id'}
          paramName={timeline.paramName || 'taskId'}
          onClose={() => setTimelineRecord(null)}
        />
      )}
    </>
  );
}
