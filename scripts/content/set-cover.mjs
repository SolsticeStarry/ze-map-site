#!/usr/bin/env node
/**
 * 给某张地图换上人工封面，取代实体数据渲染出来的 3D 缩略图。
 *
 *   npm run cover:set -- ze_obj_abyss_v2 "D:\图片\封面.png"
 *   npm run cover:set -- ze_obj_abyss_v2 封面.jpg --position top
 *   npm run cover:set -- ze_obj_abyss_v2 竖版海报.png --mode contain
 *   npm run cover:set -- ze_obj_abyss_v2 --remove        # 换回渲染图
 *
 * 产物：public/images/covers/custom/<地图内部名>.webp
 *
 * ⚠️ 为什么放在 custom/ 子目录，而不是直接覆盖 /images/covers/<分片名>.webp：
 *    那个目录是 `npm run data:covers` 的产物。直接换掉它平时能用（渲染脚本默认跳过
 *    已存在的文件），但 `npm run data:covers --force` 一跑就被冲掉，
 *    而且事后分不清哪张是脚本渲染的、哪张是人换的。
 *    放在 custom/ 则两者互不干扰：生成器优先取它，批量重渲染不碰它。
 *    想换回渲染图，把 custom/ 里那个文件删掉即可 —— 不用改任何配置。
 *
 * 图片规格（页面上的两处用法）：
 *   · 地图卡片封面 —— 16:9 画幅
 *   · 详情页顶部的背景大图 —— 满宽铺底、带遮罩
 *   所以默认输出 1280×720 的 webp，通常 100 KB 上下。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'public/images/covers/custom');
const MAPS_DIR = path.join(ROOT, 'src/content/maps');
const RESEARCH_DIR = path.join(ROOT, 'data/research');

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

const slug = positional[0];
const srcArg = positional[1];
const WIDTH = Number(opt('width', 1280));
const HEIGHT = Math.round((WIDTH * 9) / 16);
const QUALITY = Number(opt('quality', 82));
const POSITION = opt('position', 'centre');
const MODE = opt('mode', 'cover');

const usage = `
给地图换人工封面

  npm run cover:set -- <地图英文名> <图片路径> [选项]
  npm run cover:set -- <地图英文名> --remove

  <地图英文名>   就是详情页副标题那个名字，也是 src/content/maps/ 下的文件名
                 例如 ze_obj_abyss_v2（不确定的话去地图页看 :: 后面那串）

选项
  --width 1280      输出宽度，高度按 16:9 自动算
  --quality 82     webp 质量
  --position centre  裁切时的对齐：centre / top / bottom / left / right / attention
  --mode cover      铺满并裁切（默认）；contain = 完整放下，四周填深色底
  --remove          删掉人工封面，换回渲染图
`;

if (!slug) {
  console.log(usage);
  process.exit(1);
}

// 校验这张图存在：自动生成的条目在 src/content/maps/，手写的三张也在这里
const mapFile = path.join(MAPS_DIR, `${slug}.mdx`);
const researchFile = path.join(RESEARCH_DIR, `${slug}.json`);
if (!fs.existsSync(mapFile) && !fs.existsSync(researchFile)) {
  console.error(`✗ 找不到地图「${slug}」`);
  console.error(`  ${path.relative(ROOT, mapFile)} 和 ${path.relative(ROOT, researchFile)} 都不存在。`);
  console.error('  地图英文名 = 详情页副标题那串（例如 ze_obj_abyss_v2），不是 Steam 的分片名。');
  process.exit(1);
}

const out = path.join(OUT_DIR, `${slug}.webp`);

if (has('remove')) {
  if (!fs.existsSync(out)) {
    console.log(`没有人工封面（${path.relative(ROOT, out)} 不存在），本来就是渲染图。`);
    process.exit(0);
  }
  fs.rmSync(out);
  console.log(`✓ 已删除 ${path.relative(ROOT, out)}`);
  console.log('  跑一次 npm run build，这张图就会换回实体数据渲染的封面。');
  process.exit(0);
}

if (!srcArg) {
  console.log(usage);
  process.exit(1);
}

const src = path.resolve(srcArg);
if (!fs.existsSync(src)) {
  console.error(`✗ 找不到图片：${src}`);
  process.exit(1);
}

try {
  const meta = await sharp(src).metadata();
  const srcRatio = meta.width && meta.height ? meta.width / meta.height : 0;
  const hadCustom = fs.existsSync(out); // 必须在写之前判断

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pipeline = sharp(src).rotate(); // 手机竖拍的照片按 EXIF 摆正
  if (MODE === 'contain') {
    pipeline.resize(WIDTH, HEIGHT, {
      fit: 'contain',
      background: { r: 11, g: 13, b: 18, alpha: 1 }, // 与站点深色底一致
    });
  } else {
    pipeline.resize(WIDTH, HEIGHT, { fit: 'cover', position: POSITION });
  }
  await pipeline.webp({ quality: QUALITY }).toFile(out);

  const outSize = fs.statSync(out).size;
  console.log(`✓ 已写入 ${path.relative(ROOT, out)}${hadCustom ? '（覆盖了上一张人工封面）' : '（这张图之前用的是渲染封面）'}`);
  console.log(
    `  原图 ${meta.width}×${meta.height}（${srcRatio ? srcRatio.toFixed(2) : '?'}:1，${(fs.statSync(src).size / 1024).toFixed(0)} KB）` +
      ` → 输出 ${WIDTH}×${HEIGHT} webp ${(outSize / 1024).toFixed(0)} KB`
  );

  if (MODE !== 'contain' && srcRatio) {
    const target = 16 / 9;
    if (srcRatio > target * 1.02) {
      const side = POSITION === 'left' ? '右边' : POSITION === 'right' ? '左边' : '左右两边';
      console.log(`  提示：原图比 16:9 更宽，${side}会被裁掉一部分（--position 可调整保留哪一侧）。`);
    } else if (srcRatio < target * 0.98) {
      console.log(`  提示：原图比 16:9 更高，上下会被裁掉，只保留中间约 ${((srcRatio / target) * 100).toFixed(0)}% 的高度。`);
      console.log('         如果不想裁，用 --mode contain（完整放下，两边填深色底）。');
    }
  }

  console.log('\n接下来：');
  console.log('  1) npm run build           —— 生成器会把 MDX 里的 cover 指到这个文件');
  console.log('  2) 提交这两个改动：public/images/covers/custom/' + slug + '.webp');
  console.log('     以及 src/content/maps/' + slug + '.mdx');
  console.log('  想换回渲染图：npm run cover:set -- ' + slug + ' --remove');
} catch (e) {
  console.error('✗ 处理图片失败：' + (e && e.message ? e.message : e));
  console.error('  支持 jpg / png / webp / avif / gif / tiff 等常见格式。');
  process.exit(1);
}
