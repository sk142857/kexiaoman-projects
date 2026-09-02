// 物理清除确认（复用后台「一键物理清除 + 完整审计」流程）
// openPurgeConfirm(record) → 拉取完整删除审计清单 → Modal 展示逐表审计项 → 确认后执行 purge
// 供「管理员管理」行操作 与「家庭关系」一级主家长节点 共用，保证删除审计体验一致。
import React from 'react';
import { Modal, Table, Tag, message, Alert } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { crudApi } from '../services/api';

const ROLE_CN = { admin: '管理员', parent: '主家长', student: '孩子', family: '家属', personal: '个人', user: '微信用户' };

/** 删除审计清单预览（目标 / 清除范围 / 逐表计数 / 样本行 / 媒体文件数） */
export function PurgePreview({ manifest }) {
  const target = manifest.target || {};
  const scope = manifest.scope || {};
  const items = manifest.items || [];
  const total = items.reduce((s, it) => s + (Number(it.count) || 0), 0);
  const rows = items.filter(it => Number(it.count) > 0);
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Tag color="red"><WarningOutlined /> 该操作会物理删除以下全部数据，不可恢复</Tag>
      </div>
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        目标账号：<b>{target.nickname || target.username || target.staff_id}</b>
        （{ROLE_CN[target.role] || target.role || '-'} · {target.username || target.staff_id}）
      </div>
      <div style={{ marginBottom: 8, fontSize: 13, color: '#666' }}>
        清除范围：{scope.staff && scope.staff.length > 0
          ? scope.staff.map(s => `${s.nickname || s.username || s.staff_id}（${ROLE_CN[s.role] || s.role || '-'}）`).join('、')
          : '无'}
        {scope.openids && scope.openids.length > 0 ? `；绑定微信用户 ${scope.openids.length} 个` : ''}
      </div>
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        共 <b style={{ color: '#ff4d4f' }}>{total}</b> 条业务记录、{' '}
        <b style={{ color: '#ff4d4f' }}>{manifest.media_files || 0}</b> 个云存储媒体文件将被物理删除
      </div>
      {rows.length > 0 && (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={rows}
          columns={[
            { title: '数据类别', dataIndex: 'label', width: 130 },
            { title: '删除数量', dataIndex: 'count', width: 90, render: (v) => <span style={{ color: '#ff4d4f', fontWeight: 600 }}>{v}</span> },
            { title: '样本（前 5 条）', key: 'sample', render: (_, r) => {
              if (!Array.isArray(r.sample) || r.sample.length === 0) return <span style={{ color: '#999' }}>—</span>;
              return (
                <div style={{ fontSize: 12, color: '#555', lineHeight: '18px', maxHeight: 72, overflow: 'hidden' }}>
                  {r.sample.map((s, i) => (
                    <div key={i}>
                      {Object.entries(s).map(([k, v]) => `${k}=${v == null ? '' : v}`).join(' · ')}
                    </div>
                  ))}
                </div>
              );
            } },
          ]}
        />
      )}
      {rows.length === 0 && <div style={{ color: '#999' }}>该账号名下暂无业务数据。</div>}
    </div>
  );
}

/**
 * 打开物理清除确认弹窗（先审阅删除审计清单，确认后执行）。
 * @param {object} record 目标账号行（须含 staff_id；昵称/账号用于标题展示）
 * @param {object} opts { refresh: () => void } 成功后刷新列表
 * @returns {Promise<boolean>} 是否执行了清除
 */
export async function openPurgeConfirm(record, { refresh } = {}) {
  const staffId = record && (record.staff_id ?? record.staffId);
  if (!staffId) return false;
  let manifest;
  try {
    const res = await crudApi.staffPurgePreview(staffId);
    manifest = res.data;
  } catch (_) {
    return false;
  }
  const name = record.staff_nickname || record.staff_username || record.nickname || record.username || `#${staffId}`;
  return new Promise((resolve) => {
    Modal.confirm({
      title: `物理清除「${name}」`,
      width: 760,
      okText: '确认物理清除',
      okType: 'danger',
      cancelText: '取消',
      content: <PurgePreview manifest={manifest} />,
      onOk: async () => {
        try {
          const res = await crudApi.staffPurge(staffId);
          const r = (res && res.data) || {};
          const failed = (r && r.failed) || [];
          if (r && r.status === 'partial') {
            message.warning(`物理清除部分失败（${failed.length} 步）：${failed.join('；') || '详见操作审计'}`);
          } else {
            message.success('已物理清除');
          }
          if (refresh) refresh();
          resolve(true);
        } catch (_) {
          resolve(false);
        }
      },
      onCancel: () => resolve(false),
    });
  });
}

/**
 * 用户冗余数据物理清理确认弹窗（用户管理 → 物理清理）。
 * 仅删除该用户（openid）自己相关的数据/绑定/关联；绑定的业务账号因删除而完全孤儿化时一并单账号清除。
 * @param {object} record 用户行（须含 user_id；昵称用于标题）
 * @param {object} opts { refresh: () => void } 成功后刷新列表
 */
export async function openUserPurgeConfirm(record, { refresh } = {}) {
  const userId = record && (record.user_id ?? record.id);
  if (!userId) return false;
  let manifest;
  try {
    const res = await crudApi.userPurgePreview(userId);
    manifest = res.data;
  } catch (_) {
    return false;
  }
  const name = record.nickname || record.user_uid || record.openid || `#${userId}`;
  return new Promise((resolve) => {
    Modal.confirm({
      title: `物理清理微信用户「${name}」`,
      width: 760,
      okText: '确认物理清理',
      okType: 'danger',
      cancelText: '取消',
      content: (
        <div>
          <Alert type="warning" showIcon message="物理清理为双向强删：该微信若绑定主家长，会连同其名下孩子/家属（含孩子自己手机绑定的微信）一并物理删除；绑定孩子/家属/个人则删除该账号自身数据。均为不可恢复。" style={{ marginBottom: 8 }} />
          <div style={{ marginBottom: 8, color: '#8c8c8c', fontSize: 12 }}>
            删除后若该微信号再次打开小程序会自动重建画像（属正常）。
          </div>
          <PurgePreview manifest={manifest} />
        </div>
      ),
      onOk: async () => {
        try {
          const res = await crudApi.userPurge(userId);
          const r = (res && res.data) || {};
          const failed = (r && r.failed) || [];
          if (r && r.status === 'partial') {
            message.error(`物理清理未完全成功，仍有记录未删除：${failed.join('；') || '详见操作审计'}`);
          } else {
            message.success('已物理清理');
          }
          if (refresh) refresh();
          resolve(true);
        } catch (_) {
          resolve(false);
        }
      },
      onCancel: () => resolve(false),
    });
  });
}
