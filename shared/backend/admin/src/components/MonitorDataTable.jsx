import React, { useRef, useState, useEffect } from 'react';
import { Button, Form, Input, Select, DatePicker, Space } from 'antd';
import { SearchOutlined, ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { crudApi } from '../services/api';
import { MODULES } from '../config/modules.jsx';
import DetailDrawer from './DetailDrawer.jsx';
import dayjs from 'dayjs';

const { RangePicker } = DatePicker;

// 各监控数据源的查询表单字段（name 与后端 list 接口参数一一对应）
const QUERY_FIELDS = {
  monitors: [
    { name: 'keyword', label: '实例ID' },
    { name: 'env_id', label: '环境ID' },
  ],
  traces: [
    { name: 'keyword', label: '路径/用户' },
    {
      name: 'api_method', label: '方法', type: 'select',
      options: [
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
        { value: 'PATCH', label: 'PATCH' },
        { value: 'DELETE', label: 'DELETE' },
      ],
    },
    {
      name: 'trace_status', label: '链路状态', type: 'select',
      options: [
        { value: 'server_only', label: '仅服务端' },
        { value: 'complete', label: '完整链路' },
      ],
    },
  ],
};

const ROW_KEYS = { monitors: 'monitor_id', traces: 'request_id' };

/**
 * 监控仪表盘数据查询表格：查询表单 + ProTable + 详情抽屉
 * biz: 'monitors' | 'traces'
 */
export default function MonitorDataTable({ biz }) {
  const actionRef = useRef();
  const [form] = Form.useForm();
  const [drawerRecord, setDrawerRecord] = useState(null);

  const cfg = MODULES[biz];
  const rowKey = ROW_KEYS[biz] || cfg.columns[0]?.dataIndex;
  const queryFields = QUERY_FIELDS[biz] || [];
  // 日志类默认时间范围：最近 N 天（含当天），与 CRUD 模块 defaultDays 保持一致（默认 3 天）
  const defaultDays = cfg.defaultDays || 3;
  const defaultRange = () => [
    dayjs().subtract(defaultDays - 1, 'day').startOf('day'),
    dayjs().endOf('day'),
  ];
  // 默认过滤最近 N 天（filterRef 初始化即生效，进入页面即按默认时间范围查询）
  const filterRef = useRef({
    startTime: defaultRange()[0].format('YYYY-MM-DD HH:mm:ss'),
    endTime: defaultRange()[1].format('YYYY-MM-DD HH:mm:ss'),
  });
  const timeRangePresets = [
    { label: '最近1天', value: [dayjs().startOf('day'), dayjs().endOf('day')] },
    { label: '最近3天', value: [dayjs().subtract(2, 'day').startOf('day'), dayjs().endOf('day')] },
    { label: '最近7天', value: [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')] },
    { label: '最近30天', value: [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')] },
  ];

  useEffect(() => {
    form.setFieldsValue({ timeRange: defaultRange() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 防御：若行内字段值混入 React 元素，取其文本子节点，避免被序列化到界面
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

  // 进入页面自动加载（ProTable 挂载时调用 request），无过滤条件；点“查询”后按条件过滤
  const loadData = async (params = {}) => {
    const f = filterRef.current || {};
    const res = await crudApi.list(biz, {
      page: params.current || 1,
      pageSize: params.pageSize || 20,
      keyword: f.keyword,
      env_id: f.env_id,
      api_method: f.api_method,
      trace_status: f.trace_status,
      startTime: f.startTime,
      endTime: f.endTime,
    });
    return { data: sanitizeRows(res.data.list), total: res.data.total || 0, success: true };
  };

  const onQuery = () => {
    const v = form.getFieldsValue();
    const f = { ...v };
    if (Array.isArray(f.timeRange) && f.timeRange[0] && f.timeRange[1]) {
      f.startTime = f.timeRange[0].startOf('day').format('YYYY-MM-DD HH:mm:ss');
      f.endTime = f.timeRange[1].endOf('day').format('YYYY-MM-DD HH:mm:ss');
    } else {
      // 未选时间范围 → 查询全部
      delete f.startTime;
      delete f.endTime;
    }
    delete f.timeRange;
    filterRef.current = f;
    actionRef.current?.reload();
  };

  const onReset = () => {
    form.resetFields();
    // 日志类重置时恢复默认最近 N 天
    form.setFieldsValue({ timeRange: defaultRange() });
    filterRef.current = {
      startTime: defaultRange()[0].format('YYYY-MM-DD HH:mm:ss'),
      endTime: defaultRange()[1].format('YYYY-MM-DD HH:mm:ss'),
    };
    actionRef.current?.reload();
  };

  const tableColumns = [
    ...cfg.columns,
    {
      title: '操作',
      valueType: 'option',
      fixed: 'right',
      width: 90,
      render: (_, record) => (
        <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => setDrawerRecord(record)}>详情</Button>
      ),
    },
  ];

  return (
    <>
      <Form form={form} layout="inline" style={{ marginBottom: 12, rowGap: 8 }}>
        {queryFields.map((field) => (
          <Form.Item key={field.name} name={field.name} label={field.label}>
            {field.type === 'select' ? (
              <Select options={field.options} placeholder="全部" allowClear style={{ width: 130 }} />
            ) : (
              <Input placeholder="模糊搜索" allowClear style={{ width: 170 }} />
            )}
          </Form.Item>
        ))}
        <Form.Item name="timeRange" label="采集时间">
          <RangePicker showTime={{ format: 'HH:mm' }} presets={timeRangePresets} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" icon={<SearchOutlined />} onClick={onQuery}>查询</Button>
            <Button icon={<ReloadOutlined />} onClick={onReset}>重置</Button>
          </Space>
        </Form.Item>
      </Form>

      <ProTable
        actionRef={actionRef}
        rowKey={rowKey}
        columns={tableColumns}
        request={loadData}
        search={false}
        options={false}
        pagination={{ showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
        scroll={false}
      />

      <DetailDrawer
        title={`${cfg.title}详情`}
        open={!!drawerRecord}
        record={drawerRecord}
        fields={cfg.detailFields}
        width={cfg.drawerWidth || 720}
        onClose={() => setDrawerRecord(null)}
      />
    </>
  );
}
