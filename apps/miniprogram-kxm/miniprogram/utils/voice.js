/**
 * 课小满 - 语音工具（录音 + 直传云存储 + 登记）
 *
 * 录音：wx.getRecorderManager（mp3，≤60s）
 * 上传：wx.cloud.uploadFile 直传云存储（绕过 callContainer 请求体限制），
 *       再调 /api/storage/upload 登记 t_file_uploads（biz=voice，路径 kxm/voice/{date}/{id}.mp3）
 * 返回/存储：云存储「相对路径」（如 kxm/voice/2026-08-16/xxx.mp3），
 *           展示时用 utils/image.js 的 fileUrl() 拼完整域名。
 */
const CLOUD_ENV = 'cloud1-d6gddqzrsda16338f';
const CLOUD_SERVICE = 'kxm-service';

let recorder = null;
/** 惰性单例录音器 */
function getRecorder() {
  if (!recorder) recorder = wx.getRecorderManager();
  return recorder;
}

/** 日期目录 yyyy-MM-dd */
function todayDir() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 文件 ID（时间戳 + 随机串） */
function genFileId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 开始录音（mp3，最长 60s） */
function start() {
  getRecorder().start({
    duration: 60000,
    format: 'mp3',
    sampleRate: 16000,
    encodeBitRate: 24000,
  });
}

/** 停止录音（onStop 回调里拿 tempFilePath + duration(ms)） */
function stop() {
  getRecorder().stop();
}

function onStart(cb) { getRecorder().onStart(cb); }
function onStop(cb) { getRecorder().onStop(cb); }
function onError(cb) { getRecorder().onError(cb); }
function onTimeUpdate(cb) { getRecorder().onTimeUpdate(cb); }

/** 取消录音（丢弃本次录音） */
function cancel() {
  getRecorder().stop();
}

/**
 * 上传本地音频文件到云存储并登记，返回 { path, duration }
 * @param {string} tempFilePath 录音临时文件路径
 * @param {number} durationMs 录音时长（毫秒）
 * @returns {Promise<{ path: string, duration: number }>}
 */
function uploadVoice(tempFilePath, durationMs) {
  return new Promise((resolve, reject) => {
    if (!tempFilePath) return reject(new Error('语音文件不存在'));
    const extMatch = String(tempFilePath).match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'mp3';
    const cloudPath = `kxm/voice/${todayDir()}/${genFileId()}.${ext}`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success: (res) => {
        const fileID = (res && res.fileID) || '';
        // 登记 t_file_uploads（/api/storage/upload，X-WX-OPENID 由云托管网关自动注入）
        wx.cloud.callContainer({
          config: { env: CLOUD_ENV },
          path: '/api/storage/upload',
          method: 'POST',
          data: {
            biz: 'voice',
            images: [{ path: cloudPath, fileID, size: 0, contentType: 'audio/mpeg' }],
          },
          header: { 'X-WX-SERVICE': CLOUD_SERVICE },
          success: (regRes) => {
            const body = (regRes && regRes.data) || {};
            if (body.code === 0) {
              const sec = Math.max(1, Math.min(60, Math.round((Number(durationMs) || 0) / 1000)));
              resolve({ path: cloudPath, duration: sec });
            } else {
              reject({ code: body.code, msg: body.msg || '语音登记失败' });
            }
          },
          fail: () => reject({ code: -1, msg: '语音登记失败，请重试' }),
        });
      },
      fail: (err) => reject({ code: -1, msg: (err && err.errMsg) || '语音上传失败' }),
    });
  });
}

module.exports = {
  start, stop, cancel,
  onStart, onStop, onError, onTimeUpdate,
  uploadVoice,
};
