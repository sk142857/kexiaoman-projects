import { useEffect, useState } from 'react';
import { Table, Tag, Button, Modal, Input, message } from 'antd';
import { taskApi, checkinApi } from '../api';
import { Space } from 'antd';

export default function CheckinManage() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pager, setPager] = useState({ pageNo: 1, pageSize: 20, total: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const data = await checkinApi.list(pager);
      setList(data.list);
      setPager((p) => ({ ...p, total: data.total }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [pager.pageNo]);

  const review = async (row, result) => {
    try {
      await checkinApi.review(row.id, { result });
      message.success('审核完成');
      load();
    } catch (e) {
      message.error(e.message);
    }
  };

  const statusColor = { pending: 'warning', approved: 'success', rejected: 'error' };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '打卡日期', dataIndex: 'checkin_date' },
    { title: '内容', dataIndex: 'note', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'audit_status',
      render: (s) => <Tag color={statusColor[s]}>{s}</Tag>
    },
    {
      title: '操作',
      render: (_, row) => (
        <Space>
          <Button
            size="small"
            type="primary"
            disabled={row.audit_status === 'approved'}
            onClick={() => review(row, 'approved')}
          >
            通过
          </Button>
          <Button
            size="small"
            danger
            disabled={row.audit_status === 'rejected'}
            onClick={() => review(row, 'rejected')}
          >
            驳回
          </Button>
        </Space>
      )
    }
  ];

  return (
    <div style={{ padding: 16 }}>
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
    </div>
  );
}
