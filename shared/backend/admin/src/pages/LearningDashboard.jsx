import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Table, Tag, Progress, Avatar, Tooltip, Empty, Select } from 'antd';
import {
  TrophyOutlined, StarFilled, FireOutlined, CalendarOutlined,
  CheckCircleOutlined, PercentageOutlined, FileTextOutlined, ClockCircleOutlined,
  ThunderboltOutlined, RocketOutlined, WarningOutlined, UserSwitchOutlined,
} from '@ant-design/icons';
import { Area, Pie, Column, Bar } from '@ant-design/charts';
import { dashboardApi } from '../services/api';
import { StaffCell } from '../components/fields.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';

const COLORS = {
  blue: '#1677ff',
  green: '#52c41a',
  orange: '#fa8c16',
  purple: '#722ed1',
  red: '#ff4d4f',
  cyan: '#13c2c2',
  gold: '#faad14',
  gray: '#bfbfbf',
};

// 游戏化 KPI 图标渐变背景
const GRADIENTS = {
  gold: 'linear-gradient(135deg,#faad14,#f759ab)',
  purple: 'linear-gradient(135deg,#722ed1,#b37feb)',
  orange: 'linear-gradient(135deg,#d46b08,#ffa940)',
  cyan: 'linear-gradient(135deg,#08979c,#5cdbd3)',
  green: 'linear-gradient(135deg,#389e0d,#95de64)',
  blue: 'linear-gradient(135deg,#1677ff,#69b1ff)',
  gray: 'linear-gradient(135deg,#8c8c8c,#d9d9d9)',
};

// 成就徽章解锁后的专属渐变背景（按徽章 key 区分，避免千篇一律的单调色值）
const BADGE_GRADIENTS = {
  // —— 累计打卡系列 ——
  first_checkin: 'linear-gradient(135deg,#43e97b,#38f9d7)',
  checkin_10: 'linear-gradient(135deg,#f7971e,#ffd200)',
  checkin_50: 'linear-gradient(135deg,#f83600,#f9d423)',
  checkin_100: 'linear-gradient(135deg,#e65c00,#f9d423)',
  checkin_200: 'linear-gradient(135deg,#fa709a,#fee140)',
  checkin_300: 'linear-gradient(135deg,#b721ff,#21d4fd)',
  // —— 连续打卡系列 ——
  streak_3: 'linear-gradient(135deg,#ff512f,#dd2476)',
  streak_7: 'linear-gradient(135deg,#ff0844,#ffb199)',
  streak_14: 'linear-gradient(135deg,#ff6e7f,#bfe9ff)',
  streak_30: 'linear-gradient(135deg,#ff9a9e,#fecfef)',
  streak_60: 'linear-gradient(135deg,#f6d365,#fda085)',
  streak_100: 'linear-gradient(135deg,#f77062,#fe5196)',
  // —— 任务系列 ——
  task_done_1: 'linear-gradient(135deg,#00c6ff,#0072ff)',
  task_done_5: 'linear-gradient(135deg,#4facfe,#00f2fe)',
  task_done_10: 'linear-gradient(135deg,#13547a,#80d0c7)',
  task_done_20: 'linear-gradient(135deg,#0093e9,#80d0c7)',
  task_create_5: 'linear-gradient(135deg,#0ba360,#3cba92)',
  task_create_10: 'linear-gradient(135deg,#11998e,#38ef7d)',
  all_task_done: 'linear-gradient(135deg,#f953c6,#b91d73)',
  // —— 等级系列 ——
  level_3: 'linear-gradient(135deg,#12c2e9,#c471ed)',
  level_5: 'linear-gradient(135deg,#c471ed,#f64f59)',
  level_8: 'linear-gradient(135deg,#b721ff,#f06449)',
  level_10: 'linear-gradient(135deg,#f5af19,#f12711)',
  // —— 科目系列 ——
  subject_3: 'linear-gradient(135deg,#5ee7df,#b490ca)',
  subject_5: 'linear-gradient(135deg,#a18cd1,#fbc2eb)',
  subject_all: 'linear-gradient(135deg,#21d4fd,#b721ff)',
  // —— 活跃系列 ——
  active_30: 'linear-gradient(135deg,#56ab2f,#a8e063)',
  active_100: 'linear-gradient(135deg,#1fa2ff,#12d8fa)',
  day_multi_3: 'linear-gradient(135deg,#f83600,#ffd200)',
  day_multi_5: 'linear-gradient(135deg,#f53844,#42378f)',
  perfect_week: 'linear-gradient(135deg,#7f00ff,#e100ff)',
  // —— 特色系列 ——
  collection_3: 'linear-gradient(135deg,#16bffd,#cb3066)',
  early_bird: 'linear-gradient(135deg,#ffd89b,#19547b)',
  night_owl: 'linear-gradient(135deg,#5f72bd,#9b23ea)',
};

// 未收录的新徽章兜底：按 key 哈希从渐变池确定性取色
const GRADIENT_POOL = [
  'linear-gradient(135deg,#ffb84d,#ff6b35)',
  'linear-gradient(135deg,#12c2e9,#c471ed)',
  'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#f953c6,#b91d73)',
  'linear-gradient(135deg,#00c6ff,#0072ff)',
  'linear-gradient(135deg,#f6d365,#fda085)',
];
const badgeGradient = (key) => {
  if (BADGE_GRADIENTS[key]) return BADGE_GRADIENTS[key];
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADIENT_POOL[h % GRADIENT_POOL.length];
};

const STATUS_COLOR = { todo: '#bfbfbf', doing: '#1677ff', done: '#52c41a', 待完成: '#bfbfbf', 进行中: '#1677ff', 已完成: '#52c41a' };
const STATUS_LABEL = { todo: '待完成', doing: '进行中', done: '已完成' };

// 提醒告警配色：严重=红、警告=橙、提示=蓝、完成=绿
const ALERT_THEME = {
  danger: { bg: '#fff1f0', border: '#ffa39e', accent: '#cf1322', sub: '#8c2b2b' },
  warning: { bg: '#fffbe6', border: '#ffe58f', accent: '#d46b08', sub: '#8a6d3b' },
  info: { bg: '#e6f4ff', border: '#91caff', accent: '#0958d9', sub: '#3a5f8a' },
  success: { bg: '#f6ffed', border: '#b7eb8f', accent: '#389e0d', sub: '#4a7a3a' },
};

// 后端 reminders 中的 icon/card key → 图标映射
const REMINDER_ICON = {
  checkin: <CheckCircleOutlined />,
  streak: <FireOutlined />,
  task: <ClockCircleOutlined />,
  percent: <PercentageOutlined />,
  overdue: <WarningOutlined />,
  deadline: <CalendarOutlined />,
  success: <CheckCircleOutlined />,
};

export default function LearningDashboard() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [students, setStudents] = useState([]);
  // 管理员/家长/家属默认第一个学生，可下拉切换；学生固定本人
  const [viewStudentId, setViewStudentId] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('lp_admin_view_student') || '';
    dashboardApi.learning(saved ? { studentId: saved } : {})
      .then(res => {
        setData(res.data);
        setStudents(res.data.students || []);
        setViewStudentId(res.data.viewStudentId || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const onSwitchStudent = (val) => {
    const v = String(val || '');
    localStorage.setItem('lp_admin_view_student', v);
    setLoading(true);
    dashboardApi.learning(v ? { studentId: v } : {})
      .then(res => {
        setData(res.data);
        setStudents(res.data.students || []);
        setViewStudentId(res.data.viewStudentId || '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  if (loading) {
    return <PageSkeleton type="learning" />;
  }

  // 兼容后端旧响应/缺失字段：默认值合并，任何字段缺失都回退为 0/false，杜绝渲染 undefined
  const stats = {
    totalTasks: 0, todoCount: 0, doingCount: 0, doneCount: 0,
    totalCheckins: 0, todayCheckins: 0, todayCheckedIn: false,
    completionRate: 0, avgCheckin: 0, activeCount: 0, remainingCount: 0,
    ...(data?.stats || {}),
  };
  const level = {
    level: 1, title: '学习新手', xp: 0, xpInLevel: 0, xpToNext: 100, progress: 0, maxLevel: false,
    ...(data?.level || {}),
  };
  const streak = { current: 0, max: 0, todayCheckedIn: false, ...(data?.streak || {}) };
  // 图表数据同样兜底：value 统一归一化为数字，类别字段回退默认值，杜绝图表标签/坐标轴渲染 undefined/NaN
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const days = (data?.days || []).map(d => ({ date: d.date || '', value: num(d.value) }));
  const subjectDist = (data?.subjectDist || []).map(d => ({ name: d.name || '未分类', value: num(d.value) }));
  const statusDist = (data?.statusDist || []).map(d => ({ name: d.name || '其他', value: num(d.value) }));
  const taskRank = (data?.taskRank || []).map(d => ({ title: d.title || '未命名任务', value: num(d.value) }));
  const badges = data?.badges || [];
  const recentCheckinList = data?.recentCheckinList || [];
  const recentTaskList = data?.recentTaskList || [];
  const reminders = data?.reminders || [];
  const student = data?.student || {};
  const pointLogs = data?.pointLogs || [];

  const nickname = student.nickname || student.username || '学习小达人';
  const avatarChar = String(nickname).charAt(0).toUpperCase();
  const unlockedCount = badges.filter(b => b.unlocked).length;

  const kpis = [
    { title: '当前等级', value: `Lv.${level.level ?? 1}`, icon: <TrophyOutlined />, grad: GRADIENTS.gold, sub: level.title || '学习新手' },
    { title: '累计经验', value: level.xp ?? 0, icon: <StarFilled />, grad: GRADIENTS.purple, sub: level.maxLevel ? '已满级' : `距下一级还差 ${level.xpToNext ?? 0}` },
    { title: '连续打卡', value: `${streak.current ?? 0} 天`, icon: <FireOutlined />, grad: GRADIENTS.orange, sub: `历史最长 ${streak.max ?? 0} 天` },
    { title: '累计打卡', value: stats.totalCheckins ?? 0, icon: <CalendarOutlined />, grad: GRADIENTS.cyan, sub: '总打卡次数' },
    { title: '今日打卡', value: stats.todayCheckedIn ? '已完成' : '待完成', icon: <CheckCircleOutlined />, grad: stats.todayCheckedIn ? GRADIENTS.green : GRADIENTS.gray, sub: stats.todayCheckins ? `今日 ${stats.todayCheckins ?? 0} 次` : '记得打卡哦' },
    { title: '任务完成率', value: `${stats.completionRate ?? 0}%`, icon: <PercentageOutlined />, grad: GRADIENTS.blue, sub: `${stats.doneCount ?? 0}/${stats.totalTasks ?? 0} 已完成` },
    { title: '进行中任务', value: stats.activeCount ?? 0, icon: <FileTextOutlined />, grad: GRADIENTS.blue, sub: '正在推进' },
    { title: '待完成任务', value: stats.remainingCount ?? 0, icon: <ClockCircleOutlined />, grad: GRADIENTS.gray, sub: '待完成 + 进行中' },
  ];

  const trendCfg = {
    data: days,
    xField: 'date', yField: 'value',
    smooth: true, height: 260,
    color: COLORS.orange,
    areaStyle: { fillOpacity: 0.2 },
    label: { position: 'top', formatter: (text, datum) => `${datum.value ?? 0}` },
  };

  const statusCfg = {
    data: statusDist,
    angleField: 'value', colorField: 'name', innerRadius: 0.62, height: 260,
    color: statusDist.map(d => STATUS_COLOR[d.name] || COLORS.gray),
    legend: { position: 'right' },
  };

  const subjectCfg = {
    data: subjectDist,
    xField: 'name', yField: 'value', height: 280,
    color: COLORS.purple,
    label: { position: 'top', formatter: (text, datum) => `${datum.value ?? 0}` },
  };

  const rankCfg = {
    data: taskRank,
    xField: 'value', yField: 'title', height: 280,
    color: COLORS.cyan,
    barWidthRatio: 0.5,
    label: { position: 'right', formatter: (text, datum) => `${datum.value ?? 0} 次` },
  };

  const checkinColumns = [
    { title: '任务', dataIndex: 'task_title', width: 140, ellipsis: true },
    { title: '日期', dataIndex: 'checkin_date', width: 110 },
    { title: '备注', dataIndex: 'note', ellipsis: true },
    { title: '图片', dataIndex: 'has_images', width: 80, render: (v) => (v ? <Tag color="green">有</Tag> : <Tag>无</Tag>) },
    { title: '打卡人', dataIndex: 'created_by', width: 160, render: (v, r) => <StaffCell staffId={v} username={r._creatorUsername} nickname={r._creatorNickname} /> },
    { title: '来源', dataIndex: 'source', width: 90, render: (v) => <Tag color={(v === 'web') ? 'purple' : 'blue'}>{v === 'web' ? 'Web后台' : (v === 'miniprogram' ? '小程序' : '-')}</Tag> },
    { title: '时间', dataIndex: 'created_at', width: 150 },
  ];

  const taskColumns = [
    { title: '任务', dataIndex: 'title', width: 140, ellipsis: true },
    { title: '科目', dataIndex: 'subject', width: 80, render: (v) => v || '-' },
    { title: '状态', dataIndex: 'task_status', width: 90, render: (v) => <Tag color={STATUS_COLOR[v] || 'default'}>{STATUS_LABEL[v] || v}</Tag> },
    { title: '来源', dataIndex: 'source', width: 90, render: (v) => <Tag color={(v === 'web') ? 'purple' : 'blue'}>{v === 'web' ? 'Web后台' : (v === 'miniprogram' ? '小程序' : '-')}</Tag> },
    { title: '打卡次数', dataIndex: 'checkin_count', width: 90 },
    { title: '截止', dataIndex: 'deadline', width: 110 },
  ];

  return (
    <div>
      {/* ===== 学习成长卡（英雄区：等级 / 连击 / 经验条） ===== */}
      <Card
        style={{ borderRadius: 16, border: 'none', marginBottom: 16, overflow: 'hidden', boxShadow: '0 8px 24px rgba(64,102,255,0.18)' }}
        styles={{ body: { padding: 0 } }}
      >
        <div style={{ padding: '28px 32px 22px', background: 'linear-gradient(120deg,#0f2350 0%,#1b3a7a 42%,#2f5ec4 78%,#4b8bff 100%)', color: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 20 }}>
            <Avatar size={76} style={{ background: 'rgba(255,255,255,0.16)', border: '2px solid rgba(255,255,255,0.5)', fontSize: 34, color: '#fff' }}>
              {avatarChar}
            </Avatar>
            <div style={{ minWidth: 190 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{nickname}</div>
                <span className="learning-student-switch-label">
                  <UserSwitchOutlined />
                  视角
                </span>
                <Select
                  value={viewStudentId || undefined}
                  onChange={onSwitchStudent}
                  size="small"
                  className="learning-student-switch"
                  popupClassName="learning-student-switch-popup"
                  options={(students || []).map(s => ({ value: s.staff_id, label: s.nickname }))}
                  suffixIcon={<UserSwitchOutlined />}
                />
              </div>
              <div style={{ opacity: 0.82, fontSize: 13 }}>{student.username || '欢迎回到学习空间'}</div>
              <div style={{ marginTop: 6 }}>
                <Tag style={{ background: 'rgba(255,255,255,0.16)', color: '#fff', borderColor: 'rgba(255,255,255,0.4)' }}>🏅 成就 {unlockedCount} 枚</Tag>
              </div>
            </div>

            <div style={{ flex: 1 }} />

            <div style={{ textAlign: 'center', padding: '0 16px', minWidth: 120 }}>
              <div style={{ fontSize: 13, opacity: 0.82 }}>当前等级</div>
              <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1, background: 'linear-gradient(180deg,#ffd666,#ff9c2e)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Lv.{level.level ?? 1}
              </div>
              <div style={{ fontSize: 13, opacity: 0.92 }}>{level.title || '学习新手'}</div>
            </div>

            <div style={{ textAlign: 'center', padding: '0 16px', minWidth: 130 }}>
              <div style={{ fontSize: 13, opacity: 0.82 }}>连续打卡</div>
              <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1 }}>🔥 {streak.current ?? 0}</div>
              <div style={{ fontSize: 13, opacity: 0.92 }}>天 · 历史最长 {streak.max ?? 0} 天</div>
            </div>

            <div style={{ textAlign: 'center', padding: '0 16px', minWidth: 110 }}>
              <div style={{ fontSize: 13, opacity: 0.82 }}>今日状态</div>
              <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.5, marginTop: 2 }}>
                {stats.todayCheckedIn ? '✅ 已打卡' : '⏳ 待打卡'}
              </div>
              <div style={{ fontSize: 13, opacity: 0.92 }}>{stats.todayCheckedIn ? `今日 ${stats.todayCheckins ?? 0} 次` : '快去打卡吧'}</div>
            </div>
          </div>

          <div style={{ marginTop: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, opacity: 0.95 }}>
              <span>⭐ 经验值 {level.xp ?? 0}</span>
              <span>{level.maxLevel ? '🎉 已达成满级' : `距离下一级还差 ${level.xpToNext ?? 0} 经验（打卡 +10 · 完成任务 +30）`}</span>
            </div>
            <Progress
              percent={level.progress ?? 0}
              showInfo={false}
              strokeColor={{ '0%': '#ffd666', '100%': '#ff9c2e' }}
              trailColor="rgba(255,255,255,0.22)"
              strokeWidth={14}
            />
          </div>
        </div>
      </Card>

      {/* ===== 今日提醒（后端生成文案，按优先级展示） ===== */}
      <PriorityAlerts reminders={reminders} />

      {/* ===== 游戏化 KPI ===== */}
      <Row gutter={[12, 12]}>
        {kpis.map(it => (
          <Col xs={12} sm={8} md={6} xl={3} key={it.title}>
            <KpiCard {...it} />
          </Col>
        ))}
      </Row>

      {/* ===== 趋势 / 状态分布（等高卡片，空态用默认高度填充） ===== */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card
            title="近 7 天打卡趋势"
            extra={<Tag color="orange">🔥 保持连击</Tag>}
            style={{ height: '100%' }}
            styles={{ body: { padding: 16 } }}
          >
            {days.length > 0 ? <Area {...trendCfg} /> : <EmptyCfg height={260} />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="任务状态分布" style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
            {statusDist.length > 0 ? <Pie {...statusCfg} /> : <EmptyCfg height={260} />}
          </Card>
        </Col>
      </Row>

      {/* ===== 科目分布 / 打卡排行（等高卡片，空态用默认高度填充） ===== */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="科目分布" extra={<Tag color="purple">学习任务</Tag>} style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
            {subjectDist.length > 0 ? <Column {...subjectCfg} /> : <EmptyCfg height={280} />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="任务打卡排行 TOP8" extra={<Tag color="cyan">🏆 学霸榜单</Tag>} style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
            {taskRank.length > 0 ? <Bar {...rankCfg} /> : <EmptyCfg height={280} />}
          </Card>
        </Col>
      </Row>

      {/* ===== 成就徽章 ===== */}
      <Card
        title={<span><ThunderboltOutlined style={{ color: COLORS.gold }} /> 成就徽章 <Tag color="gold">{unlockedCount}/{badges.length}</Tag></span>}
        style={{ marginTop: 16 }}
      >
        <Row gutter={[12, 12]}>
          {badges.map(b => (
            <Col xs={12} sm={8} md={6} lg={4} key={b.key}>
              <Tooltip title={b.unlocked ? `${b.desc}${b.unlocked_at ? ` · ${b.unlocked_at.slice(0, 10)} 解锁` : ''}` : `未解锁 · ${b.desc}`}>
                <div
                  style={{
                    padding: '14px 10px',
                    borderRadius: 12,
                    textAlign: 'center',
                    transition: 'transform .2s, box-shadow .2s',
                    cursor: 'pointer',
                    ...(b.unlocked
                      ? {
                          background: `linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0) 58%), ${badgeGradient(b.key)}`,
                          boxShadow: '0 8px 20px rgba(0,0,0,0.28)',
                          color: '#fff',
                          border: '1px solid rgba(255,255,255,0.35)',
                        }
                      : {
                          background: '#f5f5f5',
                          color: '#8c8c8c',
                          border: '1px dashed #d9d9d9',
                        }),
                  }}
                >
                  <div style={{ fontSize: 30, lineHeight: 1 }}>{b.unlocked ? b.icon : '🔒'}</div>
                  <div style={{ fontWeight: 600, marginTop: 8 }}>{b.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{b.desc}</div>
                  <div style={{ marginTop: 8 }}>
                    <Progress
                      percent={Math.round((b.progress ?? 0) * 100)}
                      showInfo={false}
                      size="small"
                      strokeColor={b.unlocked ? '#fff' : '#bfbfbf'}
                      trailColor={b.unlocked ? 'rgba(255,255,255,0.35)' : '#e8e8e8'}
                    />
                  </div>
                </div>
              </Tooltip>
            </Col>
          ))}
        </Row>
      </Card>

      {/* ===== 最近动态（等高卡片，空态用默认高度填充） ===== */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="最近打卡记录" style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
            <Table
              rowKey="checkin_id"
              size="small"
              columns={checkinColumns}
              dataSource={recentCheckinList}
              pagination={false}
              locale={{ emptyText: '暂无打卡' }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="最近更新任务" extra={<RocketOutlined style={{ color: COLORS.blue }} />} style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
            <Table
              rowKey="task_id"
              size="small"
              columns={taskColumns}
              dataSource={recentTaskList}
              pagination={false}
              locale={{ emptyText: '暂无任务' }}
            />
          </Card>
        </Col>
      </Row>

      {/* ===== 积分明细（积分账本可审计：每次加减分记录原因与时间） ===== */}
      {viewStudentId ? (
        <Card
          title={<span><StarFilled style={{ color: COLORS.gold }} /> 积分明细 <Tag color="gold">当前余额 {level.xp ?? 0}</Tag></span>}
          extra={<Tag color="blue">打卡审核通过 +10 · 完成任务 +30 · 删除/回退扣分</Tag>}
          style={{ marginTop: 16 }}
        >
          <Table
            rowKey="log_id"
            size="small"
            pagination={false}
            dataSource={pointLogs}
            locale={{ emptyText: '暂无积分流水' }}
            columns={[
              { title: '时间', dataIndex: 'created_at', width: 160 },
              { title: '变动', dataIndex: 'points', width: 90, render: (v) => (
                <span style={{ fontWeight: 700, color: v > 0 ? COLORS.green : (v < 0 ? COLORS.red : '#8c8c8c') }}>
                  {v > 0 ? `+${v}` : v}
                </span>
              ) },
              { title: '原因', dataIndex: 'reason_label', width: 120, render: (v, r) => <Tag color={r.points > 0 ? 'green' : (r.points < 0 ? 'red' : 'default')}>{v}</Tag> },
              { title: '说明', dataIndex: 'note', ellipsis: true },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}

function KpiCard({ title, value, icon, grad, sub }) {
  return (
    <Card
      size="small"
      style={{ borderTop: `3px solid transparent`, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', background: '#fff', height: '100%' }}
      styles={{ body: { padding: '14px 16px' } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#8c8c8c', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#1f1f1f', lineHeight: 1.4 }}>{value ?? 0}</div>
          <div style={{ fontSize: 11, color: '#bfbfbf', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
        </div>
        <div
          style={{
            flexShrink: 0, width: 40, height: 40, borderRadius: 10,
            background: grad, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: '#fff', fontSize: 20,
            boxShadow: '0 4px 10px rgba(0,0,0,0.12)',
          }}
        >
          {icon}
        </div>
      </div>
    </Card>
  );
}

function EmptyCfg({ height = 200 }) {
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
    </div>
  );
}

// ===== 今日提醒：按后端返回的优先级（严重>警告>提示>完成）渲染 =====
function PriorityAlerts({ reminders }) {
  const list = reminders || [];
  if (list.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      {list.map((r, i) => (
        <div key={r.key || i} style={i < list.length - 1 ? { marginBottom: 12 } : undefined}>
          {r.type === 'checkin' ? (
            <Row gutter={[12, 12]}>
              {(r.cards || []).map(c => (
                <Col xs={24} sm={8} key={c.key}>
                  <ReminderCard severity={r.severity} icon={REMINDER_ICON[c.key] || <CheckCircleOutlined />} title={c.title} desc={c.desc} />
                </Col>
              ))}
            </Row>
          ) : (
            <Banner severity={r.severity} icon={REMINDER_ICON[r.icon] || <CheckCircleOutlined />} title={r.title} desc={r.desc} />
          )}
        </div>
      ))}
    </div>
  );
}

// 单条横幅提醒（严重红 / 警告橙 / 提示蓝 / 完成绿）
function Banner({ severity, icon, title, desc }) {
  const t = ALERT_THEME[severity];
  return (
    <div style={{ background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: '16px 18px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 18, color: t.accent, marginTop: 1 }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: t.accent, fontSize: 14, lineHeight: 1.5 }}>{title}</div>
        <div style={{ fontSize: 13, color: t.sub, marginTop: 4, lineHeight: 1.6 }}>{desc}</div>
      </div>
    </div>
  );
}

// 卡片式提醒（今日还没打卡组件：1 行 3 列；高度与「当前等级」等 KPI 卡片对齐，保证版式统一）
function ReminderCard({ severity, icon, title, desc }) {
  const t = ALERT_THEME[severity];
  return (
    <div style={{ boxSizing: 'border-box', background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: '14px 16px', minHeight: 100, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontSize: 18, color: t.accent, lineHeight: 1.3 }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: t.accent, fontSize: 13, lineHeight: 1.5 }}>{title}</div>
          <div style={{ fontSize: 12, color: t.sub, marginTop: 4, lineHeight: 1.6 }}>{desc}</div>
        </div>
      </div>
    </div>
  );
}
