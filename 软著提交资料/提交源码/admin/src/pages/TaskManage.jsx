import { useEffect, useState } from 'react';
import { Table, Tag, Button, Modal, Form, Input, Select, message } from 'antd';
import { taskApi } from '../api';

export default function TaskManage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [pager, setPager] = useState({ pageNo: 1, pageSize: 20, total: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const data = await taskApi.list(pager);
      setList(data.list);
      setPager((p) => ({ ...p, total: data.total }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [pager.pageNo]);

  const statusColor = { todo: 'default', doing: 'processing', done: 'success' };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    form.setFieldsValue(row);
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await taskApi.update(editing.id, values);
      } else {
        await taskApi.create(values);
      }
      message.success('保存成功');
      setModalOpen(false);
      load();
    } catch (e) {
      message.error(e.message);
    }
  };

  const remove = (row) => {
    Modal.confirm({
      title: '确认删除该任务？',
      onOk: async () => {
        await taskApi.remove(row.id);
        message.success('删除成功');
        load();
      }
    });
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '标题', dataIndex: 'title' },
    { title: '科目', dataIndex: 'subject' },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s) => <Tag color={statusColor[s]}>{s}</Tag>
    },
    { title: '创建人', dataIndex: 'creator_name' },
    {
      title: '操作',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button size="small" danger onClick={() => remove(row)}>
            删除
          </Button>
        </Space>
      )
    }
  ];

  return (
    <div style={{ padding: 16 }}>
      <Button type="primary" style={{ marginBottom: 16 }} onClick={openCreate}>
        新建任务
      </Button>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={list}
        pagination={{
          current: pager.pageNo,
          pageSize: pager.pageSize,
          total: pager.total,
          onChange: (pageNo) => setPager((p) => ({ ...p, pageNo }))
        }}
      />
      <Modal
        title={editing ? '编辑任务' : '新建任务'}
        open={modalOpen}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} labelCol={{ span: 5 }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="subject" label="科目">
            <Select
              options={['语文', '数学', '英语', '阅读', '运动', '其他'].map((s) => ({
                label: s,
                value: s
              }))}
            />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="score" label="分值">
            <Input type="number" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
