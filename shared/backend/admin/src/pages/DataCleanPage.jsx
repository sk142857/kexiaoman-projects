// 数据清理（数据健康）：处理历史脏数据（孤儿绑定/邀请码/家庭/空壳账号）
// 与「物理清除」（按账号/家庭/用户全量删除）互补：这里只清理“确定无用”的孤儿/残留关联。
// 交互：进入自动统计各类目当前数量 → 逐类目审阅后确认清理 → 结果写操作审计。
import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Row, Col, Tag, Table, Button, Space, message, Modal, Typography, Alert,
} from 'antd';
import { ClearOutlined, ReloadOutlined, DeleteOutlined, SafetyOutlined, WarningOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';
import PageSkeleton from '../components/PageSkeleton.jsx';

export default function DataCleanPage() {
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState('');
  const [items, setItems] = useState([]);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const res = await crudApi.dataCleanPreview();
      setItems((res.data && res.data.items) || []);
    } catch (_) {}
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const doClean = (item, all = false) => {
    const name = all ? '全部低风险项' : `「${item.label}」`;
    const warn = all
      ? '将清理所有“低风险/孤儿”类目（不含谨慎的空壳业务账号）。'
      : (item.danger
          ? '该为空壳业务账号（可能含“已建档、尚未扫码/未使用”的合法账号），请确认确实无用后再清理。'
          : '仅清理“确定无用”的孤儿/残留关联，不影响正常家庭与在绑用户。');
    Modal.confirm({
      title: `清理${name}`,
      width: 520,
      okText: '确认清理',
      okType: 'danger',
      cancelText: '取消',
      content: (
        <div>
          <Alert type={item && item.danger ? 'warning' : 'info'} showIcon message={warn} style={{ marginBottom: 12 }} />
          {item && <div style={{ color: '#ff4d4f', fontSize: 14 }}>待清理：{item.count} 条</div>}
          <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 8 }}>
            清理结果将写入「系统设置 → 操作审计」，可回看受影响记录。
          </div>
        </div>
      ),
      onOk: async () => {
        setRunning(all ? 'all' : item.key);
        try {
          if (all) {
            const safe = items.filter(i => !i.danger);
            for (const it of safe) await crudApi.dataCleanRun(it.key);
            message.success('低风险项清理完成');
          } else {
            const res = await crudApi.dataCleanRun(item.key);
            message.success(res?.msg || '清理完成');
          }
          await load();
        } catch (_) {
        } finally {
          setRunning('');
        }
      },
    });
  };

  const totalSafe = items.filter(i => !i.danger).reduce((s, i) => s + (Number(i.count) || 0), 0);

  return (
    <div>
      <Card style={{ borderRadius: 16, border: 'none', marginBottom: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
        <Row gutter={16} align="middle">
          <Col flex="none">
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,#fa8c16,#ffc53d)', color: '#fff', fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ClearOutlined />
            </div>
          </Col>
          <Col flex="auto">
            <div style={{ fontSize: 17, fontWeight: 700 }}>数据清理（脏数据）</div>
            <div style={{ fontSize: 13, color: '#8c8c8c', marginTop: 4 }}>
              清理历史遗留的孤儿绑定/邀请码/家庭关系与空壳账号；每类先统计、确认后再执行，结果写操作审计。
            </div>
          </Col>
          <Col flex="none">
            <Space>
              <Button
                danger
                disabled={!totalSafe}
                loading={running === 'all'}
                icon={<DeleteOutlined />}
                onClick={() => doClean(null, true)}
              >
                一键清理低风险项{totalSafe ? `（${totalSafe}）` : ''}
              </Button>
              <ReloadOutlined style={{ fontSize: 18, color: '#1677ff', cursor: 'pointer' }} onClick={() => load()} />
            </Space>
          </Col>
        </Row>
      </Card>

      {loading ? (
        <PageSkeleton type="table" />
      ) : (
        <Card style={{ borderRadius: 16, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
          <Table
            rowKey="key"
            loading={loading}
            dataSource={items}
            pagination={false}
            columns={[
              {
                title: '类目', dataIndex: 'label', width: 220,
                render: (v, r) => (
                  <Space size={6}>
                    <span style={{ fontWeight: 600 }}>{v}</span>
                    {r.danger ? <Tag color="warning">谨慎</Tag> : <Tag color="green">低风险</Tag>}
                  </Space>
                ),
              },
              { title: '说明', dataIndex: 'desc' },
              {
                title: '待清理', dataIndex: 'count', width: 100,
                render: (v) => v === -1
                  ? <Tag color="error">统计失败</Tag>
                  : <span style={{ color: v > 0 ? '#ff4d4f' : '#52c41a', fontWeight: 700 }}>{v}</span>,
              },
              {
                title: '操作', key: 'op', width: 160, align: 'left',
                render: (_, r) => (
                  <Button size="small" danger icon={<DeleteOutlined />} loading={running === r.key}
                    disabled={!r.count} onClick={() => doClean(r)}>
                    清理
                  </Button>
                ),
              },
            ]}
            locale={{ emptyText: '暂无待清理脏数据 🎉' }}
          />
          <div style={{ marginTop: 12, color: '#bfbfbf', fontSize: 12 }}>
            <SafetyOutlined style={{ color: '#52c41a', marginRight: 4 }} />
            仅清理“确定无用”记录；带业务数据的主家长/孩子请使用「物理清除」（管理员管理 / 家庭关系）。
          </div>
        </Card>
      )}
    </div>
  );
}
