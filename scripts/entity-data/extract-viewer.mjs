// 从原始单文件里抽出 HTML 外壳 / 样式 / 两段 JS，便于移植（一次性工具，产物在 data/extract）
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'data/entity-preview-source.html';
const OUT = 'data/extract';
const lines = fs.readFileSync(SRC, 'utf8').split('\n'); // 1-based 对应 lines[i-1]

const slice = (a, b) => lines.slice(a - 1, b).join('\n'); // 闭区间 [a,b]

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/shell.html`, slice(1, 181));        // <head> + <style>
fs.writeFileSync(`${OUT}/body.html`, slice(182, 283));       // <body> 标记
fs.writeFileSync(`${OUT}/gl3d.js`, slice(286, 575));         // 第一段：自写 WebGL 渲染器
fs.writeFileSync(`${OUT}/app.js`, slice(578, 1694));         // 第二段：应用逻辑

for (const f of ['shell.html', 'body.html', 'gl3d.js', 'app.js']) {
  const s = fs.statSync(`${OUT}/${f}`);
  console.log(`${f.padEnd(12)} ${(s.size / 1024).toFixed(1)} KB  ${fs.readFileSync(`${OUT}/${f}`, 'utf8').split('\n').length} 行`);
}

// 拼成站点用的 viewer 脚本：GL3D + 应用逻辑
fs.mkdirSync('public/preview', { recursive: true });
const header = `/* 地图实体预览 viewer —— 移植自「云朵小铺 · 地图实体预览」单文件版
 * 改动：数据改为按图 fetch(/entity/data/<slug>.bin) ；A/C 已在构建期解析为可读文本(A2/C2)；
 *      侧栏列表改用 /entity/catalog.json，不再一次性加载全部 645 张图。
 * 数据构建：scripts/entity-data/build-entity-data.mjs
 */
`;
fs.writeFileSync('public/preview/app.js', header + slice(286, 575) + '\n' + slice(578, 1694) + '\n');
console.log(`\npublic/preview/app.js  ${(fs.statSync('public/preview/app.js').size / 1024).toFixed(1)} KB`);
