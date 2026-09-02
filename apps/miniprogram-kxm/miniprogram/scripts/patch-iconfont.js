/**
 * 课小满 - 修复 TDesign 图标字体 @font-face
 *
 * 背景：tdesign-miniprogram 的 icon.wxss 依赖 @font-face 加载图标字体（font-family: t），
 * 图标字符为私有区码点 \E001 等，若删除 @font-face，图标会渲染成乱码方块。
 * 旧版脚本为绕开「本地路径字体」编译报错而直接删除 @font-face，导致图标乱码。
 * 本脚本改为确保 @font-face 指向 TDesign 官方 CDN（https://tdesign.gtimg.com），
 * 既不会触发本地路径限制，也能正常显示图标。
 * 脚本同时修补：
 *   1. miniprogram_npm/tdesign-miniprogram/icon/icon.wxss （构建产物，直接生效）
 *   2. node_modules/tdesign-miniprogram/miniprogram_dist/icon/icon.wxss （npm 源，下次构建生效）
 * 已通过 package.json 的 postinstall 钩子自动执行。
 *
 * 用法：node scripts/patch-iconfont.js
 */
const fs = require('fs');
const path = require('path');

const FONT_FACE =
  "@font-face{font-family:t;src:url(https://tdesign.gtimg.com/icon/0.4.3/fonts/t.eot),url(https://tdesign.gtimg.com/icon/0.4.3/fonts/t.eot?#iefix) format('ded-opentype'),url(https://tdesign.gtimg.com/icon/0.4.3/fonts/t.woff) format('woff'),url(https://tdesign.gtimg.com/icon/0.4.3/fonts/t.ttf) format('truetype'),url(https://tdesign.gtimg.com/icon/0.4.3/fonts/t.svg) format('svg');font-weight:400;font-style:normal;}";

const RE_FONT_FACE = /@font-face\{[^}]*\}/;

const candidates = [
  path.join(__dirname, '..', 'miniprogram_npm', 'tdesign-miniprogram', 'icon', 'icon.wxss'),
  path.join(__dirname, '..', 'node_modules', 'tdesign-miniprogram', 'miniprogram_dist', 'icon', 'icon.wxss'),
];

let done = 0;
let missing = 0;
for (const file of candidates) {
  if (!fs.existsSync(file)) {
    console.log(`[patch-iconfont] skip (不存在): ${path.relative(process.cwd(), file)}`);
    missing++;
    continue;
  }
  let css = fs.readFileSync(file, 'utf8');
  if (RE_FONT_FACE.test(css) && /tdesign\.gtimg\.com/.test(css)) {
    console.log(`[patch-iconfont] skip (已包含 CDN font-face): ${path.relative(process.cwd(), file)}`);
    continue;
  }
  css = css.replace(RE_FONT_FACE, '');
  const importRe = /^@import[^;]+;/;
  if (importRe.test(css)) {
    css = css.replace(importRe, (m) => m + FONT_FACE);
  } else {
    css = FONT_FACE + css;
  }
  fs.writeFileSync(file, css, 'utf8');
  console.log(`[patch-iconfont] fixed: ${path.relative(process.cwd(), file)}`);
  done++;
}
if (missing === candidates.length) {
  console.log('[patch-iconfont] 未找到 tdesign-miniprogram，请确认已安装（npm install）');
  process.exit(1);
}
console.log('[patch-iconfont] done');
