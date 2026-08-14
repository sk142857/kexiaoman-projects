/**
 * 云存储上传模块（@cloudbase/js-sdk）
 *
 * 存储桶：636c-cloud1-d6gddqzrsda16338f-1467751604（环境内置传统模式云存储）
 * 所有图片根路径：kxm（共享存储根目录，课小满业务按子目录区分）
 * 按业务分目录：kxm/{biz}/yyyy-mm-dd/{fileId}.jpg 等（如 kxm/tasks/...）
 * 图片公开访问域名：https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la
 * 前端/后台拼接完整域名使用：https://{domain}/{相对路径}
 *
 * AI-SKIP: 请勿删除 package.json 中的 "ws" 依赖（rdb() WebSocket 需要）。
 */
const sharp = require("sharp");
const { app } = require("./db");
const { genId, nowSql } = require("./utils");

// 存储桶名称（环境内置 COS 桶）
const STORAGE_BUCKET = "636c-cloud1-d6gddqzrsda16338f-1467751604";
// 图片公开访问域名
const STORAGE_DOMAIN = "https://636c-cloud1-d6gddqzrsda16338f-1467751604.tcb.qcloud.la";
// 所有图片根路径
const STORAGE_ROOT = "kxm";
// 允许的业务类型（防任意路径上传）
const BIZ_WHITELIST = ["avatar", "events", "tasks"];
// 图片压缩默认参数：长边超过该值才缩放；质量用于 jpeg 输出
const DEFAULT_MAX_EDGE = 1080;
const DEFAULT_QUALITY = 80;

/**
 * 内存压缩图片（原图不落盘，只存压缩产物）
 * - 仅当长边超过 maxEdge 才缩放，否则保持原尺寸
 * - 去 EXIF 元数据（省体积 + 防隐私泄露）
 * - PNG 保留原格式（透明通道），其余统一转 JPEG
 * - 失败兜底：返回原 buffer，不阻断上传
 */
async function compressImage(buffer, { maxEdge = DEFAULT_MAX_EDGE, quality = DEFAULT_QUALITY, contentType = "image/jpeg" } = {}) {
  if (!buffer || buffer.length === 0) return { buffer, contentType };
  try {
    const meta = await sharp(buffer).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    const isPng = /png/i.test(contentType || "");
    let pipeline = sharp(buffer).rotate();
    if (longEdge > maxEdge) {
      pipeline = pipeline.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true });
    }
    if (isPng) {
      const out = await pipeline.png().toBuffer();
      return { buffer: out, contentType: "image/png" };
    }
    const out = await pipeline.jpeg({ quality }).toBuffer();
    return { buffer: out, contentType: "image/jpeg" };
  } catch (e) {
    console.error("[storage] compressImage 失败，回退原图", e.message);
    return { buffer, contentType };
  }
}

/** 相对路径 → 完整 URL */
function publicUrl(relativePath) {
  if (!relativePath) return "";
  const p = String(relativePath).replace(/^\/+/, "");
  return `${STORAGE_DOMAIN}/${p}`;
}

/** 校验业务类型 */
function isBizAllowed(biz) {
  return BIZ_WHITELIST.includes(biz);
}

/**
 * 压缩比（节省百分比）—— 由原大小/压缩后大小计算，单位 %
 * - orig/compressed 缺失或为 0 时返回 0（表示无压缩或数据未知）
 */
function ratioText(file = {}) {
  const orig = Number(file.origSize) || 0;
  const comp = Number(file.compressedSize) || Number(file.size) || 0;
  if (orig <= 0 || comp <= 0 || comp >= orig) return 0;
  return Number(((1 - comp / orig) * 100).toFixed(1));
}

/**
 * 上传一张图片到云存储（先内存压缩，原图不落盘）
 * @param {object} opts
 *  - biz: 业务类型（avatar/events/tasks）
 *  - date: 日期目录 yyyy-MM-dd（可选）
 *  - buffer: Buffer
 *  - contentType: MIME，如 image/jpeg
 *  - fileName: 原始文件名（可选）
 *  - compress: 是否压缩，默认 true
 *  - maxEdge / quality: 覆盖默认压缩参数
 * @returns {{ path, url, fileId }} 相对路径 / 完整URL / fileID
 */
async function uploadImage({ biz, date, buffer, contentType = "image/jpeg", fileName = "", compress = true, maxEdge, quality }) {
  if (!isBizAllowed(biz)) throw new Error("非法的业务类型");
  if (!buffer || buffer.length === 0) throw new Error("图片内容为空");
  if (buffer.length > 5 * 1024 * 1024) throw new Error("单张图片不能超过 5MB");

  // 原图大小（压缩前），用于记录压缩对比
  const origSize = buffer.length;
  if (compress) {
    const result = await compressImage(buffer, { maxEdge, quality, contentType });
    buffer = result.buffer;
    contentType = result.contentType;
  }
  const compressedSize = buffer.length;

  const ext = /png/i.test(contentType) ? "png" : "jpg";
  const dateDir = date || new Date().toISOString().slice(0, 10);
  const fileId = genId();
  // 相对路径（域名拼接用）
  const relPath = `${STORAGE_ROOT}/${biz}/${dateDir}/${fileId}.${ext}`;

  // 传统模式云存储：app.storage.from() 上传到环境默认桶（即 STORAGE_BUCKET）
  const storage = app.storage.from();
  const { data, error } = await storage.upload(relPath, buffer, { contentType });
  if (error) throw error;

  const cosId = (data && (data.id || data.fileID)) || "";
  return {
    path: relPath,
    url: publicUrl(relPath),
    fileId: fileId,
    cosId,
    size: compressedSize,
    origSize,
    compressedSize,
    contentType,
  };
}

/**
 * 记录一条文件上传记录（file_uploads 表）
 * - openid：小程序用户；staffId：后台登录员工（后台上传归属当前登录员工）
 * 失败仅打日志，不影响上传主流程
 */
async function logUpload({ openid, biz, bizId = "", file, fileStatus = "active", staffId = "" }) {
  try {
    const { db } = require("./db");
    const row = {
      file_id: file.fileId,
      openid: openid || "",
      biz: biz || "",
      biz_id: String(bizId || ""),
      file_name: String(file.fileName || "").slice(0, 255),
      file_path: file.path || "",
      file_url: file.url || "",
      file_cos_id: file.cosId || "",
      file_size: file.size || 0,
      file_size_orig: file.origSize || 0,
      file_size_compressed: file.compressedSize || file.size || 0,
      file_size_ratio: ratioText(file),
      content_type: file.contentType || "",
      file_status: fileStatus,
      created_at: nowSql(),
    };
    if (staffId) row.staff_id = String(staffId);
    try {
      await db.from("file_uploads").insert(row);
    } catch (e2) {
      // 兼容旧表结构（staff_id / 压缩字段列未迁移）：去掉对应字段重试，保证上传记录仍能入库
      const stripFields = (keys) => keys.forEach(k => { delete row[k]; });
      if (staffId || row.file_size_orig !== undefined) {
        if (staffId) stripFields(["staff_id"]);
        if (row.file_size_orig !== undefined) stripFields(["file_size_orig", "file_size_compressed", "file_size_ratio"]);
        try {
          await db.from("file_uploads").insert(row);
        } catch (e3) {
          throw e3;
        }
      } else {
        throw e2;
      }
    }
  } catch (e) {
    console.error("[storage] file_uploads 入库失败", e.message);
  }
}

/** 按相对路径回填业务 ID（打卡创建成功后关联）—— 一次 IN 批量更新，减少往返 */
async function bindBizId({ openid, paths = [], bizId }) {
  if (!bizId || !paths || paths.length === 0) return;
  try {
    const { db } = require("./db");
    await db.from("file_uploads")
      .update({ biz_id: String(bizId) })
      .eq("openid", openid || "")
      .in("file_path", paths);
  } catch (e) {
    console.error("[storage] bindBizId 失败", e.message);
  }
}

/** 将图片上传记录标记为已删除（打卡删除/图片移除时审计留痕，不物理删除存储）—— 一次 IN 批量更新 */
async function markRemoved({ openid, paths = [] }) {
  if (!paths || paths.length === 0) return;
  try {
    const { db } = require("./db");
    await db.from("file_uploads")
      .update({ file_status: "removed" })
      .eq("openid", openid || "")
      .in("file_path", paths);
  } catch (e) {
    console.error("[storage] markRemoved 失败", e.message);
  }
}

/**
 * 复制任务/打卡时处理「共用图片」：若提交的图片路径已归属其他业务（任务），
 * 说明是复制时沿用了原任务的图片路径，需物理复制一份新文件归当前业务所有（完全复制），
 * 保证原任务删除时不会级联删掉副本的图片。返回替换后的路径数组（新路径/原路径）。
 * - 归属判断：file_uploads.biz_id 非空且不等于当前 targetBizId → 视为共用
 * - 复制方式：优先云存储服务端 copy（原样字节），失败回退「下载原图再上传新路径」
 */
async function dupSharedImages({ openid = "", staffId = "", paths = [], targetBizId, biz = "tasks", date }) {
  if (!targetBizId || !paths || paths.length === 0) return paths || [];
  const { db } = require("./db");
  const out = [];
  for (const p of paths) {
    let finalPath = p;
    try {
      const { data } = await db.from("file_uploads")
        .select("biz_id, content_type").eq("file_path", p).limit(1);
      const row = data && data[0];
      if (row && row.biz_id && String(row.biz_id) !== String(targetBizId)) {
        finalPath = await copyImageNew({ openid, staffId, srcPath: p, contentType: row.content_type || "image/jpeg", biz, targetBizId, date });
      }
    } catch (e) {
      console.error("[storage] dupSharedImages 检查失败，保留原路径", p, e.message);
    }
    out.push(finalPath);
  }
  return out;
}

/** 物理复制一张图片到新路径（新 fileId），并登记 file_uploads（biz_id 绑定目标业务）
 * 目录按新业务（任务）的当前日期生成（date 参数可显式指定），不再沿用源路径日期，
 * 与「用户新上传」行为一致：kxm/{biz}/{yyyy-MM-dd}/{newFileId}.{ext}
 */
async function copyImageNew({ openid, staffId, srcPath, contentType, biz, targetBizId, date }) {
  const src = String(srcPath || "").replace(/^\/+/, "");
  const fileId = genId();
  const dateDir = date || new Date().toISOString().slice(0, 10);
  const ext = /png/i.test(contentType) ? "png" : "jpg";
  const newPath = `${STORAGE_ROOT}/${biz}/${dateDir}/${fileId}.${ext}`;
  try {
    const storage = app.storage.from();
    storage.bucketId = STORAGE_BUCKET;
    const { error } = await storage.copy(src, newPath);
    if (error) throw error;
  } catch (e) {
    // 回退：下载原图再上传到新路径
    const resp = await fetch(publicUrl(src));
    if (!resp.ok) throw new Error(`下载原图失败 HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const storage = app.storage.from();
    const { data, error: upErr } = await storage.upload(newPath, buffer, { contentType });
    if (upErr) throw upErr;
  }
  const fileObj = {
    path: newPath, url: publicUrl(newPath), fileId, cosId: "",
    size: 0, origSize: 0, compressedSize: 0, contentType,
  };
  await logUpload({ openid, staffId, biz, bizId: String(targetBizId), file: fileObj });
  return newPath;
}

/**
 * 从腾讯云存储物理删除一组文件（传统模式云存储，app.storage.from().remove）
 * - 返回成功删除与失败的路径列表，调用方可据此同步清理 file_uploads 登记记录
 * - ClassicStorageFileApi.remove 返回 { data, error } 而非抛错，且内部会先 info() 探测
 *   文件存在性（任一文件缺失会整批失败），因此整批失败后逐条重试定位真正失败的文件
 * @param {string[]} paths 相对路径列表（如 kxm/tasks/...，可带前缀斜杠）
 * @returns {Promise<{ deleted: string[], failed: { path, error }[] }>}
 */
async function removeFiles(paths = []) {
  const list = [...new Set(
    (paths || [])
      .map(p => String(p).replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter(Boolean)
  )];
  if (list.length === 0) return { deleted: [], failed: [] };
  const storage = app.storage.from();
  // 传统模式云存储：from() 生成的实例 bucketId 为空，remove/info 归一化 cloud:// 文件 ID 时会
  // 抛 "bucketId is not set"。需显式指定环境默认桶，否则所有删除都会失败。
  storage.bucketId = STORAGE_BUCKET;
  const deleted = [];
  const failed = [];
  const tryRemove = async (paths) => {
    try {
      const { error } = await storage.remove(paths);
      return error || null;
    } catch (e) {
      return e;
    }
  };
  // 单次最多 50 个，避免 deleteFile 单次上限超限；单条失败不阻断其余文件
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const err = await tryRemove(chunk);
    if (!err) {
      deleted.push(...chunk);
      continue;
    }
    console.error("[storage] removeFiles 整批失败，逐条重试", chunk, (err && err.message) || err);
    for (const p of chunk) {
      const e2 = await tryRemove([p]);
      if (e2) {
        failed.push({ path: p, error: (e2 && e2.message) || String(e2) });
      } else {
        deleted.push(p);
      }
    }
  }
  return { deleted, failed };
}

module.exports = {
  STORAGE_BUCKET, STORAGE_DOMAIN, STORAGE_ROOT, BIZ_WHITELIST,
  publicUrl, isBizAllowed, uploadImage, logUpload, bindBizId, markRemoved, removeFiles,
  dupSharedImages,
};
