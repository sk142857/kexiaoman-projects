import { useEffect, useState } from 'react';
import { Card, Row, Col, Table } from 'antd';
import { taskApi } from '../api';

export default function StatsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    taskApi
      .list({ pageSize: 100 })
      .then((data) => setRows(data.list))
      .finally(() => setLoading(false));
  }, []);

  const bySubject = {};
  rows.forEach((r) => {
    const key = r.subject || '未分类';
    bySubject[key] = (bySubject[key] || 0) + 1;
  });

  const subjectRows = Object.entries(bySubject).map(([subject, count]) => ({
    subject,
    count
  }));

  return (
    <div style={{ padding: 16 }}>
      <Row gutter={16}>
        <Col span={12}>
          <Card title="任务科目分布" style={{ marginBottom: 16 }}>
            <Table
              rowKey="subject"
              dataSource={subjectRows}
              loading={loading}
              pagination={false}
              columns={[
                { title: '科目', dataIndex: 'subject' },
                { title: '任务数', dataIndex: 'count' }
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="最近任务">
            <Table
              rowKey="id"
              dataSource={rows.slice(0, 20)}
              loading={loading}
              pagination={false}
              columns={[
                { title: '标题', dataIndex: 'title' },
                { title: '状态', dataIndex: 'status' },
                { title: '创建时间', dataIndex: 'created_at' }
              ]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
