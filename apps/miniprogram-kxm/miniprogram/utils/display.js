// utils/display.js
// 内容安全展示级别映射（前端只渲染、不做安全判断）
// 后端 mergeAudit 在「内容安全开启」时给每条记录附带 display 字段：
//   audit_reviewing（检测中，内容可见 + 角标） / audit_rejected（命中违规，字段已脱敏 + 角标）
// 安全关闭 / 未接入 / 检测失败时该字段缺失 → 本模块全部返回空，前端走旧逻辑，零影响。

const SEC_THEME = {
  audit_reviewing: { text: '安全检测中', color: '#e37318', bg: '#fdf1e4', tagTheme: 'warning' },
  audit_rejected: { text: '部分内容未通过审核', color: '#f6685d', bg: '#fdeeed', tagTheme: 'danger' },
};

/** 取安全展示态（无 display 或未知值返回 ''） */
function secState(record) {
  const d = record && record.display;
  return d && SEC_THEME[d] ? d : '';
}

/** 角标文案（无则空串） */
function secBadgeText(record) {
  const d = secState(record);
  return d ? SEC_THEME[d].text : '';
}

/** 角标完整元数据（text/color/bg/tagTheme；无则 null） */
function secBadgeMeta(record) {
  const d = secState(record);
  return d ? SEC_THEME[d] : null;
}

module.exports = { SEC_THEME, secState, secBadgeText, secBadgeMeta };
