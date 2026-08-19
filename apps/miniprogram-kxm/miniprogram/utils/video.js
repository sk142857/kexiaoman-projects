/**
 * 课小满 - 视频工具（选择 + 本地压缩 + 直传云存储 + 登记）
 *
 * 打卡视频 ≤1GB：选片后先本地 wx.compressVideo 压缩（medium），再
 * wx.cloud.uploadFile 直传云存储（绕过 callContainer 请求体 100KB 限制），
 * 最后调 /api/storage/upload 登记 t_file_uploads（biz=videos，路径 kxm/videos/{date}/{id}.mp4）。
 * 后端在打卡创建后对视频做 ffmpeg 二次压缩（720p CRF28）节省空间，压缩完成前
 * video_url 为原始路径，压缩完成后自动回写为压缩后路径。
 * 返回/存储：云存储「相对路径」（如 kxm/videos/2026-08-19/xxx.mp4），
 * 展示时用 utils/image.js 的 fileUrl() 拼完整域名。
 */
const CLOUD_ENV = 'cloud1-d6gddqzrsda16338f';
const CLOUD_SERVICE = 'kxm-service';
// 视频大小上限：1GB（与后端 storage.js VIDEO_MAX_SIZE 一致）
const MAX_SIZE = 1024 * 1024 * 1024;

/** 日期目录 yyyy-MM-dd */
function todayDir() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 文件 ID（时间戳 + 随机串） */
function genFileId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 字节 → 可读体积文案（MB/GB） */
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 读取本地文件大小（失败返回 0） */
function getFileSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileInfo({
      filePath,
      success: (res) => resolve(Number(res.size) || 0),
      fail: () => resolve(0),
    });
  });
}

/** 本地压缩视频（medium，兼顾体积与清晰度；失败回退原视频） */
function compressLocal(src) {
  return new Promise((resolve) => {
    wx.compressVideo({
      src,
      quality: 'medium',
      success: (res) => resolve(res.tempFilePath || src),
      fail: (err) => {
        console.warn('[video] 本地压缩失败，使用原视频', (err && err.errMsg) || err);
        resolve(src);
      },
    });
  });
}

/**
 * 选择并本地压缩一个视频：校验 ≤1GB，返回本地临时文件
 * @returns {Promise<{ tempFilePath, duration, size } | null>} 取消选择返回 null
 */
function chooseVideo() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const item = (res.tempFiles || [])[0];
        if (!item) return resolve(null);
        const size = Number(item.size) || 0;
        if (size > MAX_SIZE) {
          wx.showToast({ title: '视频不能超过 1GB', icon: 'none' });
          reject(new Error('视频超过 1GB'));
          return;
        }
        const duration = Math.max(1, Math.round(Number(item.duration) || 0));
        try {
          const compressed = await compressLocal(item.tempFilePath);
          const csize = await getFileSize(compressed);
          if (csize > MAX_SIZE) {
            wx.showToast({ title: '视频不能超过 1GB', icon: 'none' });
            reject(new Error('视频超过 1GB'));
            return;
          }
          resolve({ tempFilePath: compressed, duration, size: csize || size });
        } catch (_) {
          resolve({ tempFilePath: item.tempFilePath, duration, size });
        }
      },
      fail: () => resolve(null),
    });
  });
}

/**
 * 直传云存储 + 登记 file_uploads（biz=videos）
 * @returns {Promise<{ path, duration }>} path 为云存储相对路径
 */
function uploadVideo(tempFilePath, duration, size) {
  return new Promise((resolve, reject) => {
    if (!tempFilePath) return reject(new Error('视频文件不存在'));
    const cloudPath = `kxm/videos/${todayDir()}/${genFileId()}.mp4`;
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
            biz: 'videos',
            images: [{
              path: cloudPath,
              fileID,
              size: Number(size) || 0,
              contentType: 'video/mp4',
              name: cloudPath.split('/').pop(),
            }],
          },
          header: { 'X-WX-SERVICE': CLOUD_SERVICE },
          success: (regRes) => {
            const body = (regRes && regRes.data) || {};
            if (body.code === 0) {
              resolve({ path: cloudPath, duration: Math.max(1, Math.min(3600, Math.round(Number(duration) || 0))) });
            } else {
              reject({ code: body.code, msg: body.msg || '视频登记失败' });
            }
          },
          fail: () => reject({ code: -1, msg: '视频登记失败，请重试' }),
        });
      },
      fail: (err) => reject({ code: -1, msg: (err && err.errMsg) || '视频上传失败' }),
    });
  });
}

module.exports = { chooseVideo, uploadVideo, formatSize, MAX_SIZE };
