// 家庭关系（树形集中视图）
// 以「主家长」为根聚合展示：名下孩子（孩子档案 + 学生账号 + 小程序绑定 + 学生邀请码）与家属，
// 一眼看清「家长有哪些孩子、孩子有没有绑定、绑定的小程序、后台账号是什么」。
// 数据源 /admin/api/lp_family_tree（只读，后台专用），与「绑定管理/孩子档案/家属关系」表格模块并存。
import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Row, Col, Tag, Avatar, Space, Empty, Tree, Typography, Input, Button,
} from 'antd';
import {
  ReloadOutlined, ApartmentOutlined, UserOutlined,
  LinkOutlined, DisconnectOutlined, KeyOutlined, CheckCircleOutlined, MinusCircleOutlined,
  BookOutlined, CheckSquareOutlined, GiftOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { crudApi } from '../services/api';
import {
  ImageAvatar, StatusTag, MaskId, fmtDateTime,
} from '../components/fields.jsx';
import { openPurgeConfirm } from '../components/PurgeConfirm.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';

// 头像尺寸：与「用户管理」表格等后台模块一致（ImageAvatar 42px，真实头像+昵称首字符回退）
const AVATAR_SIZE = 42;

// 统计指标卡（与学习仪表盘 KPI 卡同风格：白卡 + 渐变图标 + 大数字）
const KPI_STYLE = {
  card: { border: 'none', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', height: '100%' },
  body: { padding: '14px 16px' },
};
function KpiCard({ title, value, suffix, icon, grad, sub }) {
  return (
    <Card size="small" style={KPI_STYLE.card} styles={{ body: KPI_STYLE.body }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#8c8c8c', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#1f1f1f', lineHeight: 1.4 }}>
            {value ?? 0}<span style={{ fontSize: 13, fontWeight: 400, color: '#8c8c8c', marginLeft: 2 }}>{suffix || ''}</span>
          </div>
          {sub && <div style={{ fontSize: 11, color: '#bfbfbf', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
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

// 统计卡配置（图标 + 渐变，风格统一）
const STAT_ITEMS = [
  { key: 'parentCount', title: '主家长', suffix: '人', icon: <UserOutlined />, grad: 'linear-gradient(135deg,#1677ff,#69b1ff)' },
  { key: 'childCount', title: '孩子', suffix: '人', icon: <BookOutlined />, grad: 'linear-gradient(135deg,#08979c,#5cdbd3)' },
  { key: 'boundChildCount', title: '已绑定孩子', suffix: '人', icon: <CheckSquareOutlined />, grad: 'linear-gradient(135deg,#389e0d,#95de64)' },
  { key: 'boundParentCount', title: '已绑定家长', suffix: '人', icon: <LinkOutlined />, grad: 'linear-gradient(135deg,#722ed1,#b37feb)' },
  { key: 'familyMemberCount', title: '家属', suffix: '人', icon: <GiftOutlined />, grad: 'linear-gradient(135deg,#d46b08,#ffa940)' },
];

// 性别（孩子档案）
const GENDER_MAP = { 1: { label: '男', color: 'blue' }, 2: { label: '女', color: 'magenta' } };
// 年级中文（与孩子档案一致：四（6））
const GRADE_CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
// 账号状态
const STAFF_STATUS_MAP = { 1: { label: '启用', color: 'success' }, 0: { label: '禁用', color: 'error' } };
// 邀请码状态
const INVITE_STATUS_MAP = {
  available: { label: '未绑定', color: 'processing' },
  bound: { label: '已绑定', color: 'success' },
  revoked: { label: '已作废', color: 'error' },
};
// 绑定状态
const BIND_STATUS_MAP = { 1: { label: '已绑定', color: 'success' }, 0: { label: '已锁定', color: 'error' } };

/** 绑定状态图标：已绑定绿色链接，未绑定灰色断链 */
const BindIcon = ({ bound }) => (
  bound
    ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
    : <MinusCircleOutlined style={{ color: '#d9d9d9' }} />
);

/** 小程序绑定信息块（openid + 小程序用户 + 绑定时间） */
const BindingBlock = ({ binding, label = '小程序绑定' }) => {
  if (!binding) {
    return (
      <Space size={6}>
        <DisconnectOutlined style={{ color: '#d9d9d9' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>未绑定小程序</Typography.Text>
      </Space>
    );
  }
  const bound = Number(binding.bound_status) === 1;
  return (
    <Space size={6} wrap>
      <BindIcon bound={bound} />
      <span style={{ fontSize: 12 }}>
        <Typography.Text type="secondary">{label}：</Typography.Text>
        <StatusTag value={bound ? 1 : 0} map={BIND_STATUS_MAP} />
        {binding.app_name && <Tag color="geekblue" style={{ marginInlineEnd: 4 }}>{binding.app_name}</Tag>}
        {binding.user_nickname && (
          <Tag color="cyan" style={{ marginInlineEnd: 4 }}>{binding.user_nickname}</Tag>
        )}
        {binding.openid && <MaskId value={binding.openid} maxWidth={150} />}
        {binding.bound_at && (
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>{fmtDateTime(binding.bound_at)}</Typography.Text>
        )}
      </span>
    </Space>
  );
};

/** 主家长节点标题 */
const ParentTitle = ({ family, canPurge, onPurge }) => {
  const p = family.parent || {};
  const childCount = family.children.length;
  const memberCount = family.familyMembers.length;
  const name = p.staff_nickname || p.staff_username || `#${p.staff_id}`;
  return (
    <div style={{ padding: '8px 0' }}>
      <Space size={10} align="center" wrap>
        <ImageAvatar avatar={p.staff_avatar} nickname={name} avatarChar="长" size={AVATAR_SIZE} />
        <span style={{ lineHeight: 1.5 }}>
          <Space size={8} wrap>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>主家长 #{p.staff_id}</Typography.Text>
            <StatusTag value={p.staff_status} map={STAFF_STATUS_MAP} />
          </Space>
          <div style={{ color: '#8c8c8c', fontSize: 12, marginTop: 2 }}>
            登录账号：{p.staff_username || '-'}
          </div>
        </span>
        <span style={{ marginLeft: 16 }}>
          <BindingBlock binding={p.binding} label="本人绑定" />
        </span>
        <Space size={6} style={{ marginLeft: 16 }}>
          <Tag color="purple">{childCount} 个孩子</Tag>
          <Tag color="orange">{memberCount} 位家属</Tag>
        </Space>
        {canPurge && (
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => { e.stopPropagation(); if (onPurge) onPurge(); }}
          >
            物理清除
          </Button>
        )}
      </Space>
    </div>
  );
};

/** 孩子节点标题（单层平铺：孩子 + 学生账号 + 绑定 + 邀请码 一行展示，不嵌套） */
const ChildTitle = ({ child }) => {
  const gradeText = child.grade ? `${GRADE_CN[child.grade] ?? child.grade}（${child.class_no ?? '-'}）` : '';
  const childName = child.child_name || (child.student && child.student.staff_nickname) || `#${child.child_id}`;
  const student = child.student || {};
  return (
    <div style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <ImageAvatar avatar={student.staff_avatar} nickname={childName} avatarChar="孩" size={AVATAR_SIZE} />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{childName}</span>
      <StatusTag value={child.gender} map={GENDER_MAP} />
      {gradeText && <Tag color="blue">{gradeText}</Tag>}
      {child.school_name && <Tag>{child.school_name}</Tag>}
      {child.student ? (
        <Tag color="blue" style={{ whiteSpace: 'nowrap' }}>
          学生账号 #{student.staff_id}
          {student.staff_username ? `（${student.staff_username}）` : ''}
        </Tag>
      ) : (
        <Tag>未建学生账号</Tag>
      )}
      <BindingBlock binding={child.binding} />
      {child.invite && (
        <Space size={4} wrap>
          <KeyOutlined style={{ color: '#722ed1' }} />
          <Typography.Text style={{ fontSize: 12 }} strong>{child.invite.invite_code}</Typography.Text>
          <StatusTag value={child.invite.status} map={INVITE_STATUS_MAP} />
        </Space>
      )}
    </div>
  );
};

/** 家属节点标题 */
const MemberTitle = ({ member }) => {
  const m = member.member || {};
  const name = m.staff_nickname || m.staff_username || `#${member.member_staff_id}`;
  const bound = member.member_openid && Number(member.member_status) === 1;
  return (
    <div style={{ padding: '6px 0' }}>
      <Space size={8} align="center" wrap>
        <ImageAvatar avatar={m.staff_avatar} nickname={name} avatarChar="属" size={AVATAR_SIZE} />
        <span style={{ fontWeight: 600 }}>{name}</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>家属 #{member.member_staff_id}</Typography.Text>
        <StatusTag value={m.staff_status} map={STAFF_STATUS_MAP} />
        <BindIcon bound={bound} />
        {member.member_openid && (
          <MaskId value={member.member_openid} maxWidth={150} />
        )}
        {member.bound_at && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtDateTime(member.bound_at)}</Typography.Text>
        )}
      </Space>
    </div>
  );
};

/** 孤儿档案节点标题（无主家长归属，单层平铺） */
const OrphanTitle = ({ child }) => {
  const gradeText = child.grade ? `${GRADE_CN[child.grade] ?? child.grade}（${child.class_no ?? '-'}）` : '';
  const childName = child.child_name || (child.student && child.student.staff_nickname) || `#${child.child_id}`;
  const student = child.student || {};
  return (
    <div style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <ImageAvatar avatar={student.staff_avatar} nickname={childName} avatarChar="孩" size={AVATAR_SIZE} />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{childName}</span>
      <Tag color="default">无主家长</Tag>
      <StatusTag value={child.gender} map={GENDER_MAP} />
      {gradeText && <Tag color="blue">{gradeText}</Tag>}
      {child.school_name && <Tag>{child.school_name}</Tag>}
      {child.student ? (
        <Tag color="blue" style={{ whiteSpace: 'nowrap' }}>
          学生账号 #{student.staff_id}
          {student.staff_username ? `（${student.staff_username}）` : ''}
        </Tag>
      ) : (
        <Tag>未建学生账号</Tag>
      )}
      <BindingBlock binding={child.binding} />
      {child.invite && (
        <Space size={4} wrap>
          <KeyOutlined style={{ color: '#722ed1' }} />
          <Typography.Text style={{ fontSize: 12 }} strong>{child.invite.invite_code}</Typography.Text>
          <StatusTag value={child.invite.status} map={INVITE_STATUS_MAP} />
        </Space>
      )}
    </div>
  );
};

export default function FamilyTreePage() {
  const [loading, setLoading] = useState(false);
  const [families, setFamilies] = useState([]);
  const [orphanChildren, setOrphanChildren] = useState([]);
  const [summary, setSummary] = useState({});
  const [keyword, setKeyword] = useState('');
  const [expandedKeys, setExpandedKeys] = useState([]);

  // 当前后台登录人（决定一级主家长节点是否展示「物理清除」入口：仅管理员）
  let currentStaff = {};
  try { currentStaff = JSON.parse(localStorage.getItem('admin_user') || '{}'); } catch (_) {}
  const isAdmin = currentStaff.role === 'admin';

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const res = await crudApi.lpFamilyTree();
      const fams = res.data.families || [];
      setFamilies(fams);
      setOrphanChildren(res.data.orphanChildren || []);
      setSummary(res.data.summary || {});
      // 默认全部展开：家庭（第一层）+ 孩子/家属（第二层）
      const keys = fams.map(f => `parent-${f.parent.staff_id}`);
      if ((res.data.orphanChildren || []).length > 0) keys.push('orphans');
      setExpandedKeys(keys);
    } catch (_) {}
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // 一级主家长「物理清除」：一键物理删除该家庭全部关联数据（孩子/家属/绑定/业务数据/媒体），
  // 删除前展示完整删除审计清单，删除后写入「物理清除审计」并刷新本页。
  const handlePurgeParent = async (family) => {
    const parent = family.parent || {};
    await openPurgeConfirm(parent, { refresh: () => load() });
  };

  // 关键词过滤：主家长昵称/账号、孩子姓名、学生昵称/账号
  const match = (text) => {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return true;
    return String(text || '').toLowerCase().includes(kw);
  };
  const visibleFamilies = families
    .filter(f => match(f.parent.staff_nickname) || match(f.parent.staff_username)
      || f.children.some(c => match(c.child_name) || match(c.student && c.student.staff_nickname) || match(c.student && c.student.staff_username)))
    .map(f => {
      if (!keyword) return f;
      const kids = f.children.filter(c => match(c.child_name) || match(c.student && c.student.staff_nickname) || match(c.student && c.student.staff_username));
      return { ...f, children: kids };
    });
  // 孤儿档案同样按关键词过滤
  const visibleOrphans = keyword
    ? orphanChildren.filter(c => match(c.child_name) || match(c.student && c.student.staff_nickname) || match(c.student && c.student.staff_username))
    : orphanChildren;

  // 搜索时自动展开所有命中的家庭分组（否则过滤后缩成一片看不清）
  useEffect(() => {
    if (!keyword) return;
    const keys = visibleFamilies.map(f => `parent-${f.parent.staff_id}`);
    if (visibleOrphans.length > 0) keys.push('orphans');
    setExpandedKeys(keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, families]);

  // 树数据：主家长 → 孩子 + 家属
  const treeData = [
    ...visibleFamilies.map(f => ({
      key: `parent-${f.parent.staff_id}`,
      title: <ParentTitle family={f} canPurge={isAdmin} onPurge={() => handlePurgeParent(f)} />,
      children: [
        ...f.children.map(c => ({ key: `child-${c.child_id}`, title: <ChildTitle child={c} /> })),
        ...f.familyMembers.map(m => ({ key: `member-${m.id}`, title: <MemberTitle member={m} /> })),
      ],
    })),
    ...(visibleOrphans.length > 0 ? [{
      key: 'orphans',
      title: (
        <div style={{ padding: '8px 0' }}>
          <Space size={8}>
            <Avatar size={34} style={{ background: '#8c8c8c', color: '#fff' }} icon={<DisconnectOutlined />} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>无主家长归属的孩子</span>
            <Tag color="default">{visibleOrphans.length} 个</Tag>
          </Space>
        </div>
      ),
      children: visibleOrphans.map(c => ({ key: `orphan-${c.child_id}`, title: <OrphanTitle child={c} /> })),
    }] : []),
  ];

  // 展开/收起：只保留最近打开的一级分组（parent / orphans），其余收起
  const onExpand = (keys) => {
    const groupSet = new Set([...families.map(f => `parent-${f.parent.staff_id}`), visibleOrphans.length > 0 ? 'orphans' : '']);
    const valid = (keys || []).filter(k => groupSet.has(k));
    setExpandedKeys(valid);
  };

  return (
    <div>
      {/* ===== 顶部标题栏 ===== */}
      <Card style={{ borderRadius: 16, border: 'none', marginBottom: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
        <Row gutter={16} align="middle">
          <Col flex="none">
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,#1677ff,#69b1ff)', color: '#fff', fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ApartmentOutlined />
            </div>
          </Col>
          <Col flex="auto">
            <div style={{ fontSize: 17, fontWeight: 700 }}>家庭关系</div>
            <div style={{ fontSize: 13, color: '#8c8c8c', marginTop: 4 }}>以主家长为根展示家庭结构：孩子档案、学生账号、小程序绑定与邀请码一目了然</div>
          </Col>
          <Col flex="none" style={{ minWidth: 220 }}>
            <Input.Search
              placeholder="搜索家长/孩子/学生账号"
              allowClear
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onSearch={(v) => setKeyword(v)}
            />
          </Col>
          <Col flex="none">
            <ReloadOutlined style={{ fontSize: 18, color: '#1677ff', cursor: 'pointer' }} onClick={() => load()} />
          </Col>
        </Row>
      </Card>

      {/* ===== 统计指标卡 ===== */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {STAT_ITEMS.map(it => (
          <Col xs={12} sm={8} md={6} xl={4} key={it.key}>
            <KpiCard
              title={it.title}
              value={summary[it.key] || 0}
              suffix={it.suffix}
              icon={it.icon}
              grad={it.grad}
            />
          </Col>
        ))}
      </Row>

      {/* ===== 关系树 ===== */}
      {loading ? (
        <PageSkeleton type="table" />
      ) : treeData.length === 0 ? (
        <Card style={{ borderRadius: 16, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无家庭关系数据" />
        </Card>
      ) : (
        <Card style={{ borderRadius: 16, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
          <div style={{ marginBottom: 12, color: '#8c8c8c', fontSize: 13 }}>
            <Space size={16} wrap>
              <span><LinkOutlined style={{ color: '#52c41a', marginRight: 4 }} />绿色=已绑定小程序</span>
              <span><DisconnectOutlined style={{ color: '#d9d9d9', marginRight: 4 }} />灰色=未绑定</span>
              <span>展开的家庭分组：{expandedKeys.length} / {treeData.length}</span>
            </Space>
          </div>
          <Tree
            showLine
            expandedKeys={expandedKeys}
            onExpand={onExpand}
            treeData={treeData}
            selectable={false}
          />
        </Card>
      )}
    </div>
  );
}
