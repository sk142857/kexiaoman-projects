/**
 * 课小满 - 图片工具（选原图 + 直传云存储 + 登记）
 *
 * ⚠️ wx.cloud.callContainer 请求体限制 100KB（错误码 -606001），base64 传图必然超限失败，
 * 因此与视频/语音一致改为直传：wx.chooseMedia 选原图 → wx.cloud.uploadFile 直传云存储
 * （kxm/{biz}/{date}/{id}.{ext}）→ /api/storage/upload 登记 file_uploads，全程不经
 * callContainer 传输图片二进制。压缩统一由后端异步完成（compressImageAsync，与视频一致）。
 * 返回/存储：云存储「相对路径」（如 kxm/tasks/2026-08-13/xxx.jpg），
 * 展示时必须拼上云存储公开访问域名前缀（fileUrl），否则 <image> 无法加载。
 */
const CLOUD_ENV = 'cloud1-d6gddqzrsda16338f';
const CLOUD_SERVICE = 'kxm-service';

// 云存储公开访问域名（与 shared/backend/storage.js 的 STORAGE_DOMAIN 保持一致）
const STORAGE_DOMAIN = 'https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la';

/** 相对路径 → 完整 URL（已是 http(s) 的原样返回） */
function fileUrl(p) {
  if (!p) return '';
  const s = String(p);
  if (/^https?:\/\//i.test(s)) return s;
  return `${STORAGE_DOMAIN}/${s.replace(/^\/+/, '')}`;
}

/** 完整 URL → 预览图 URL（数据万象图片处理：限定宽高最大值等比缩放 + 压缩，避免原图大流量）
 * 仅内部存储域名追加处理参数，外部 URL（如微信头像）原样返回 */
function previewUrl(p, size = 1080) {
  const url = fileUrl(p);
  if (!url || !url.startsWith(STORAGE_DOMAIN)) return url;
  const n = Number(size) > 0 ? Number(size) : 1080;
  return `${url}?imageMogr2/thumbnail/${n}x${n}`;
}

/** 完整 URL → 相对路径（提交/入库用；非本域名 URL 原样返回） */
function relPath(url) {
  if (!url) return '';
  const s = String(url);
  return s.startsWith(STORAGE_DOMAIN + '/') ? s.slice(STORAGE_DOMAIN.length + 1) : s;
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

/**
 * 上传一张图片到云存储并登记 file_uploads，返回相对路径
 * @param {string} tempFilePath 本地临时文件路径（原图直传，压缩由后端异步完成）
 * @param {string} biz 业务类型（tasks/avatar）
 * @returns {Promise<string>} 云存储相对路径
 */
function uploadImageFile(tempFilePath, biz) {
  return new Promise((resolve, reject) => {
    if (!tempFilePath) return reject(new Error('图片文件不存在'));
    const extMatch = String(tempFilePath).match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const isPng = ext === 'png';
    const cloudPath = `kxm/${biz}/${todayDir()}/${genFileId()}.${ext}`;
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
            biz,
            images: [{
              path: cloudPath,
              fileID,
              size: 0,
              contentType: isPng ? 'image/png' : 'image/jpeg',
              name: cloudPath.split('/').pop(),
            }],
          },
          header: { 'X-WX-SERVICE': CLOUD_SERVICE },
          success: (regRes) => {
            const body = (regRes && regRes.data) || {};
            if (body.code === 0) {
              resolve(cloudPath);
            } else {
              reject({ code: body.code, msg: body.msg || '图片登记失败' });
            }
          },
          fail: () => reject({ code: -1, msg: '图片登记失败，请重试' }),
        });
      },
      fail: (err) => reject({ code: -1, msg: (err && err.errMsg) || '图片上传失败' }),
    });
  });
}

/**
 * 选择并批量上传图片（返回相对路径数组）
 * @param {number} max 最多张数
 * @param {string} biz 业务类型（tasks/avatar）
 * @param {string[]} existing 已选图片相对路径（用于计算剩余可加张数）
 */
function chooseAndUploadImages(max = 9, biz = 'tasks', existing = []) {
  const remain = Math.max(0, max - existing.length);
  if (remain <= 0) {
    wx.showToast({ title: `最多 ${max} 张`, icon: 'none' });
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['original'], // 选原图，压缩统一由后端异步完成
      success: async (res) => {
        const items = res.tempFiles || [];
        try {
          const paths = [];
          for (const it of items) {
            paths.push(await uploadImageFile(it.tempFilePath, biz));
          }
          resolve(paths);
        } catch (e) {
          wx.showToast({ title: e.msg || '上传失败', icon: 'none' });
          reject(e);
        }
      },
      fail: () => resolve([]),
    });
  });
}

module.exports = { uploadImageFile, chooseAndUploadImages, fileUrl, previewUrl, relPath, STORAGE_DOMAIN };
