/**
 * 课小满 - 图片工具（选原图 + base64，经 /api/lp/upload 上传）
 *
 * 前端默认选择原图，压缩统一由后端完成（shared/backend/storage.js 的 compressImage）。
 * 后端返回/存储的是云存储「相对路径」（如 kxm/tasks/2026-08-13/xxx.jpg），
 * 展示时必须拼上云存储公开访问域名前缀，否则 <image> 无法加载。
 */
const fs = wx.getFileSystemManager ? wx.getFileSystemManager() : null;

// 云存储公开访问域名（与 shared/backend/storage.js 的 STORAGE_DOMAIN 保持一致）
const STORAGE_DOMAIN = 'https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la';

/** 相对路径 → 完整 URL（已是 http(s) 的原样返回） */
function fileUrl(p) {
  if (!p) return '';
  const s = String(p);
  if (/^https?:\/\//i.test(s)) return s;
  return `${STORAGE_DOMAIN}/${s.replace(/^\/+/, '')}`;
}

/** 完整 URL → 相对路径（提交/入库用；非本域名 URL 原样返回） */
function relPath(url) {
  if (!url) return '';
  const s = String(url);
  return s.startsWith(STORAGE_DOMAIN + '/') ? s.slice(STORAGE_DOMAIN.length + 1) : s;
}

/** 本地文件 → base64（去 data: 前缀） */
function fileToBase64(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs) return reject(new Error('fs 不可用'));
    fs.readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data || ''),
      fail: () => reject(new Error('读取图片失败')),
    });
  });
}

/**
 * 选择并批量上传图片（返回相对路径数组）
 * @param {number} max 最多张数
 * @param {string} biz 业务类型（tasks）
 * @param {string[]} existing 已选图片相对路径（用于计算剩余可加张数）
 */
function chooseAndUploadImages(max = 9, biz = 'tasks', existing = []) {
  const { lp } = require('./api');
  const remain = Math.max(0, max - existing.length);
  if (remain <= 0) {
    wx.showToast({ title: `最多 ${max} 张`, icon: 'none' });
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['original'], // 默认选原图，压缩统一由后端完成
      success: async (res) => {
        const items = res.tempFiles || [];
        try {
          const paths = [];
          for (const it of items) {
            const b64 = await fileToBase64(it.tempFilePath);
            // 逐张上传：避免单次请求体过大（后端并发上限 3）
            const up = await lp.upload(biz, [{ data: b64, contentType: 'image/jpeg', fileName: it.tempFilePath.split('/').pop() || '' }]);
            paths.push(...((up.files || []).map(f => f.path)));
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

module.exports = { fileToBase64, chooseAndUploadImages, fileUrl, relPath, STORAGE_DOMAIN };
