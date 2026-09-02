import { useEffect, useState } from 'react';
import { Table, Input, Space, Button, Switch, message } from 'antd';
import { userApi } from '../api';

export default function UserManage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [pager, setPager] = useState({ pageNo: 1, pageSize: 20, total: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const data = await userApi.list({ keyword, ...pager });
      setList(data.list);
      setPager((p) => ({ ...p, total: data.total }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [pager.pageNo, pager.pageSize]);

  const toggleStatus = async (row, checked) => {
    try {
      await userApi.setStatus({ userId: row.id, status: checked ? 1 : 0 });
      message.success('操作成功');
      load();
    } catch (e) {
      message.error(e.message);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    { title: '账号', dataIndex: 'account' },
    { title: '姓名', dataIndex: 'name' },
    { title: '角色', dataIndex: 'role' },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_, row) => (
        <Switch checked={row.status === 1} onChange={(v) => toggleStatus(row, v)} />
      )
    },
    { title: '注册时间', dataIndex: 'created_at' }
  ];

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder="搜索账号/姓名"
          allowClear
          onSearch={(v) => {
            setKeyword(v);
            setPager((p) => ({ ...p, pageNo: 1 }));
          }}
          style={{ width: 260 }}
        />
        <Button type="primary" onClick={load}>
          刷新
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={list}
        pagination={{
          current: pager.pageNo,
          pageSize: pager.pageSize,
          total: pager.total,
          onChange: (pageNo, pageSize) => setPager((p) => ({ ...p, pageNo, pageSize }))
        }}
      />
    </div>
  );
}
