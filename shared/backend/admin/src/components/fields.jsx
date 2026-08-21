import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Tag, Progress, Avatar, Typography, Space, Rate, Image, Upload, message, Button, Select, Modal } from 'antd';
import { PlusOutlined, DeleteOutlined, LoadingOutlined, PictureOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import ImgCrop from 'antd-img-crop';
import { uploadApi, crudApi } from '../services/api';

// ==================== 时间格式化 ====================
export const fmtDateTime = (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-');
export const fmtDateOnly = (v) => (v ? dayjs(v).format('YYYY-MM-DD') : '-');

// ==================== 图片访问域名（云存储公开访问地址，与后端 storage.js 保持一致） ====================
export const STORAGE_DOMAIN = 'https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la';

/** 相对路径 → 完整 URL */
export const toImageUrl = (p) => {
  if (!p) return '';
  const s = String(p).replace(/^\/+/, '');
  return s.startsWith('http') ? s : `${STORAGE_DOMAIN}/${s}`;
};

/** 云存储图片 → 缩略图 URL（数据万象图片基础处理：限定宽高最大值等比缩放）
 * 仅内部存储域名追加处理参数，外部 URL（如微信头像）原样返回 */
export const toThumbUrl = (p, size = 300) => {
  const url = toImageUrl(p);
  if (!url || !url.startsWith(STORAGE_DOMAIN)) return url;
  const sizeStr = Number(size) > 0 ? Number(size) : 300;
  return `${url}?imageMogr2/thumbnail/${sizeStr}x${sizeStr}`;
};

/**
 * 图片字段解析：兼容多种存储格式，统一返回路径数组
 * - JSON 数组字符串：["a.jpg","b.jpg"]
 * - 逗号分隔字符串（历史数据）：a.jpg,b.jpg
 * - 数组
 * 空值（'' / null / undefined / '[]'）一律返回 []
 */
export const parseImages = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const s = value.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch (_) { /* 非 JSON，按逗号分隔处理 */ }
  }
  return s.split(',').map(x => x.trim()).filter(Boolean);
};

/** 路径数组 → JSON 数组字符串（空数组为 '[]'，供表单/入库使用） */
export const imagesToJson = (paths) => JSON.stringify(parseImages(paths));

// ==================== 图片加载失败占位图（灰底图片图标，避免破图） ====================
export const IMG_FALLBACK = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">' +
  '<rect width="120" height="120" fill="#f5f5f5"/>' +
  '<rect x="34" y="26" width="52" height="40" rx="4" fill="none" stroke="#d9d9d9" stroke-width="3"/>' +
  '<circle cx="46" cy="38" r="4" fill="#d9d9d9"/>' +
  '<path d="M38 58 l15 -11 12 9 8 -6 14 12" fill="none" stroke="#d9d9d9" stroke-width="3" stroke-linejoin="round"/>' +
  '</svg>'
);

// ==================== 对象安全转文本（避免渲染成 [object Object] / React 元素内部结构） ====================
export const toText = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // React 元素（误传内部渲染节点时）：取其文本子节点，避免把组件结构序列化到界面
    if (v.$$typeof) {
      const c = v.props && v.props.children;
      return (typeof c === 'string' ? c : '');
    }
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
};

// ==================== 从对象值中解包 ID 字符串（openid 等若被存成对象则取回其字符串） ====================
const pickId = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    for (const k of ['openid', 'session_id', 'request_id', 'user_id', 'id', 'value']) {
      const x = v[k];
      if (typeof x === 'string' && x) return x;
    }
    return toText(v);
  }
  return String(v);
};

// ==================== ID/长标识展示：过长时中间截断填充 ***（完整值在 title 且可复制） ====================
// 不使用 Typography 的 ellipsis 机制，避免其内部测量节点被表格误当值序列化
export function MaskId({ value, maxWidth = 200, keep = 10, tail = 8 }) {
  const s = pickId(value);
  if (s === '') return <EmptyText />;
  const display = s.length > keep + tail + 3 ? `${s.slice(0, keep)}***${s.slice(-tail)}` : s;
  return (
    <Typography.Text copyable={{ text: s }} style={{ fontSize: 12 }}>
      <span
        title={s}
        style={{ display: 'inline-block', maxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}
      >
        {display}
      </span>
    </Typography.Text>
  );
}

// ==================== 空值占位 ====================
export function EmptyText() {
  return <Typography.Text type="secondary">-</Typography.Text>;
}

// ==================== 状态/枚举 Tag ====================
// map: { '1': { label: '正常', color: 'success' }, ... }（兼容字符串/数字 key）
export function StatusTag({ value, map, defaultColor = 'default' }) {
  const s = toText(value);
  if (s === '') return <EmptyText />;
  const conf = (map && (map[s] || map[value])) || {};
  return <Tag color={conf.color || defaultColor}>{conf.label !== undefined ? conf.label : s}</Tag>;
}

// ==================== 带色值 Tag（字典项等业务标签着色用） ====================
// 直接复用 antd Tag 的 color 机制：有 color 时按该色值渲染（含自定义 hex），无 color 则渲染默认 Tag
export function ColorTag({ value, color, style }) {
  const s = toText(value);
  if (s === '') return <EmptyText />;
  return <Tag color={color || undefined} style={{ marginRight: 0, ...style }}>{s}</Tag>;
}

// ==================== 字典项驱动 Tag（按字典编码加载，取 item_label + color 渲染） ====================
// 页面渲染字典值时使用：颜色来自字典项配置的 color（antd Tag 标准色值渲染），未配置颜色则为默认 Tag。
// 模块级缓存：同一字典只请求一次，多个单元格/详情共用。
const dictMapCache = {}; // code -> Promise<{ item_value: { label, color } }>
export function getDictMap(code) {
  if (!dictMapCache[code]) {
    dictMapCache[code] = crudApi.list('dict_items', { page: 1, pageSize: 200, dict_code: code })
      .then((res) => {
        const map = {};
        (res.data.list || []).forEach((it) => {
          map[it.item_value] = { label: it.item_label || it.item_value, color: it.color || '' };
        });
        return map;
      })
      .catch(() => ({}));
  }
  return dictMapCache[code];
}
/** 清除字典缓存（字典项增删改后调用，保证业务页标签颜色即时更新） */
export function clearDictMap(code) {
  if (code) delete dictMapCache[code];
  else Object.keys(dictMapCache).forEach((k) => delete dictMapCache[k]);
}
export function DictTag({ code, value, style }) {
  const [map, setMap] = useState(null);
  useEffect(() => {
    let alive = true;
    getDictMap(code).then((m) => { if (alive) setMap(m); });
    return () => { alive = false; };
  }, [code]);
  const item = (map && value != null) ? map[value] : null;
  const s = item ? item.label : toText(value);
  if (s === '') return <EmptyText />;
  return <Tag color={(item && item.color) || undefined} style={{ marginRight: 0, ...style }}>{s}</Tag>;
}

// ==================== 可复制文本（超长省略 + tooltip，仅关键字段用） ====================
// 注意：不使用 Typography 的 ellipsis 机制（其内部测量节点会被表格误当值序列化），改用纯 CSS 省略
export function CopyText({ value, maxWidth = 240 }) {
  const s = toText(value);
  if (s === '') return <EmptyText />;
  return (
    <Typography.Text copyable={{ text: s }}>
      <span
        title={s}
        style={{ display: 'inline-block', maxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}
      >
        {s}
      </span>
    </Typography.Text>
  );
}

// ==================== 纯文本（无复制，普通字段直接展示，纯 CSS 省略） ====================
export function PlainText({ value, maxWidth = 260 }) {
  const s = toText(value);
  if (s === '') return <EmptyText />;
  return (
    <span
      title={s}
      style={{ display: 'inline-block', maxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}
    >
      {s}
    </span>
  );
}

// ==================== 多行长文本（抽屉详情用） ====================
export function LongText({ value }) {
  const s = toText(value);
  if (s === '') return <EmptyText />;
  return <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{s}</div>;
}

// ==================== 长文本 + 链接自动识别（抽屉详情用） ====================
// 文本中的 http/https URL 自动转为可点击链接（新窗口打开），其余保持纯文本
export function LinkText({ value }) {
  const s = toText(value);
  if (s === '') return <EmptyText />;
  const parts = s.split(/(https?:\/\/[^\s"'<>（）()，,；;]+)/g);
  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {parts.map((p, i) => {
        if (/^https?:\/\//.test(p)) {
          return (
            <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </div>
  );
}

// ==================== Emoji 头像 ====================
export function EmojiAvatar({ value, size = 'small' }) {
  if (typeof value !== 'string' || value === '') return <EmptyText />;
  const dim = size === 'large' ? 30 : 22;
  return (
    <Avatar style={{ backgroundColor: '#fde3cf', fontSize: dim * 0.72, width: dim, height: dim, lineHeight: `${dim}px` }}>
      {value}
    </Avatar>
  );
}

// ==================== 统一全局随机 hash 色值（全后台取色规范） ====================
// 色板固定 7 色：#f6685d / #e37318 / #2ba471 / #c6c6c6 / #029cd4 / #ad75fe / #e851b3
// 确定性 hash：同一文本恒取同一色，禁止直接 Math.random（避免刷新闪色/前后端不一致）
// 适用：字符头像、任务标签等无字典色值的业务文本；规范详见 docs/后端UI设计规范.md「统一随机 hash 色值」
export const HASH_COLORS = ['#f6685d', '#e37318', '#2ba471', '#c6c6c6', '#029cd4', '#ad75fe', '#e851b3'];
/** 任意文本 → hash 色值（同文本恒同色） */
export const hashColorFor = (text) => {
  const s = String(text || '');
  if (!s) return HASH_COLORS[0];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HASH_COLORS[h % HASH_COLORS.length];
};

// ==================== 用户头像（图片优先；无地址/加载失败一律取昵称首字符，字母大写） ====================
/** 头像取色：首字符 hash → 统一走 hashColorFor（同字符恒同色，全后台一致，避免随机不一致） */
export const avatarColorFor = (ch) => hashColorFor(ch);
export function ImageAvatar({ avatar, avatarChar, nickname, size = 45, background }) {
  const url = toImageUrl(avatar);
  // 无头像地址：一律取昵称第一个字符（字母大写）；昵称为空再回退 avatarChar/默认
  const n = String(nickname || '').trim();
  let ch = n ? n.charAt(0) : (avatarChar || '微');
  ch = /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
  const [failed, setFailed] = useState(false);
  // 无头像背景色：按首字符 hash 从预设色板确定性取色
  const bg = useMemo(() => background || avatarColorFor(ch), [ch, background]); // eslint-disable-line react-hooks/exhaustive-deps
  const showImg = !!url && !failed;
  if (!showImg) {
    return (
      <Avatar style={{ backgroundColor: bg, fontSize: size * 0.5, width: size, height: size, lineHeight: `${size}px`, flexShrink: 0 }}>
        {ch}
      </Avatar>
    );
  }
  return (
    <Avatar
      src={url}
      size={size}
      style={{ flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}

// ==================== 用户单元（头像45px + 用户ID + 昵称） ====================
export function UserCell({ userId, nickname, avatar, avatarChar, showNick = true }) {
  return (
    <Space size={12}>
      <ImageAvatar avatar={avatar} avatarChar={avatarChar} nickname={nickname} size={45} />
      <span style={{ lineHeight: 1.4, minWidth: 0 }}>
        <div style={{ whiteSpace: 'nowrap' }}>{userId || '-'}</div>
        {showNick && nickname ? (
          <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nickname}</Typography.Text>
        ) : null}
      </span>
    </Space>
  );
}

// ==================== 后台员工单元（staff_id + 昵称，无头像用昵称首字符，与用户头像同尺寸/同取色） ====================
// 用于学习任务/打卡等由后台员工创建的记录：左侧取昵称首字符作头像，右侧上为员工ID、下为昵称
export function StaffCell({ staffId, nickname }) {
  const id = pickId(staffId);
  if (id === '') return <EmptyText />;
  const n = String(nickname || '').trim();
  return (
    <Space size={10}>
      <ImageAvatar nickname={n} avatarChar="员" size={45} />
      <span style={{ lineHeight: 1.4, minWidth: 0 }}>
        <div style={{ whiteSpace: 'nowrap' }}>{id}</div>
        <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n || '-'}</Typography.Text>
      </span>
    </Space>
  );
}

// ==================== 上传者单元（后台员工 staff_id 优先，否则为小程序用户） ====================
export function UploaderCell({ staffId, userId, nickname, avatar, avatarChar }) {
  if (staffId) {
    return (
      <Space size={12}>
        <ImageAvatar nickname={nickname} avatarChar="员" size={45} />
        <span style={{ lineHeight: 1.4 }}>
          <div style={{ whiteSpace: 'nowrap' }}>{staffId}</div>
          <Typography.Text type="secondary">后台员工</Typography.Text>
        </span>
      </Space>
    );
  }
  return <UserCell userId={userId} nickname={nickname} avatar={avatar} avatarChar={avatarChar} />;
}

// ==================== 颜色展示 ====================
export function ColorDot({ value }) {
  if (typeof value !== 'string' || value === '') return <EmptyText />;
  return (
    <Space size={6}>
      <span
        style={{
          display: 'inline-block', width: 12, height: 12, borderRadius: 3,
          backgroundColor: value, border: '1px solid #ddd', verticalAlign: 'middle',
        }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value}</Typography.Text>
    </Space>
  );
}

// ==================== JSON / 对象展示（代码美化 + 语法高亮） ====================
const JSON_COLORS = {
  key: '#1677ff',
  string: '#52c41a',
  number: '#fa8c16',
  bool: '#722ed1',
  null: '#bfbfbf',
  punct: '#8c8c8c',
};

function JsonValue({ data, indent = 0 }) {
  const pad = '  '.repeat(indent);
  if (data === null) return <span style={{ color: JSON_COLORS.null }}>null</span>;
  if (typeof data === 'boolean') return <span style={{ color: JSON_COLORS.bool }}>{String(data)}</span>;
  if (typeof data === 'number') return <span style={{ color: JSON_COLORS.number }}>{data}</span>;
  if (typeof data === 'string') {
    const s = data.length > 500 ? `${data.slice(0, 500)}…` : data;
    return <span style={{ color: JSON_COLORS.string }}>{JSON.stringify(s)}</span>;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return <span style={{ color: JSON_COLORS.punct }}>[]</span>;
    return (
      <span>
        <span style={{ color: JSON_COLORS.punct }}>[</span>
        {data.map((item, i) => (
          <span key={i}>
            <br />{pad}  <JsonValue data={item} indent={indent + 1} />
            {i < data.length - 1 ? <span style={{ color: JSON_COLORS.punct }}>,</span> : null}
          </span>
        ))}
        <br />{pad}<span style={{ color: JSON_COLORS.punct }}>]</span>
      </span>
    );
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length === 0) return <span style={{ color: JSON_COLORS.punct }}>{'{}'}</span>;
    return (
      <span>
        <span style={{ color: JSON_COLORS.punct }}>{'{'}</span>
        {keys.map((k, i) => (
          <span key={k}>
            <br />{pad}  <span style={{ color: JSON_COLORS.key }}>{JSON.stringify(k)}</span>
            <span style={{ color: JSON_COLORS.punct }}>: </span>
            <JsonValue data={data[k]} indent={indent + 1} />
            {i < keys.length - 1 ? <span style={{ color: JSON_COLORS.punct }}>,</span> : null}
          </span>
        ))}
        <br />{pad}<span style={{ color: JSON_COLORS.punct }}>{'}'}</span>
      </span>
    );
  }
  return <span>{String(data)}</span>;
}

export function JsonBlock({ value }) {
  if (value === null || value === undefined || value === '') return <EmptyText />;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (_) { /* 保留原字符串 */ }
  }
  return (
    <pre
      style={{
        margin: 0, padding: '8px 10px', background: '#f6f8fa', borderRadius: 6,
        fontSize: 12, lineHeight: 1.6, maxHeight: 320, overflow: 'auto',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}
    >
      {typeof parsed === 'string' ? parsed : <JsonValue data={parsed} />}
    </pre>
  );
}

// ==================== HTTP 状态码 Tag（2xx绿 3xx蓝 4xx橙 5xx红） ====================
export function HttpStatusTag({ value }) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 100 || num > 599) return <EmptyText />;
  const color = num >= 500 ? 'red' : num >= 400 ? 'orange' : num >= 300 ? 'blue' : num >= 200 ? 'green' : 'default';
  return <Tag color={color}>{num}</Tag>;
}

// ==================== 耗时（彩色纯文本：正常绿、超阈值红，不用 Tag 避免堆叠） ====================
export function CostText({ value, unit = 'ms', slow = 350 }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return <EmptyText />;
  if (num < 0) return <span style={{ color: '#999', fontSize: 13 }}>未上报</span>;
  const isSlow = num > slow;
  return (
    <span style={{ color: isSlow ? '#ff4d4f' : '#52c41a', fontWeight: isSlow ? 600 : 400, fontSize: 13 }}>
      {num}{unit}
    </span>
  );
}

// ==================== 百分比进度 ====================
export function Percent({ value, suffix = '%', width = 60 }) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return <EmptyText />;
  return (
    <Space size={6}>
      <Progress percent={Math.min(num, 100)} size="small" style={{ width }} showInfo={false} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{num}{suffix}</Typography.Text>
    </Space>
  );
}

// ==================== 内存用量（已用/总量） ====================
export function MemBar({ used, total, suffix = 'MB' }) {
  const u = Number(used);
  const t = Number(total);
  if (!Number.isFinite(u) || u < 0) return <EmptyText />;
  const pct = Number.isFinite(t) && t > 0 ? Math.round((u / t) * 100) : 0;
  return (
    <Space size={6}>
      <Progress
        percent={pct}
        size="small"
        style={{ width: 60 }}
        showInfo={false}
        status={pct > 85 ? 'exception' : undefined}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {used}/{total} {suffix}
      </Typography.Text>
    </Space>
  );
}

// ==================== 等级（冲动程度等） ====================
export function LevelText({ value, labels, color = 'blue' }) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) {
    const s = toText(value);
    return s === '' ? <EmptyText /> : <Tag color={color}>{s}</Tag>;
  }
  const label = labels && labels[v] !== undefined ? labels[v] : String(v);
  return <Tag color={color}>{label}</Tag>;
}

// ==================== 星级评分 ====================
export function StarRate({ value, max = 5 }) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return <EmptyText />;
  return <Rate disabled count={max} value={num} style={{ fontSize: 14 }} />;
}

// ==================== 任务评分（满分10分 → 5星，评分/2，大号 + 品牌绿 #2ba471） ====================
export function ScoreRate({ value, onChange, disabled = false, size = 28, color = '#2ba471' }) {
  const num = Number(value);
  const v = Number.isFinite(num) && num > 0 ? num / 2 : 0;
  return (
    <Rate
      count={5}
      allowHalf
      value={v}
      onChange={(val) => onChange && onChange(val * 2)}
      disabled={disabled}
      style={{ fontSize: size, color }}
    />
  );
}

// ==================== 布尔状态 ====================
export function BoolTag({ value, yes = '是', no = '否' }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return <EmptyText />;
  return num === 1 ? <Tag color="success">{yes}</Tag> : <Tag>{no}</Tag>;
}

// ==================== 字符串列表 → 多个 Tag（兼容 JSON 数组 / 逗号分隔） ====================
// 每个 Tag 颜色按文本 hash 取统一色板（任务标签等无字典色值的业务文本）
export function SplitTags({ value, separator = ',' }) {
  const arr = parseImages(value);
  if (arr.length === 0) return <EmptyText />;
  return (
    <Space size={[0, 4]} wrap>
      {arr.map((t, i) => <Tag key={i} color={hashColorFor(t)}>{t}</Tag>)}
    </Space>
  );
}

// ==================== 图片列表（内置点击预览，不再跳新标签/下载） ====================
export function ImageList({ value, thumb = 44, max = 9 }) {
  const items = parseImages(value).slice(0, max).map(p => ({ url: toImageUrl(p), thumbUrl: toThumbUrl(p, 300) })).filter(x => x.url);
  if (items.length === 0) return <EmptyText />;
  const isSingle = items.length === 1;
  return (
    <Image.PreviewGroup>
      <Space size={4} wrap>
        {items.map((it, i) => (
          <Image
            key={i}
            src={it.thumbUrl}
            fallback={IMG_FALLBACK}
            width={isSingle ? thumb * 2 : thumb}
            height={isSingle ? thumb * 2 : thumb}
            style={{ objectFit: 'cover', borderRadius: 6, border: '1px solid #eee' }}
            preview={{ mask: false, src: it.url }}
          />
        ))}
      </Space>
    </Image.PreviewGroup>
  );
}

// ==================== 图片九宫格（3 列网格，列表单元格用） ====================
export function NineGridImages({ value, size = 56, max = 9 }) {
  const items = parseImages(value).slice(0, max).map(p => ({ url: toImageUrl(p), thumbUrl: toThumbUrl(p, 300) })).filter(x => x.url);
  if (items.length === 0) return <EmptyText />;
  return (
    <Image.PreviewGroup>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, width: size * 3 + 8 }}>
        {items.map((it, i) => (
          <Image
            key={i}
            src={it.thumbUrl}
            fallback={IMG_FALLBACK}
            width={size}
            height={size}
            style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #eee' }}
            preview={{ mask: false, src: it.url }}
          />
        ))}
      </div>
    </Image.PreviewGroup>
  );
}

// ==================== 空图片占位符（灰色虚线底图框 + 图片图标 +「暂无图片」，全后台统一标准） ====================
// 规范：所有图片展示（表格缩略图/详情大图）无图时一律渲染本占位符，禁止回退成「-」，
// 详见 docs/后端UI设计规范.md「空图片占位符」章节。
export function ImagePlaceholder({ size = 65, text = '暂无图片' }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: 6, border: '1px dashed #d9d9d9', background: '#fafafa',
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: '#bbb', fontSize: 11, lineHeight: 1.4,
      }}
    >
      <PictureOutlined style={{ fontSize: 18, marginBottom: 2 }} />
      <span>{text}</span>
    </div>
  );
}

// ==================== 表格图片缩略图（内置预览；无图自动渲染空图片占位符） ====================
export function TableImages({ value, size = 65, maxShow = 3 }) {
  const items = parseImages(value).map(p => ({ url: toImageUrl(p), thumbUrl: toThumbUrl(p, 300) })).filter(x => x.url);
  if (items.length === 0) return <ImagePlaceholder size={size} />;
  const shown = items.slice(0, maxShow);
  const more = items.length - shown.length;
  return (
    <Image.PreviewGroup>
      <Space size={4} wrap>
        {shown.map((it, i) => (
          <div key={i} style={{ position: 'relative', width: size, height: size, borderRadius: 6, overflow: 'hidden', border: '1px solid #eee', flexShrink: 0 }}>
            <Image
              src={it.thumbUrl}
              fallback={IMG_FALLBACK}
              width={size}
              height={size}
              style={{ objectFit: 'cover', display: 'block' }}
              preview={{ mask: false, src: it.url }}
            />
            {more > 0 && i === shown.length - 1 && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 600, pointerEvents: 'none' }}>
                +{more}
              </div>
            )}
          </div>
        ))}
      </Space>
      {/* 隐藏注册进 PreviewGroup，保证预览可查看全部图片 */}
      {items.slice(maxShow).map((it, i) => (
        <Image key={`more-${i}`} src={it.thumbUrl} fallback={IMG_FALLBACK} width={0} height={0} style={{ display: 'none' }} preview={{ mask: false, src: it.url }} />
      ))}
    </Image.PreviewGroup>
  );
}

// ==================== 统一封面缩略图（有图显示图，无图显示空占位符；URL 归一 + 加载失败回退占位） ====================
// 规范：封面类单图（合集封面等）一律用本组件，禁止混用 Avatar / 裸 Image，保证占位符样式统一
export function CoverThumb({ value, size = 64, text = '暂无图片' }) {
  const items = parseImages(value).map(p => ({ url: toImageUrl(p), thumbUrl: toThumbUrl(p, 300) })).filter(x => x.url);
  if (items.length === 0) return <ImagePlaceholder size={size} text={text} />;
  const it = items[0];
  return (
    <div style={{ width: size, height: size, borderRadius: 6, overflow: 'hidden', border: '1px solid #eee', flexShrink: 0, background: '#fafafa' }}>
      <Image src={it.thumbUrl} fallback={IMG_FALLBACK} width={size} height={size} style={{ objectFit: 'cover', display: 'block' }} preview={{ mask: false, src: it.url }} />
    </div>
  );
}

// ==================== 表格视频缩略（小尺寸播放按钮，详情抽屉内再完整播放） ====================
export function TableVideo({ value, size = 65 }) {
  const url = toImageUrl(value);
  if (!url) return <ImagePlaceholder size={size} />;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 6, background: '#1f1f1f', color: '#fff', textDecoration: 'none', fontSize: 18 }}
      title="点击新窗口播放视频"
    >
      ▶
    </a>
  );
}

// 记录是否为视频（按 content_type 前缀判断）
export function isVideoRecord(record) {
  return /^video\//i.test(String((record && record.content_type) || ''));
}

// ==================== 视频点击弹窗播放（内容安全等媒体预览用） ====================
// 点击 ▶ 缩略按钮弹出 Modal 内嵌 <video controls> 播放器，替代新窗口跳转
export function VideoPreviewButton({ value, size = 60, poster }) {
  const url = toImageUrl(value);
  const [open, setOpen] = useState(false);
  if (!url) return <ImagePlaceholder size={size} />;
  const posterUrl = poster ? toImageUrl(poster) : '';
  return (
    <>
      <div
        onClick={() => setOpen(true)}
        title="点击播放视频"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, borderRadius: 6, background: '#1f1f1f', color: '#fff',
          cursor: 'pointer', fontSize: size > 80 ? 30 : 18, flexShrink: 0,
        }}
      >
        ▶
      </div>
      <Modal
        title="视频预览"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={720}
        destroyOnClose
      >
        <video
          controls
          autoPlay
          src={url}
          poster={posterUrl || undefined}
          style={{ width: '100%', maxHeight: 500, background: '#000', borderRadius: 8 }}
        />
      </Modal>
    </>
  );
}

// ==================== 耗时（起止时间差：从入队到检测完成等） ====================
export function DurationText({ from, to }) {
  if (!from || !to) return <EmptyText />;
  const fromMs = dayjs(from).valueOf();
  const toMs = dayjs(to).valueOf();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return <EmptyText />;
  const ms = toMs - fromMs;
  if (ms < 1000) return <span style={{ fontSize: 13, color: '#52c41a', fontWeight: 500 }}>{ms}ms</span>;
  if (ms < 60000) return <span style={{ fontSize: 13, color: '#1677ff', fontWeight: 500 }}>{(ms / 1000).toFixed(1)}s</span>;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return <span style={{ fontSize: 13, color: '#722ed1', fontWeight: 500 }}>{m}分{s}秒</span>;
}

// ==================== 图片大图（详情抽屉用，内置预览；无图自动渲染空图片占位符） ====================
export function ImageGallery({ value }) {
  const items = parseImages(value).map(p => ({ url: toImageUrl(p), thumbUrl: toThumbUrl(p, 600) })).filter(x => x.url);
  if (items.length === 0) return <ImagePlaceholder size={120} />;
  return (
    <Image.PreviewGroup>
      <Space size={8} wrap>
        {items.map((it, i) => (
          <Image
            key={i}
            src={it.thumbUrl}
            fallback={IMG_FALLBACK}
            width={120}
            height={120}
            style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #eee' }}
            preview={{ mask: false, src: it.url }}
          />
        ))}
      </Space>
    </Image.PreviewGroup>
  );
}

// ==================== 图片上传（表单用：base64 直传云存储，最多 max 张，支持批量多选） ====================
// value/onChange 绑定 JSON 数组字符串（如 ["a.jpg"]，空为 '[]'），兼容逗号分隔的历史数据
// 支持一次选择多张（multiple），内部并发上传（限制 2 并发，避免大文件堆积），遵守 max 上限
// 注意：antd Upload 多选时 beforeUpload 对每个文件各调用一次，且 paths 是渲染闭包快照，
//       若直接闭包累加会互相覆盖。因此用 pathsRef 实时维护集合 + processingRef 批次防重入。
export function ImageUploader({ value, onChange, max = 9, biz = 'tasks', size = 96, square = false }) {
  const [uploading, setUploading] = useState(false);
  const paths = parseImages(value);
  const count = paths.length;

  // 实时路径集合（跟随外部 value，供异步上传回调读取最新值）
  const pathsRef = useRef(paths);
  useEffect(() => { pathsRef.current = parseImages(value); }, [value]);
  // 批次防重入：同一批多选文件仅处理一次
  const processingRef = useRef(false);

  /** 读取文件为 base64 dataURL */
  const readAsDataURL = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });

  /** 并发执行器：同时最多跑 limit 个任务 */
  const runPool = async (tasks, limit) => {
    const results = new Array(tasks.length);
    let idx = 0;
    const worker = async () => {
      while (idx < tasks.length) {
        const i = idx++;
        results[i] = await tasks[i]();
      }
    };
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
  };

  const beforeUpload = (file, fileList) => {
    // 本批正在处理时忽略重复回调（antd 多选会对每个文件触发一次）
    if (processingRef.current) return false;
    processingRef.current = true;

    const list = (Array.isArray(fileList) && fileList.length) ? fileList : [file];
    const remain = max - pathsRef.current.length;
    if (remain <= 0) {
      message.warning(`最多上传 ${max} 张图片`);
      processingRef.current = false;
      return false;
    }
    const picked = list.slice(0, remain);
    setUploading(true);
    (async () => {
      try {
        // 先全部读为 base64，再并发上传
        const dataUrls = await Promise.all(picked.map(f => readAsDataURL(f)));
        const results = await runPool(
          dataUrls.map(dataUrl => () => uploadApi.upload(biz, dataUrl)),
          2
        );
        const okPaths = results.map(r => r.data && r.data.path).filter(Boolean);
        if (okPaths.length === 0) {
          message.warning('上传失败，请重试');
        } else {
          const next = [...pathsRef.current, ...okPaths].slice(0, max);
          pathsRef.current = next;
          onChange(imagesToJson(next));
          message.success(`已上传 ${okPaths.length} 张图片`);
        }
      } catch (_) {
        // 错误已在拦截器提示
      } finally {
        processingRef.current = false;
        setUploading(false);
      }
    })();
    return false;
  };

  const removePath = (p) => {
    const next = paths.filter(x => x !== p);
    pathsRef.current = next;
    onChange(imagesToJson(next));
  };

  /** 正方形封面：用 ImgCrop 包裹 Upload，选择图片后弹出裁剪弹窗，确认后 beforeUpload 收到的是正方形图片 */
  const renderUpload = (child) => {
    const upload = (
      <Upload
        showUploadList={false}
        multiple={!square}
        beforeUpload={beforeUpload}
        accept="image/*"
        disabled={uploading}
      >
        {child}
      </Upload>
    );
    return square ? (
      <ImgCrop aspect={1} modalTitle="裁剪封面图（正方形）" showGrid>
        {upload}
      </ImgCrop>
    ) : upload;
  };

  const isSingle = max <= 1;
  const boxSize = size || 96;

  return (
    <div>
      <div style={isSingle ? { display: 'flex', flexWrap: 'wrap', gap: 8 } : { display: 'grid', gridTemplateColumns: 'repeat(3, 120px)', justifyContent: 'flex-start', gap: 8 }}>
        {paths.map((p) => {
          const url = toImageUrl(p);
          const thumbUrl = toThumbUrl(p, 300);
          return (
            <div key={p} style={{
              position: 'relative', borderRadius: 6, overflow: 'hidden', border: '1px solid #eee',
              ...(isSingle ? { width: boxSize, height: boxSize, flexShrink: 0 } : { width: '100%', aspectRatio: '1' }),
            }}>
              <Image
                src={thumbUrl}
                fallback={IMG_FALLBACK}
                width={isSingle ? boxSize : '100%'}
                height={isSingle ? boxSize : '100%'}
                style={{ objectFit: 'cover' }}
                preview={{ mask: false, src: url }}
              />
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                style={{ position: 'absolute', top: 0, right: 0, color: '#fff', background: 'rgba(0,0,0,0.45)', padding: 0, minWidth: 22, height: 22, borderRadius: '0 0 0 6px' }}
                onClick={() => removePath(p)}
              />
            </div>
          );
        })}
        {count < max && (
          isSingle ? (
            renderUpload(
              <div
                style={{
                  width: boxSize, height: boxSize, borderRadius: 6, border: '1px dashed #d9d9d9',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  cursor: uploading ? 'not-allowed' : 'pointer', background: '#fafafa', color: '#999', fontSize: 12,
                }}
              >
                {uploading ? <LoadingOutlined style={{ fontSize: 20 }} /> : <PlusOutlined style={{ fontSize: 20 }} />}
                <span style={{ marginTop: 2 }}>{uploading ? '上传中' : `${count}/${max}`}</span>
              </div>
            )
          ) : (
            <div style={{ position: 'relative', width: '100%', aspectRatio: '1' }}>
              {renderUpload(
                <div
                  style={{
                    position: 'absolute', inset: 0, borderRadius: 6, border: '1px dashed #d9d9d9',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    cursor: uploading ? 'not-allowed' : 'pointer', background: '#fafafa', color: '#999', fontSize: 12,
                  }}
                >
                  {uploading ? <LoadingOutlined style={{ fontSize: 20 }} /> : <PlusOutlined style={{ fontSize: 20 }} />}
                  <span style={{ marginTop: 2 }}>{uploading ? '上传中' : `${count}/${max}`}</span>
                </div>
              )}
            </div>
          )
        )}
      </div>
      <div style={{ color: '#bbb', fontSize: 12, marginTop: 4 }}>
        {max === 1 ? '只支持 1 张图片，可删除后重新上传' : `支持一次选择多张图片（最多 ${max} 张，九宫格展示）`}
      </div>
    </div>
  );
}

// ==================== 任务评分 Tag（满分10分，按分值区间着色） ====================
// 10 优秀绿 / 7-9 良好蓝 / 5-6 中等金 / 0-4 较差红
export function ScoreTag({ value }) {
  if (value === null || value === undefined || value === '') return <EmptyText />;
  const s = Number(value);
  if (Number.isNaN(s)) return <EmptyText />;
  let color = 'red';
  if (s >= 9) color = 'success';
  else if (s >= 7) color = 'geekblue';
  else if (s >= 5) color = 'gold';
  return <Tag color={color}>{s}分</Tag>;
}

// ==================== 任务派发学生多选（assignee） ====================
// 后台任务新增/编辑表单使用：加载学生角色员工（仅启用），可多选派发。
// disabled 用于「学生自建任务派发固定为本人，禁止派发」场景（值为当前登录学生本人）。
const assigneeCache = {}; // 已加载过的学生选项缓存（避免每次弹窗重复请求）
export function loadStudentOptions() {
  if (!assigneeCache.list) {
    assigneeCache.list = crudApi.list('staff', { page: 1, pageSize: 200, staff_role: 'student' })
      .then((res) => (res.data.list || [])
        .filter(s => Number(s.staff_status) === 1)
        .map(s => ({
          value: s.staff_id,
          label: s.staff_nickname ? `${s.staff_nickname}（${s.staff_username}）` : (s.staff_username || `#${s.staff_id}`),
          searchText: `${s.staff_nickname || ''} ${s.staff_username || ''} ${s.staff_id || ''}`,
        })))
      .catch(() => []);
  }
  return assigneeCache.list;
}
export function AssigneeSelect({ value, onChange, disabled }) {
  const [options, setOptions] = useState([]);
  useEffect(() => {
    let alive = true;
    loadStudentOptions().then((list) => { if (alive) setOptions(list); });
    return () => { alive = false; };
  }, []);
  return (
    <Select
      mode="multiple"
      style={{ width: '100%' }}
      placeholder="请选择派发的学生（可多选）"
      allowClear
      showSearch
      filterOption={(input, opt) => String(opt?.searchText || opt?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      optionFilterProp="label"
    />
  );
}

// ==================== 派发人员 Tag 展示（列表列 / 详情抽屉共用） ====================
export function AssigneeTags({ names, empty = '未派发' }) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean);
  if (list.length === 0) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <Space size={4} wrap>
      {list.map((n, i) => (
        <Tag key={`${n}-${i}`} color="purple" style={{ marginRight: 0 }}>{n}</Tag>
      ))}
    </Space>
  );
}

// ==================== 语音打卡播放器（<audio> 原生控件，云存储相对路径/完整 URL 均可） ====================
// duration 为可选显示时长（秒），value 为空时渲染空占位
export function AudioPlayer({ value, duration, style }) {
  const url = toImageUrl(value);
  if (!url) return <EmptyText />;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {Number(duration) > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{duration}秒</Typography.Text>
      )}
      <audio controls preload="metadata" src={url} style={{ maxWidth: 240, height: 36, verticalAlign: 'middle', ...style }} />
    </span>
  );
}

// ==================== 视频打卡播放器（<video> 原生控件，云存储相对路径/完整 URL 均可） ====================
// duration 为可选显示时长（秒），size 为压缩后大小（字节，可选展示节省效果），poster 为封面相对路径/URL
export function VideoPlayer({ value, duration, size, style, poster }) {
  const url = toImageUrl(value);
  if (!url) return <EmptyText />;
  const posterUrl = poster ? toImageUrl(poster) : '';
  const sizeText = Number(size) > 0
    ? (Number(size) >= 1024 * 1024 ? `${(Number(size) / 1024 / 1024).toFixed(1)}MB` : `${Math.round(Number(size) / 1024)}KB`)
    : '';
  return (
    <div style={{ maxWidth: 360, ...style }}>
      <video controls preload="metadata" src={url} poster={posterUrl || undefined} style={{ width: '100%', maxHeight: 240, borderRadius: 8, background: '#000' }} />
      {(Number(duration) > 0 || sizeText) && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {[duration > 0 ? `时长 ${duration} 秒` : '', sizeText ? `压缩后 ${sizeText}` : ''].filter(Boolean).join(' · ')}
        </Typography.Text>
      )}
    </div>
  );
}

// ==================== 详情字段渲染（按 detailFields 元数据） ====================
// f: { name, label, type, map, span, max, labels, color, suffix, totalField, ... }
// ==================== 内容安全：按媒体类型统一尺寸预览（图片缩略/音频播放/视频弹窗播放） ====================
// 图片/视频尺寸与「文件管理」模块详情一致（图片 120px 大图、视频播放器），列表用缩略尺寸
export function ContentMediaPreview({ record, size = 88, detailed = false }) {
  const mt = Number(record && record.media_type);
  const path = record && record.content;
  const url = toImageUrl(path);
  if (mt === 2) {
    if (!url) return <ImagePlaceholder size={size} />;
    const box = detailed ? 120 : size;
    return (
      <div style={{ width: box, height: box, borderRadius: 6, overflow: 'hidden', border: '1px solid #eee', background: '#fafafa', flexShrink: 0 }}>
        <Image src={toThumbUrl(path, 600) || url} fallback={IMG_FALLBACK} width={box} height={box} style={{ objectFit: 'cover', display: 'block' }} preview={{ mask: false, src: url }} />
      </div>
    );
  }
  if (mt === 3) return <AudioPlayer value={path} />;
  if (mt === 4) {
    if (!url) return <ImagePlaceholder size={size} />;
    if (detailed) return <VideoPlayer value={path} style={{ maxWidth: 360 }} />;
    return <VideoPreviewButton value={path} size={size} />;
  }
  return <LongText value={path} />;
}

// ==================== 文件大小（自动 B/KB/MB） ====================
export function SizeText({ value }) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return <EmptyText />;
  if (num >= 1024 * 1024) return <span style={{ fontSize: 13 }}>{(num / 1024 / 1024).toFixed(1)}MB</span>;
  if (num >= 1024) return <span style={{ fontSize: 13 }}>{Math.round(num / 1024)}KB</span>;
  return <span style={{ fontSize: 13 }}>{num}B</span>;
}

// ==================== 压缩比（节省百分比%，纯文本，值越高越绿） ====================
export function RatioText({ value, orig, comp }) {
  const o = Number(orig);
  const c = Number(comp);
  let ratio = Number(value);
  // 兼容未回填压缩字段的历史数据：由 orig/comp 现算
  if (o > 0 && c > 0) {
    const calc = ((1 - c / o) * 100);
    if (!Number.isFinite(ratio) || ratio <= 0) ratio = calc;
  }
  if (!Number.isFinite(ratio) || ratio <= 0) return <EmptyText />;
  const pct = Math.min(ratio, 100);
  const color = pct >= 60 ? '#52c41a' : pct >= 30 ? '#faad14' : '#999';
  return <span style={{ color, fontSize: 13, fontWeight: 600 }}>{pct.toFixed(0)}%</span>;
}

// ==================== 详情字段统一渲染 ====================
export function renderDetailValue(f, record) {
  const v = record[f.name];
  switch (f.type) {
    case 'avatar': return <EmojiAvatar value={v} size="large" />;
    case 'staffCell': return <StaffCell staffId={v} username={record._creatorUsername} nickname={record._creatorNickname} />;
    case 'imageAvatar': return <ImageAvatar avatar={v} nickname={record.nickname || record._userNickname} size={45} />;
    case 'userCell': return <UserCell userId={record._userId} nickname={record._userNickname} avatar={record._userAvatar} avatarChar={record._userAvatarChar} />;
    case 'color': return <ColorDot value={v} />;
    case 'json': return <JsonBlock value={v} />;
    case 'date': return fmtDateTime(v);
    case 'dateOnly': return fmtDateOnly(v);
    case 'tag': return <StatusTag value={v} map={f.map} />;
    case 'dictTag': return <DictTag code={f.dict} value={v} />;
    case 'tags': return <SplitTags value={v} />;
    case 'assignees': return <AssigneeTags names={v} />;
    case 'images': return <ImageGallery value={v} />;
    case 'media': return isVideoRecord(record) ? <VideoPlayer value={v} /> : <ImageGallery value={v} />;
    case 'mediaPreview': return <ContentMediaPreview record={record} detailed />;
    case 'audio': return <AudioPlayer value={v} duration={record[f.durationField]} />;
    case 'video': return <VideoPlayer value={v} duration={record[f.durationField]} size={record[f.sizeField]} poster={record[f.coverField]} />;
    case 'progress': return <Percent value={v} suffix={f.suffix || '%'} />;
    case 'duration': return <DurationText from={record[f.from]} to={record[f.to]} />;
    case 'mem': return <MemBar used={v} total={record[f.totalField]} />;
    case 'rate': return <StarRate value={v} max={f.max || 5} />;
    case 'level': return <LevelText value={v} labels={f.labels} color={f.color} />;
    case 'bool': return <BoolTag value={v} yes={f.yes} no={f.no} />;
    case 'longText': return <LongText value={v} />;
    case 'linkText': return <LinkText value={v} />;
    case 'id': return <MaskId value={v} maxWidth={500} />;
    case 'cost': return <CostText value={v} slow={f.slow} />;
    case 'httpStatus': return <HttpStatusTag value={v} />;
    case 'score': return <ScoreTag value={v} />;
    case 'scoreRate': return <ScoreRate value={v} disabled />;
    case 'size': return <SizeText value={v} />;
    case 'ratio': return <RatioText value={v} orig={record.file_size_orig} comp={record.file_size_compressed || record.file_size} />;
    case 'number': {
      const s = toText(v);
      return s === '' ? <EmptyText /> : <span>{s}</span>;
    }
    // 默认：普通文本完整展示，内容长自动换行（不省略）
    default: return <LongText value={v} />;
  }
}

