import React from 'react';
import { Skeleton, Card, Row, Col } from 'antd';

/**
 * 后台页面统一骨架屏
 * 页面/表格首次加载数据时替代真实内容展示，数据就绪后切换为真实组件（见 CommonCrud / MonitorDataTable / 各页面）。
 * 复用 antd Skeleton（active 自带 shimmer 动画），无需额外 CSS。
 *
 * type:
 *  - table     通用 CRUD 表格页（标题栏 + 工具栏 + 表头 + 数据行 + 分页）
 *  - cards     卡片网格页（待办任务 / 任务卡片 / 打卡审核）
 *  - dashboard 监控仪表盘（KPI 卡片 + 实例概览 + 图表卡片）
 *  - learning  学习仪表盘（英雄卡 + KPI 卡片 + 图表卡片 + 徽章网格）
 *  - dict      数据字典页（左侧类型 / 右侧字典项 双面板）
 *  - timeline  时间轴抽屉（任务/打卡流程）
 */
export default function PageSkeleton({ type = 'table', ...rest }) {
  switch (type) {
    case 'cards':
      return <CardsSkeleton {...rest} />;
    case 'dashboard':
      return <DashboardSkeleton />;
    case 'learning':
      return <LearningSkeleton />;
    case 'dict':
      return <DictSkeleton />;
    case 'timeline':
      return <TimelineSkeleton />;
    case 'table':
    default:
      return <TableSkeleton {...rest} />;
  }
}

// ==================== 通用 CRUD 表格页 ====================
function TableSkeleton({ rows = 8 }) {
  return (
    <div>
      {/* 标题栏 + 工具栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <Skeleton.Input active size="small" style={{ width: 140 }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Skeleton.Input active size="small" style={{ width: 130 }} />
          <Skeleton.Input active size="small" style={{ width: 120 }} />
          <Skeleton.Button active size="small" style={{ width: 72 }} />
        </div>
      </div>
      {/* 表头 + 数据行 */}
      <Card styles={{ body: { padding: 0 } }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #f0f0f0' }}>
          <Skeleton active title={{ width: '30%' }} paragraph={false} />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ padding: '18px 16px', borderBottom: i === rows - 1 ? 'none' : '1px solid #fafafa' }}>
            <Skeleton active paragraph={{ rows: 1 }} />
          </div>
        ))}
      </Card>
      {/* 分页 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Skeleton.Button active size="small" style={{ width: 220 }} />
      </div>
    </div>
  );
}

// ==================== 卡片网格页（待办任务 / 任务卡片 / 打卡审核） ====================
function CardsSkeleton({ rows = 2, twoCol = false, toolbar = false, noCover = false }) {
  const colProps = twoCol ? { span: 12 } : { xs: 24, sm: 12, lg: 8, xl: 6 };
  return (
    <div>
      {toolbar ? (
        // 任务卡片页：顶部筛选/搜索/新增工具栏
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          <Skeleton.Input active size="small" style={{ width: 170 }} />
          <Skeleton.Input active size="small" style={{ width: 130 }} />
          <Skeleton.Input active size="small" style={{ width: 130 }} />
          <Skeleton.Input active size="small" style={{ width: 160 }} />
          <Skeleton.Input active size="small" style={{ width: 200 }} />
          <Skeleton.Button active size="small" style={{ width: 72 }} />
        </div>
      ) : (
        // 待办/审核页：顶部欢迎条/统计卡
        <Card style={{ marginBottom: 16, borderRadius: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Skeleton.Avatar active size={48} shape="square" />
            <div style={{ flex: 1 }}>
              <Skeleton.Input active size="small" style={{ width: 140 }} />
              <div style={{ marginTop: 10 }}>
                <Skeleton.Input active size="small" style={{ width: 260 }} />
              </div>
            </div>
            <div style={{ width: 90, textAlign: 'center' }}>
              <Skeleton.Input active size="small" style={{ width: 60 }} />
            </div>
          </div>
        </Card>
      )}
      <Row gutter={[16, 16]}>
        {Array.from({ length: 4 * rows }).map((_, i) => (
          <Col key={i} {...colProps}>
            <Card styles={{ body: { padding: 0 } }}>
              {!noCover && (
                <Skeleton.Node active style={{ width: '100%', height: 150, borderRadius: 0 }} />
              )}
              <div style={{ padding: 16 }}>
                <Skeleton active title={{ width: '65%' }} paragraph={{ rows: noCover ? 3 : 2 }} />
                <div style={{ marginTop: 14 }}>
                  <Skeleton.Button active size="small" style={{ width: '100%' }} />
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}

// ==================== 监控仪表盘 ====================
function DashboardSkeleton() {
  return (
    <div>
      <Row gutter={[16, 16]}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Col xs={24} sm={12} xl={6} key={i}>
            <Card>
              <Skeleton active title={{ width: '45%' }} paragraph={{ rows: 1 }} />
            </Card>
          </Col>
        ))}
      </Row>
      {/* 实例概览 */}
      <Card title={<Skeleton.Input active size="small" style={{ width: 120 }} />} style={{ marginTop: 16 }}>
        <Row gutter={[16, 16]}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Col xs={24} sm={12} lg={6} key={i}>
              <Skeleton.Input active size="small" style={{ width: '100%' }} />
            </Col>
          ))}
        </Row>
      </Card>
      {/* 图表卡片 */}
      {[0, 1, 2, 3].map(i => (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }} key={i}>
          {[0, 1].map(j => (
            <Col xs={24} lg={12} key={j}>
              <Card title={<Skeleton.Input active size="small" style={{ width: 150 }} />}>
                <Skeleton.Node active style={{ width: '100%', height: 260 }} />
              </Card>
            </Col>
          ))}
        </Row>
      ))}
    </div>
  );
}

// ==================== 学习仪表盘 ====================
function LearningSkeleton() {
  return (
    <div>
      {/* 英雄卡 */}
      <Card style={{ borderRadius: 16, border: 'none', marginBottom: 16, overflow: 'hidden' }}>
        <div style={{ padding: 28, background: 'linear-gradient(120deg,#0f2350 0%,#1b3a7a 42%,#2f5ec4 78%,#4b8bff 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
            <Skeleton.Avatar active size={76} shape="circle" />
            <div style={{ flex: 1 }}>
              <Skeleton.Input active size="small" style={{ width: 160 }} />
              <div style={{ marginTop: 12 }}>
                <Skeleton.Input active size="small" style={{ width: 240 }} />
              </div>
            </div>
            {[0, 1, 2].map(i => (
              <div key={i} style={{ textAlign: 'center', width: 100 }}>
                <Skeleton.Input active size="small" style={{ width: 70 }} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 24 }}>
            <Skeleton.Input active size="small" style={{ width: '100%' }} />
          </div>
        </div>
      </Card>
      {/* KPI 卡片 */}
      <Row gutter={[12, 12]}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Col xs={12} sm={8} md={6} xl={3} key={i}>
            <Card size="small">
              <Skeleton active title={{ width: '55%' }} paragraph={{ rows: 1 }} />
            </Card>
          </Col>
        ))}
      </Row>
      {/* 图表卡片 + 最近动态表格 */}
      {[0, 1, 2].map(i => (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }} key={i}>
          {[0, 1].map(j => (
            <Col xs={24} lg={12} key={j}>
              <Card title={<Skeleton.Input active size="small" style={{ width: 140 }} />}>
                <Skeleton.Node active style={{ width: '100%', height: i === 2 ? 220 : 260 }} />
              </Card>
            </Col>
          ))}
        </Row>
      ))}
      {/* 成就徽章 */}
      <Card title={<Skeleton.Input active size="small" style={{ width: 120 }} />} style={{ marginTop: 16 }}>
        <Row gutter={[12, 12]}>
          {Array.from({ length: 12 }).map((_, i) => (
            <Col xs={12} sm={8} md={6} lg={4} key={i}>
              <Skeleton.Node active style={{ width: '100%', height: 120, borderRadius: 12 }} />
            </Col>
          ))}
        </Row>
      </Card>
    </div>
  );
}

// ==================== 数据字典页 ====================
function DictSkeleton() {
  const rows = Array.from({ length: 8 }).map((_, i) => (
    <div key={i} style={{ padding: '12px 0', borderBottom: '1px solid #fafafa' }}>
      <Skeleton active paragraph={false} title={{ width: '100%' }} />
    </div>
  ));
  return (
    <Row gutter={12} style={{ padding: 4 }}>
      <Col xs={24} md={9} lg={8}>
        <Card
          size="small"
          title={<Skeleton.Input active size="small" style={{ width: 100 }} />}
          extra={<Skeleton.Button active size="small" style={{ width: 90 }} />}
        >
          {rows}
        </Card>
      </Col>
      <Col xs={24} md={15} lg={16}>
        <Card
          size="small"
          title={<Skeleton.Input active size="small" style={{ width: 140 }} />}
          extra={<Skeleton.Button active size="small" style={{ width: 90 }} />}
        >
          {rows}
        </Card>
      </Col>
    </Row>
  );
}

// ==================== 时间轴抽屉 ====================
function TimelineSkeleton() {
  return (
    <div style={{ padding: '4px 8px' }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#d9d9d9', flexShrink: 0, marginTop: 8 }} />
          <div style={{ flex: 1 }}>
            <Skeleton active title={{ width: '35%' }} paragraph={{ rows: 2 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
