/**
 * 云存储上传路由
 * ⚠️ callContainer 请求体限制 100KB（错误码 -606001），base64 传图会超限。
 * 因此：前端用 wx.cloud.uploadFile 直传云存储，本接口只负责登记 file_uploads
 * 记录表（业务 ID 在业务创建成功后回填），不接收图片二进制。
 */
const express = require("express");
const { ok, fail } = require("../response");
const { logUpload, publicUrl, isBizAllowed, STORAGE_ROOT } = require("../storage");
const { genId, formatDate } = require("../utils");

const router = express.Router();

/** 校验日期目录 yyyy-MM-dd，非法则回退到今天（防路径穿越） */
function safeDateDir(date) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return String(date);
  return formatDate(new Date());
}

// ==================== 批量登记已上传图片 ====================
router.post("/upload", async (req, res) => {
  try {
    const { biz, date, images } = req.body || {};
    if (!biz) return res.json(fail("缺少业务类型 biz"));
    if (!Array.isArray(images) || images.length === 0) return res.json(fail("缺少图片数据"));
    if (images.length > 9) return res.json(fail("单次最多上传 9 张"));
    if (!isBizAllowed(biz)) return res.json(fail("非法的业务类型"));

    const dateDir = safeDateDir(date);
    const files = [];
    const results = [];
    for (const img of images) {
      const path = String(img.path || "").trim();
      // 仅接受本业务前缀的路径，防越权/路径穿越
      if (!path.startsWith(`${STORAGE_ROOT}/${biz}/`)) return res.json(fail("非法的图片路径"));
      const file = {
        fileId: genId(),
        path,
        url: publicUrl(path),
        cosId: String(img.fileID || ""),
        size: Number(img.size) || 0,
        contentType: String(img.contentType || "").includes("png") ? "image/png" : "image/jpeg",
        fileName: String(img.name || "").slice(0, 255),
      };
      files.push(file);
      results.push({ fileId: file.fileId, path: file.path, url: file.url });
    }
    // 记录上传（并行登记，失败不影响登记结果）
    await Promise.all(files.map(file => logUpload({ openid: req.openid, biz, file })));
    res.json(ok({ images: results }, "上传成功"));
  } catch (e) {
    console.error("[storage] upload route error", e);
    res.json(fail("服务异常", 500));
  }
});

module.exports = router;
