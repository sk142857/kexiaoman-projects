/**
 * 课小满 - 隐私接口失败兜底
 *
 * 隐私相关接口（chooseMedia / chooseAvatar / 录音等）在用户未同意《用户隐私保护指引》时，
 * 会走微信官方隐私弹窗；用户拒绝后接口 fail（errno 103/104），若接口未在指引中声明则 fail（errno 112）。
 * 此前的自定义 onNeedPrivacyAuthorization 处理会静默吞掉这些失败，导致「弹窗后无响应」。
 * 这里统一把失败转成用户可读提示；用户主动取消选择（errMsg 含 cancel/cancle）不算错误，静默忽略。
 */

/** 是否为用户主动取消（微信历史 errMsg 存在 cancel / cancle 两种拼写） */
function isCancel(err) {
  const msg = String((err && err.errMsg) || '').toLowerCase();
  return msg.indexOf('cancel') >= 0 || msg.indexOf('cancle') >= 0;
}

/** 失败信息 → 用户可读提示（非隐私错误回退 fallback / 原始 errMsg） */
function failMessage(err, fallback) {
  const errno = Number(err && err.errno);
  // 103 用户拒绝官方隐私授权弹窗 / 104 用户未同意隐私协议调用
  if (errno === 103 || errno === 104) return '需同意隐私协议后才能继续';
  // 112 使用的隐私接口未在《用户隐私保护指引》中声明
  if (errno === 112) return '该功能未在隐私协议中声明，请联系管理员';
  const msg = String((err && err.errMsg) || '');
  if (msg.indexOf('privacy') >= 0 || msg.indexOf('隐私') >= 0) return '需同意隐私协议后才能继续';
  return fallback || msg || '操作失败';
}

module.exports = { isCancel, failMessage };
