import React, { useState, useEffect, useCallback } from 'react';
import { Card, Row, Col, Table, Button, Modal, Form, Input, Select, Popconfirm, Tag, Space, message, ColorPicker } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, CloseOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';
import { ColorTag, clearDictMap } from '../components/fields.jsx';

const STATUS_OPTIONS = [
  { value: 1, label: '启用' },
  { value: 0, label: '禁用' },
];
const STATUS_MAP = {
  1: { label: '启用', color: 'success' },
  0: { label: '禁用', color: 'error' },
};
const COLOR_PRESETS = ['#1677ff', '#52c41a', '#f5222d', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2', '#faad14', '#2f54eb', '#d4b106'];

/** 颜色字段：取色器 + 手动输入 + 清除（留空=无颜色） */
function ColorField({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <ColorPicker
        value={value || undefined}
        disabledAlpha
        presets={[{ label: '常用', colors: COLOR_PRESETS }]}
        onChange={(c) => onChange(c.toHexString())}
      />
      <Input
        value={value || ''}
        style={{ flex: 1 }}
        placeholder="留空=无颜色；可手动输入，如 #1677ff"
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? <Button icon={<CloseOutlined />} title="清除颜色" onClick={() => onChange('')} /> : null}
    </div>
  );
}

/**
 * 数据字典一体化页面
 * - 左侧：字典类型（Key），支持增删改查
 * - 右侧：选中字典的字典项（Value），支持增删改查
 */
export default function DictPage() {
  const [types, setTypes] = useState([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [selectedCode, setSelectedCode] = useState(null);

  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsPage, setItemsPage] = useState(1);
  const [itemsTotal, setItemsTotal] = useState(0);
  const ITEMS_PAGE_SIZE = 20;

  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [editingType, setEditingType] = useState(null);
  const [typeForm] = Form.useForm();

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [itemForm] = Form.useForm();

  // ==================== 字典类型（左侧） ====================
  const loadTypes = useCallback(async () => {
    setTypesLoading(true);
    try {
      const res = await crudApi.list('dict_types', { page: 1, pageSize: 100 });
      const list = res.data.list || [];
      setTypes(list);
      setSelectedCode(prev => (list.some(t => t.dict_code === prev) ? prev : (list.length ? list[0].dict_code : null)));
    } catch (_) {
    } finally {
      setTypesLoading(false);
    }
  }, []);

  useEffect(() => { loadTypes(); }, [loadTypes]);

  const openTypeCreate = () => {
    setEditingType(null);
    typeForm.resetFields();
    typeForm.setFieldsValue({ dict_status: 1 });
    setTypeModalOpen(true);
  };
  const openTypeEdit = (rec) => {
    setEditingType(rec);
    typeForm.setFieldsValue({ dict_code: rec.dict_code, dict_name: rec.dict_name, dict_status: rec.dict_status });
    setTypeModalOpen(true);
  };
  const saveType = async () => {
    try {
      const values = await typeForm.validateFields();
      if (editingType) {
        await crudApi.update('dict_types', editingType.dict_id, values);
        message.success('已更新');
      } else {
        await crudApi.create('dict_types', values);
        message.success('已创建');
      }
      setTypeModalOpen(false);
      loadTypes();
    } catch (_) {}
  };
  const removeType = async (rec) => {
    try {
      // 级联删除该字典下的所有字典项
      const res = await crudApi.list('dict_items', { page: 1, pageSize: 500, dict_code: rec.dict_code });
      const list = res.data.list || [];
      for (const it of list) await crudApi.remove('dict_items', it.item_id);
      await crudApi.remove('dict_types', rec.dict_id);
      clearDictMap(rec.dict_code);
      message.success('已删除');
      loadTypes();
    } catch (_) {}
  };

  const typeColumns = [
    { title: '字典编码', dataIndex: 'dict_code', key: 'dict_code', width: 130, render: (v) => <Tag color="blue">{v}</Tag> },
    { title: '字典名称', dataIndex: 'dict_name', key: 'dict_name' },
    { title: '状态', dataIndex: 'dict_status', key: 'dict_status', width: 70, render: (v) => <Tag color={(STATUS_MAP[v] || {}).color}>{v === 1 ? '启用' : '禁用'}</Tag> },
    { title: '操作', key: 'op', width: 110, render: (_, rec) => (
      <Space size={4}>
        <Button type="link" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); openTypeEdit(rec); }} />
        <Popconfirm title={`删除字典「${rec.dict_name}」？将同时删除其下所有字典项`} onConfirm={(e) => { e && e.stopPropagation(); removeType(rec); }}>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
        </Popconfirm>
      </Space>
    )},
  ];

  // ==================== 字典项（右侧） ====================
  const loadItems = useCallback(async () => {
    if (!selectedCode) { setItems([]); setItemsTotal(0); return; }
    setItemsLoading(true);
    try {
      const res = await crudApi.list('dict_items', { page: itemsPage, pageSize: ITEMS_PAGE_SIZE, dict_code: selectedCode });
      setItems(res.data.list || []);
      setItemsTotal(res.data.total || 0);
    } catch (_) {
    } finally {
      setItemsLoading(false);
    }
  }, [selectedCode, itemsPage]);

  useEffect(() => { setItemsPage(1); }, [selectedCode]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const openItemCreate = () => {
    setEditingItem(null);
    itemForm.resetFields();
    itemForm.setFieldsValue({ dict_code: selectedCode, item_status: 1 });
    setItemModalOpen(true);
  };
  const openItemEdit = (rec) => {
    setEditingItem(rec);
    itemForm.setFieldsValue({ dict_code: rec.dict_code, item_value: rec.item_value, item_label: rec.item_label, color: rec.color || '', sort: rec.sort, item_status: rec.item_status });
    setItemModalOpen(true);
  };
  const saveItem = async () => {
    try {
      const values = await itemForm.validateFields();
      if (editingItem) {
        await crudApi.update('dict_items', editingItem.item_id, values);
        message.success('已更新');
      } else {
        await crudApi.create('dict_items', values);
        message.success('已创建');
      }
      clearDictMap(selectedCode);
      setItemModalOpen(false);
      loadItems();
    } catch (_) {}
  };
  const removeItem = async (rec) => {
    try {
      await crudApi.remove('dict_items', rec.item_id);
      clearDictMap(selectedCode);
      message.success('已删除');
      loadItems();
    } catch (_) {}
  };

  const itemColumns = [
    { title: 'ID', dataIndex: 'item_id', key: 'item_id', width: 70 },
    { title: '项值', dataIndex: 'item_value', key: 'item_value', width: 150, render: (v, rec) => <ColorTag value={v} color={rec.color} /> },
    { title: '项名称', dataIndex: 'item_label', key: 'item_label' },
    { title: '颜色', dataIndex: 'color', key: 'color', width: 110, render: (v) => (
      v ? (
        <Space size={6}>
          <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 3, background: v, border: '1px solid #eee', flexShrink: 0 }} />
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#595959' }}>{v}</span>
        </Space>
      ) : <span style={{ color: '#bbb' }}>无</span>
    ) },
    { title: '排序', dataIndex: 'sort', key: 'sort', width: 70 },
    { title: '状态', dataIndex: 'item_status', key: 'item_status', width: 70, render: (v) => <Tag color={(STATUS_MAP[v] || {}).color}>{v === 1 ? '启用' : '禁用'}</Tag> },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 150 },
    { title: '操作', key: 'op', width: 100, render: (_, rec) => (
      <Space size={4}>
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openItemEdit(rec)} />
        <Popconfirm title="确认删除该字典项？" onConfirm={() => removeItem(rec)}>
          <Button type="link" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    )},
  ];

  return (
    <Row gutter={12} style={{ padding: 4, height: 'calc(100vh - 120px)' }}>
      <Col xs={24} md={9} lg={8} style={{ height: '100%' }}>
        <Card
          size="small"
          title="字典类型（Key）"
          extra={
            <Space>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openTypeCreate}>新增</Button>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadTypes} />
            </Space>
          }
          style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
          styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
        >
          <Table
            size="small"
            rowKey="dict_id"
            loading={typesLoading}
            columns={typeColumns}
            dataSource={types}
            pagination={false}
            scroll={{ y: 'calc(100vh - 260px)' }}
            onRow={(rec) => ({
              onClick: () => setSelectedCode(rec.dict_code),
              style: { cursor: 'pointer', background: selectedCode === rec.dict_code ? '#e6f4ff' : undefined },
            })}
          />
        </Card>
      </Col>

      <Col xs={24} md={15} lg={16} style={{ height: '100%' }}>
        <Card
          size="small"
          title={selectedCode ? `字典项（Value）· ${selectedCode}` : '字典项（Value）'}
          extra={
            <Space>
              <Button type="primary" size="small" icon={<PlusOutlined />} disabled={!selectedCode} onClick={openItemCreate}>新增</Button>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadItems} />
            </Space>
          }
          style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
          styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
        >
          <Table
            size="small"
            rowKey="item_id"
            loading={itemsLoading}
            columns={itemColumns}
            dataSource={items}
            scroll={{ y: 'calc(100vh - 260px)' }}
            pagination={{
              current: itemsPage,
              pageSize: ITEMS_PAGE_SIZE,
              total: itemsTotal,
              showSizeChanger: false,
              onChange: (p) => setItemsPage(p),
            }}
          />
        </Card>
      </Col>

      {/* 字典类型 新增/编辑 */}
      <Modal title={editingType ? '编辑字典类型' : '新增字典类型'} open={typeModalOpen} onOk={saveType} onCancel={() => setTypeModalOpen(false)} destroyOnClose>
        <Form form={typeForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="dict_code" label="字典编码" rules={[{ required: true, message: '请输入字典编码' }]}>
            <Input placeholder="如 subject" disabled={!!editingType} />
          </Form.Item>
          <Form.Item name="dict_name" label="字典名称" rules={[{ required: true, message: '请输入字典名称' }]}>
            <Input placeholder="如 科目" />
          </Form.Item>
          <Form.Item name="dict_status" label="状态">
            <Select options={STATUS_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 字典项 新增/编辑 */}
      <Modal title={editingItem ? '编辑字典项' : '新增字典项'} open={itemModalOpen} onOk={saveItem} onCancel={() => setItemModalOpen(false)} destroyOnClose>
        <Form form={itemForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="dict_code" label="所属字典" rules={[{ required: true }]}>
            <Input disabled={!!editingItem} />
          </Form.Item>
          <Form.Item name="item_value" label="项值" rules={[{ required: true, message: '请输入项值' }]}>
            <Input placeholder="如 语文" />
          </Form.Item>
          <Form.Item name="item_label" label="项名称" rules={[{ required: true, message: '请输入项名称' }]}>
            <Input placeholder="如 语文" />
          </Form.Item>
          <Form.Item
            name="color"
            label="颜色（用于标签着色，可选）"
            rules={[{
              validator: (_, v) => (!v || /^#[0-9a-fA-F]{6}$/.test(v))
                ? Promise.resolve()
                : Promise.reject(new Error('格式须为 #RRGGBB（如 #1677ff）')),
            }]}
          >
            <ColorField />
          </Form.Item>
          <Form.Item name="sort" label="排序">
            <Input type="number" placeholder="数值越小越靠前" />
          </Form.Item>
          <Form.Item name="item_status" label="状态">
            <Select options={STATUS_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>
    </Row>
  );
}
