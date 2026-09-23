// 由原单文件的 <style> + <body> 生成站点的 /preview 页面（一次性生成，之后可直接改生成物）
import fs from 'node:fs';

const shell = fs.readFileSync('data/extract/shell.html', 'utf8');
const body = fs.readFileSync('data/extract/body.html', 'utf8');
const m = shell.match(/<style>([\s\S]*?)<\/style>/);
if (!m) throw new Error('没找到 <style>');
let css = m[1];

/* 站点主题覆盖：把原版粉色主题接到 ze-map.cn 的暗色红/青主题上 */
css += `
/* ================= 站点主题覆盖（ze-map.cn） ================= */
:root{
  --bg:#06070b; --panel:#0d0f16; --panel2:#12151f;
  --ink:#e6e9f0; --ink2:#8a92a6; --ink3:#5f6678;
  --line:#1e2230; --line2:#2a3040;
  --accent:#ff4d4d; --accent2:#22d3ee;
  --chip:#12151f; --ok:#22c55e; --warn:#f59e0b;
  --shadow:0 2px 10px rgba(0,0,0,.45);
}
body{ background:var(--bg); color:var(--ink); }
header{
  background:linear-gradient(135deg,#1a0d10 0%,#25131a 55%,#12202a 100%);
  border-bottom:1px solid var(--line2);
  box-shadow:0 2px 18px rgba(0,0,0,.5);
}
header .badge{ background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.16); color:var(--ink2); }
header .back{ margin-left:10px; font-size:12px; color:#fff; opacity:.85; text-decoration:none;
  border:1px solid rgba(255,255,255,.32); padding:3px 10px; border-radius:20px; white-space:nowrap; }
header .back:hover{ opacity:1; background:rgba(255,255,255,.12); }
aside{ background:var(--panel); border-right-color:var(--line); }
.side-hd{ border-bottom-color:var(--line); }
.side-hd input{ background:#0b0d14; color:var(--ink); border-color:var(--line2); }
.side-hd input:focus{ border-color:var(--accent); box-shadow:0 0 0 3px rgba(255,77,77,.12); }
.side-tools select{ font-size:11.5px; padding:3px 6px; border-radius:7px; background:#0b0d14;
  color:var(--ink); border:1px solid var(--line2); font-family:inherit; }
.side-tools button{ background:#12151f; color:var(--ink2); border-color:var(--line2); }
.side-tools button.on{ background:var(--accent); border-color:var(--accent); color:#fff; }
.mi:hover{ background:var(--panel2); }
.mi.on{ background:linear-gradient(90deg,rgba(255,77,77,.18),transparent); border-left-color:var(--accent); }
.mi-t{ color:var(--ink); }
.mi-s{ color:var(--ink3); }
.side-empty{ padding:14px; color:var(--ink3); font-size:12px; }
.bar{ background:var(--panel); border-bottom-color:var(--line); }
.seg button{ background:#12151f; color:var(--ink2); border-color:var(--line2); }
.seg button.on{ background:var(--accent); border-color:var(--accent); color:#fff; }
.btn{ background:#12151f; color:var(--ink); border-color:var(--line2); }
.btn:hover{ border-color:var(--accent); color:#fff; }
.ctl{ color:var(--ink2); }
.stage{ background:#04050a; }
.layers{ background:var(--panel); border-color:var(--line2); box-shadow:0 18px 50px rgba(0,0,0,.6); }
.card{ background:rgba(10,12,18,.82); color:var(--ink2); border:1px solid var(--line); }
.chip{ background:var(--chip); color:var(--ink2); border-color:var(--line); }
.edetail{ background:var(--panel); border-color:var(--line2); color:var(--ink); }
.esearch input{ background:var(--panel); color:var(--ink); border-color:var(--line2); }
.loading{ background:var(--bg); color:var(--ink2); }
`;

fs.writeFileSync('src/styles/preview.css', css);

const page = `---
/* 地图实体预览（viewer）—— 移植自单文件版，数据按图按需加载。
   数据构建： scripts/entity-data/build-entity-data.mjs
   脚本：     public/preview/app.js
   支持参数： ?map=<slug|内部名|中文名>&view=2d&stage=N */
import '../styles/preview.css';
---

<!doctype html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>地图实体预览 · ZE 地图资料站</title>
    <meta
      name="description"
      content="CS2 僵尸逃跑地图实体预览：可破坏物、传送门、机关、危险区、关卡分层的 2D/3D 可视化。"
    />
  </head>
${body.replace('<body>', '<body>')}
  <script is:inline src="/preview/app.js" defer></script>
</body>
</html>
`;

fs.writeFileSync('src/pages/preview.astro', page);
console.log('src/styles/preview.css', (fs.statSync('src/styles/preview.css').size / 1024).toFixed(1) + ' KB');
console.log('src/pages/preview.astro', (fs.statSync('src/pages/preview.astro').size / 1024).toFixed(1) + ' KB');
