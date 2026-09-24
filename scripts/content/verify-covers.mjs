#!/usr/bin/env node
/**
 * 校验人工封面目录 public/images/covers/custom/。
 *
 *   node scripts/content/verify-covers.mjs
 *
 * 为什么需要单独校验：
 * 这个目录里的图是**按文件名**生效的 —— 生成器只会去找
 * `public/images/covers/custom/<地图英文名>.<webp|png|jpg|jpeg>`，
 * 名字差一个字符（比如把 ze_obj_abyss_v2 写成 ze_obj_abyss、或者用了 Steam 分片名
 * 2001-ze_obj_abyss_v2-3779264454）这张图就**永远不会出现**，
 * 而构建、CI、页面全部正常 —— 又是一次「改动静默消失」。
 * 所以这里第一个检查就是：文件名对不对得上某张真实存在的地图。
 *
 * 尺寸读取不引第三方库：sharp 只是 astro 的传递依赖，
 * 校验脚本不该依赖它（哪天 astro 换了实现，CI 就会莫名其妙挂掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/images/covers/custom');
const MAPS_DIR = path.join(ROOT, 'src/content/maps');
const RESEARCH_DIR = path.join(ROOT, 'data/research');

const ALLOWED_EXT = ['webp', 'png', 'jpg', 'jpeg'];
/** 生成器取图的顺序，同一张图有多个格式时只有第一个生效 */
const PICK_ORDER = ['webp', 'png', 'jpg', 'jpeg'];

const MAX_BYTES = 800 * 1024; // 超过就是仓库负担，且页面加载会变慢
const WARN_BYTES = 300 * 1024;
const MIN_WIDTH = 640; // 详情页顶部当满宽背景用，太小会糊
const RATIO_TOLERANCE = 0.15; // 与 16:9 的偏差超过 15% 提醒一下

const errors = [];
const warns = [];

/** 只读文件头拿宽高（png / jpeg / webp / gif），读不出返回 null */
function imageSize(buf) {
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

if (!fs.existsSync(DIR)) {
  console.log('人工封面目录还不存在（public/images/covers/custom/）——没事，没有人工封面而已');
  process.exit(0);
}

/*
 * 说明文件跟封面放在同一个目录，是故意的：GitHub 浏览目录时会把该目录的 README.md
 * 渲染在文件列表下面，正好拦住「想换封面 → 点进渲染目录 → 换错地方」这个常见误会。
 * 所以校验时要跳过它们，不能当成「不支持的格式」。
 */
const isDoc = (f) => /\.(md|txt)$/i.test(f);
const files = fs.readdirSync(DIR).filter((f) => !f.startsWith('.') && !isDoc(f));
const bySlug = new Map();

for (const file of files) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const slug = path.basename(file, path.extname(file));
  const full = path.join(DIR, file);
  const size = fs.statSync(full).size;
  const kb = (size / 1024).toFixed(0);

  if (!ALLOWED_EXT.includes(ext)) {
    errors.push(`${file}: 不支持的格式 .${ext}（只能用 ${ALLOWED_EXT.join(' / ')}）`);
    continue;
  }

  // 第一条也是最重要的一条：文件名必须是一张真实存在的地图
  if (!fs.existsSync(path.join(MAPS_DIR, `${slug}.mdx`)) && !fs.existsSync(path.join(RESEARCH_DIR, `${slug}.json`))) {
    const looksLikeEntity = /^\d+-[a-zA-Z0-9_]+-\d+$/.test(slug);
    errors.push(
      `${file}: 找不到叫「${slug}」的地图，这张图永远不会显示。` +
        (looksLikeEntity
          ? '（这是 Steam 分片名，文件名要用地图英文名，例如 ze_obj_abyss_v2）'
          : '（文件名必须正好等于地图英文名，拼错一个字符就不生效）')
    );
  }

  if (size > MAX_BYTES) {
    errors.push(`${file}: ${kb} KB，太大了（上限 ${MAX_BYTES / 1024} KB）。封面是网页资源，请先压缩。`);
  } else if (size > WARN_BYTES) {
    warns.push(`${file}: ${kb} KB，偏大（建议 300 KB 以内）`);
  }

  const dim = imageSize(fs.readFileSync(full));
  if (!dim) {
    warns.push(`${file}: 读不出尺寸，跳过了比例检查`);
  } else {
    const ratio = dim.w / dim.h;
    const target = 16 / 9;
    const off = Math.abs(ratio - target) / target;
    if (off > RATIO_TOLERANCE) {
      const shape = ratio < target ? '偏竖' : '偏宽';
      warns.push(
        `${file}: ${dim.w}×${dim.h}（${ratio.toFixed(2)}:1，${shape}，标准是 16:9）——` +
          `卡片和顶部背景会按 16:9 裁切，主体太靠边可能被切掉`
      );
    }
    if (dim.w < MIN_WIDTH) {
      warns.push(`${file}: 宽度只有 ${dim.w}px（建议 ${MIN_WIDTH}px 以上），详情页顶部当大图用会糊`);
    }
  }

  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(ext);
}

// 同一张图存了多种格式：只有靠前的那个生效，其余的纯属占仓库
for (const [slug, exts] of bySlug) {
  if (exts.length > 1) {
    const winner = PICK_ORDER.find((e) => exts.includes(e));
    warns.push(`${slug}: 同时有 ${exts.join(' / ')}，实际只用 .${winner}，其余的可以删掉`);
  }
}

const total = files.length;
console.log(`人工封面 ${total} 张${total ? `（${[...bySlug.keys()].slice(0, 5).join('、')}${bySlug.size > 5 ? ' 等' : ''}）` : ''}`);
console.log(`  → 其中会覆盖渲染图的：${bySlug.size} 张`);

if (warns.length) {
  console.log(`\n⚠️  提醒 ${warns.length} 条：`);
  for (const w of warns.slice(0, 20)) console.log('   - ' + w);
  if (warns.length > 20) console.log(`   … 另有 ${warns.length - 20} 条`);
}

if (errors.length) {
  console.log(`\n❌ 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 30)) console.log('   - ' + e);
  console.log('\n人工封面放在 public/images/covers/custom/，文件名 = <地图英文名>.<webp|png|jpg>');
  console.log('地图英文名 = 地图页副标题那串（例如 ze_obj_abyss_v2），不是 Steam 分片名。');
  process.exit(1);
}

console.log('\n✅ 人工封面校验通过');
