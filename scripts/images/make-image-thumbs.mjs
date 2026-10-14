#!/usr/bin/env node
/**
 * 图片瘦身：首页背景图 + 卡片缩略图（2026-10-15 加）。
 *
 * 为什么需要：首页与地图页「有时候很慢」的实测原因是**首屏那几张图的字节数**——
 *   · `public/images/hero-bg.webp` 1920×1277 = 183 KB，它是首页的 LCP 元素（CSS 背景图），
 *     实测下载 349~1430 ms（同一条链路差 4 倍）；
 *   · 93 张人工封面（`public/images/covers/custom/`）是 1280×720、平均 ~100 KB、最大 220 KB，
 *     而卡片里只显示 379×213 —— 主页那三张精选卡片因此要下 400+ KB。
 *
 * 做法（**不引入任何依赖**）：借本机 Edge/Chrome 的 canvas 编码 WebP。
 * 站点构建不需要跑这个脚本 —— 产物是入库的图片文件，只在「换封面 / 想再压一轮」时手动跑：
 *
 *   npm run images:thumbs            # 缺什么补什么（产物比源新就跳过）
 *   npm run images:thumbs -- --force # 全部重做
 *
 * 产物：
 *   public/images/hero-bg.webp   压到 1280 宽（首页背景，被压暗到 45% 亮度，看不出差别）
 *   public/images/hero-bg.jpg    同上（只给不支持 WebP 的老浏览器 / og:image 用）
 *   public/images/covers/custom-640/<名字>.webp   卡片用缩略图（640 宽）
 *
 * 卡片怎么用上缩略图：`src/lib/cover-thumbs.ts` 的 cardCover()（构建期查一次目录索引）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORCE = process.argv.includes('--force');
const CUSTOM_DIR = path.join(ROOT, 'public/images/covers/custom');
const THUMB_DIR = path.join(ROOT, 'public/images/covers/custom-640');
const HERO_WEBP = path.join(ROOT, 'public/images/hero-bg.webp');
const HERO_JPG = path.join(ROOT, 'public/images/hero-bg.jpg');

/** 找本机浏览器（和 tools/ 里那些临时脚本同一个路子） */
function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Edge/Chrome —— 用 CHROME_PATH 指定一个');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个 headless 浏览器，返回 { encode(file, {w, q, format}) } */
async function openEncoder() {
  const browser = findBrowser();
  const port = 9371 + Math.floor(Math.random() * 40);
  const proc = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--user-data-dir=' + path.join(process.env.TEMP || '/tmp', 'ze-image-encode'),
    'about:blank',
  ], { stdio: 'ignore' });
  await sleep(3000);
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      const on = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');

  return {
    /** 把一张图缩到宽 w、按 q 编码成 webp/jpeg，返回 Buffer（图比 w 窄就不放大，直接原样返回 null） */
    async encode(file, { w, q, format = 'image/webp' }) {
      const b64 = fs.readFileSync(file).toString('base64');
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
      const expr = `(async () => {
        const blob = await (await fetch('data:${mime};base64,${b64}')).blob();
        const bmp = await createImageBitmap(blob);
        if (bmp.width <= ${w}) return { skipped: true, w: bmp.width, h: bmp.height };
        const scale = ${w} / bmp.width;
        const cv = new OffscreenCanvas(${w}, Math.round(bmp.height * scale));
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        const out = await cv.convertToBlob({ type: '${format}', quality: ${q} });
        const buf = new Uint8Array(await out.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
        return { data: btoa(s), w: cv.width, h: cv.height, from: bmp.width + 'x' + bmp.height };
      })()`;
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      const v = r.result?.result?.value;
      if (!v || v.skipped) return v ? { skipped: true } : null;
      return { buf: Buffer.from(v.data, 'base64'), w: v.w, h: v.h, from: v.from };
    },
    close() {
      try { ws.close(); } catch {}
      proc.kill();
    },
  };
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const newer = (out, src) => {
  try { return fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs; } catch { return false; }
};

const enc = await openEncoder();
let saved = 0;
try {
  /* 1. 首页背景图：它是 LCP 元素，而且被 `filter: brightness(.45)` 压暗当氛围底图，
        所以「宽一点、糊一点」都看不出来 —— 尺寸/质量就按这个前提压到最小。 */
  for (const [file, q] of [[HERO_WEBP, 0.45], [HERO_JPG, 0.68]]) {
    if (!fs.existsSync(file)) continue;
    const before = fs.statSync(file).size;
    const out = await enc.encode(file, { w: 1152, q, format: file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp' });
    if (!out || out.skipped) {
      console.log(`  跳过 ${path.basename(file)}（本来就不宽）`);
      continue;
    }
    fs.writeFileSync(file, out.buf);
    saved += before - out.buf.length;
    console.log(`  ${path.basename(file).padEnd(16)} ${out.from} → ${out.w}×${out.h}  ${kb(before)} → ${kb(out.buf.length)}`);
  }

  /* 2. 人工封面的卡片缩略图 */
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  const covers = fs.readdirSync(CUSTOM_DIR).filter((f) => /\.(webp|jpe?g|png)$/i.test(f) && !f.startsWith('.'));
  let made = 0;
  let skipped = 0;
  for (const f of covers) {
    const src = path.join(CUSTOM_DIR, f);
    const outPath = path.join(THUMB_DIR, f.replace(/\.(jpe?g|png)$/i, '.webp'));
    if (!FORCE && newer(outPath, src)) { skipped++; continue; }
    const before = fs.statSync(src).size;
    const out = await enc.encode(src, { w: 640, q: 0.62 });
    if (!out || out.skipped) { skipped++; continue; }
    fs.writeFileSync(outPath, out.buf);
    made++;
    saved += before - out.buf.length;
  }
  console.log(`  卡片缩略图：新做 ${made} 张 · 跳过 ${skipped} 张 → ${path.relative(ROOT, THUMB_DIR)}`);
  const thumbSize = fs.readdirSync(THUMB_DIR).reduce((s, f) => s + fs.statSync(path.join(THUMB_DIR, f)).size, 0);
  console.log(`  缩略图合计 ${(thumbSize / 1024 / 1024).toFixed(1)} MB（原图合计 ${(fs.readdirSync(CUSTOM_DIR).filter((f) => /\.(webp|jpe?g|png)$/i.test(f)).reduce((s, f) => s + fs.statSync(path.join(CUSTOM_DIR, f)).size, 0) / 1024 / 1024).toFixed(1)} MB）`);
} finally {
  enc.close();
}
console.log(`\n本轮少下约 ${(saved / 1024 / 1024).toFixed(2)} MB（按「每张图各下一次」算）`);
