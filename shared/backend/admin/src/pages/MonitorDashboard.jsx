import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Tag, Descriptions, Tabs } from 'antd';
import {
  ApiOutlined, WarningOutlined, ClockCircleOutlined, ThunderboltOutlined,
  CloudServerOutlined, NodeIndexOutlined, BgColorsOutlined, AppstoreOutlined,
  DatabaseOutlined, SendOutlined,
} from '@ant-design/icons';
import { Line, Area } from '@ant-design/charts';
import { dashboardApi } from '../services/api';
import MonitorDataTable from '../components/MonitorDataTable.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';

export default function MonitorDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dashboardApi.monitor()
      .then(res => setData(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const trace = data?.trace || {};
  const trend = data?.monitorTrend || [];
  const respTrend = data?.respTrend || [];
  const instance = data?.instanceInfo || null;

  const last = trend[trend.length - 1] || {};
  const latest = {
    cpu: last.cpu ?? 0,
    rss: last.rss ?? 0,
    heap: last.heap ?? 0,
    handles: last.handles ?? 0,
    reqs: last.reqs ?? 0,
  };

  const statItems = [
    { title: '总请求数', value: trace.totalReq || 0, icon: <ApiOutlined />, color: '#1677ff' },
    { title: '错误数', value: trace.errCount || 0, icon: <WarningOutlined />, color: '#ff4d4f' },
    { title: '平均耗时(ms)', value: trace.avgCost || 0, icon: <ClockCircleOutlined />, color: '#722ed1' },
    { title: '慢请求(>350ms)', value: trace.slowCount || 0, icon: <ThunderboltOutlined />, color: '#fa8c16' },
    { title: '当前CPU(%)', value: latest.cpu, icon: <BgColorsOutlined />, color: '#52c41a', precision: 2 },
    { title: 'RSS内存(MB)', value: latest.rss, icon: <CloudServerOutlined />, color: '#13c2c2' },
    { title: '活跃句柄', value: latest.handles, icon: <AppstoreOutlined />, color: '#eb2f96' },
    { title: '活跃请求', value: latest.reqs, icon: <NodeIndexOutlined />, color: '#2f54eb' },
  ];

  // 底部仅显示时分秒（HH:mm:ss），去掉日期避免拥挤
  const fmtTime = (t) => (t ? String(t).slice(11) : '');

  const cpuCfg = {
    data: trend.map(t => ({ time: fmtTime(t.time), cpu: t.cpu })),
    xField: 'time', yField: 'cpu',
    smooth: true, color: '#fa8c16', height: 260,
    point: { size: 3, shape: 'circle' },
    tooltip: { formatter: (d) => ({ name: 'CPU 使用率', value: `${d.cpu}%` }) },
    yAxis: { min: 0, title: { text: '%' } },
    xAxis: { label: { autoRotate: true, rotate: 45 }, tickCount: 10 },
  };

  const memCfg = {
    data: trend.flatMap(t => [
      { time: fmtTime(t.time), type: 'RSS', value: t.rss },
      { time: fmtTime(t.time), type: '堆内存', value: t.heap },
      { time: fmtTime(t.time), type: '外部内存', value: t.external },
    ]),
    xField: 'time', yField: 'value', seriesField: 'type',
    smooth: true, height: 260,
    color: ['#1677ff', '#52c41a', '#faad14'],
    xAxis: { label: { autoRotate: true, rotate: 45 }, tickCount: 10 },
  };

  const ioCfg = {
    data: trend.flatMap(t => [
      { time: fmtTime(t.time), type: '活跃句柄', value: t.handles },
      { time: fmtTime(t.time), type: '活跃请求', value: t.reqs },
    ]),
    xField: 'time', yField: 'value', seriesField: 'type',
    smooth: true, height: 260,
    color: ['#eb2f96', '#2f54eb'],
    xAxis: { label: { autoRotate: true, rotate: 45 }, tickCount: 10 },
  };

  // 响应时间趋势（按分钟聚合平均耗时）
  const respCfg = {
    data: respTrend.map(t => ({ time: fmtTime(t.time), avgMs: t.avgMs, count: t.count })),
    xField: 'time', yField: 'avgMs',
    smooth: true, color: '#722ed1', height: 280,
    point: { size: 3, shape: 'circle' },
    tooltip: { formatter: (d) => ({ name: '平均响应时间', value: `${d.avgMs} ms` }) },
    yAxis: { min: 0, title: { text: 'ms' } },
    xAxis: { label: { autoRotate: true, rotate: 45 }, tickCount: 10 },
  };

  return (
    <div>
      {loading && <PageSkeleton type="dashboard" />}

      {!loading && (
      <>
      <Row gutter={[16, 16]}>
        {statItems.map(it => (
          <Col xs={24} sm={12} xl={6} key={it.title}>
            <Card>
              <Statistic
                title={it.title}
                value={it.value}
                precision={it.precision}
                prefix={<span style={{ color: it.color }}>{it.icon}</span>}
                valueStyle={{ color: it.color }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {instance && (
        <Card title="实例概览" style={{ marginTop: 16 }}>
          <Descriptions size="small" column={4}>
            <Descriptions.Item label="实例ID">{instance.instance_id}</Descriptions.Item>
            <Descriptions.Item label="环境">{instance.env_id}</Descriptions.Item>
            <Descriptions.Item label="规格">{instance.instance_spec || `${instance.cpu_cores}核/${instance.mem_total_mb}MB`}</Descriptions.Item>
            <Descriptions.Item label="Node 版本">{instance.node_version}</Descriptions.Item>
            <Descriptions.Item label="内网IP">{instance.internal_ip || '-'}</Descriptions.Item>
            <Descriptions.Item label="可用区">{instance.zone_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="集群">{instance.cluster_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="运行时长"><Tag color="blue">{instance.uptime_min} 分钟</Tag></Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="CPU 使用率趋势" extra={<Tag color="orange">%</Tag>}>
            {trend.length > 0 ? <Line {...cpuCfg} /> : <EmptyTip />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="内存趋势（RSS / 堆 / 外部）" extra={<Tag color="blue">MB</Tag>}>
            {trend.length > 0 ? <Area {...memCfg} /> : <EmptyTip />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="活跃句柄 / 活跃请求趋势">
            {trend.length > 0 ? <Line {...ioCfg} /> : <EmptyTip />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="响应时间趋势（平均耗时 ms）">
            {respTrend.length > 0 ? <Line {...respCfg} /> : <EmptyTip />}
          </Card>
        </Col>
      </Row>

      <Card title="监控数据查询" style={{ marginTop: 16 }}>
        <Tabs
          items={[
            {
              key: 'monitors',
              label: <span><DatabaseOutlined /> 服务监控记录</span>,
              children: <MonitorDataTable biz="monitors" />,
            },
            {
              key: 'traces',
              label: <span><SendOutlined /> 接口链路记录</span>,
              children: <MonitorDataTable biz="traces" />,
            },
          ]}
        />
      </Card>
      </>
      )}
    </div>
  );
}

function EmptyTip() {
  return <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>暂无监控数据，请等待服务监控采集</div>;
}
