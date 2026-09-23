/* 地图实体预览 viewer —— 移植自「云朵小铺 · 地图实体预览」单文件版
 * 改动：数据改为按图 fetch(/entity/data/<slug>.bin) ；A/C 已在构建期解析为可读文本(A2/C2)；
 *      侧栏列表改用 /entity/catalog.json，不再一次性加载全部 645 张图。
 * 数据构建：scripts/entity-data/build-entity-data.mjs
 */
/* =====================================================================
   ★ 3D 渲染引擎（独立于主逻辑，挂到 window.GL3D）
   - 统一材质：全场所有实体共用一套 Lambert + 半球环境光，仅类别色不同
   - 几何：36 顶点单位立方体（6 面），按实体半长缩放平移，一次性填进动态 VBO
   - 环境点用 POINTS 精灵绘制（圆形衰减）
   ===================================================================== */
window.GL3D = (function(){
  const VS = [
    'attribute vec3 aPos;','attribute vec3 aNrm;','attribute vec3 aCol;','attribute float aSel;',
    'uniform mat4 uVP;','varying vec3 vN;','varying vec3 vC;','varying float vS;','varying vec3 vW;',
    'void main(){',
    '  vW = aPos; vN = aNrm; vC = aCol; vS = aSel;',
    '  gl_Position = uVP * vec4(aPos, 1.0);',
    '}'].join('\n');
  const FS = [
    'precision mediump float;',
    'uniform vec3 uEye;','uniform float uAlpha;','uniform float uFogK;','uniform vec3 uFogC;',
    'varying vec3 vN;','varying vec3 vC;','varying float vS;','varying vec3 vW;',
    'void main(){',
    '  if(vS < -0.5) discard;',
    '  vec3 N = normalize(vN);',
    '  vec3 L = normalize(vec3(-0.44, 0.78, 0.45));',
    '  float d  = max(dot(N, L), 0.0);',
    '  float hemi = 0.5 + 0.5 * N.y;',
    '  vec3 amb = mix(vec3(0.40,0.42,0.48), vec3(0.74,0.76,0.82), hemi);',
    '  vec3 col = vC * (amb + d * 0.58);',
    '  vec3 V = normalize(uEye - vW);',
    '  float fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
    '  col += fr * 0.12;',
    '  float dist = length(uEye - vW);',
    '  float fog = clamp(exp(-dist * uFogK), 0.0, 1.0);',
    '  col = mix(uFogC, col, fog);',
    '  float a = uAlpha * clamp(0.55 + 0.45 * fog, 0.0, 1.0);',
    '  gl_FragColor = vec4(col, a);',
    '}'].join('\n');
  const PVS = [
    'attribute vec3 aPos;','attribute vec3 aCol;','attribute float aSz;',
    'uniform mat4 uVP;','uniform float uPx;',
    'varying vec3 vC;',
    'void main(){',
    '  vC = aCol;',
    '  vec4 p = uVP * vec4(aPos, 1.0);',
    '  gl_Position = p;',
    '  gl_PointSize = clamp(aSz * uPx / max(p.w, 1.0), 1.0, 22.0);',
    '}'].join('\n');
  const PFS = [
    'precision mediump float;',
    'uniform float uAlpha;','uniform vec3 uFogC;','uniform float uFogK;','uniform vec3 uEye;',
    'varying vec3 vC;',
    'void main(){',
    '  vec2 c = gl_PointCoord - vec2(0.5);',
    '  float r2 = dot(c, c);',
    '  if(r2 > 0.25) discard;',
    '  float a = uAlpha * (1.0 - r2 * 3.2);',
    '  gl_FragColor = vec4(vC, a);',
    '}'].join('\n');

  /* 单位立方体：6 面 × 6 顶点（三角形环绕直接展开，免索引缓冲）= 36 顶点 */
  const CUBE = (function(){
    const faces = [
      [[0,0,1],  [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
      [[0,0,-1], [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
      [[1,0,0],  [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],
      [[-1,0,0], [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],
      [[0,1,0],  [[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],
      [[0,-1,0], [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]],
    ];
    const tri = [0,1,2,0,2,3];
    const pos = [], nrm = [];
    for(let f=0; f<6; f++){
      const n = faces[f][0], cs = faces[f][1];
      for(let t=0; t<6; t++){
        const k = tri[t];
        pos.push(cs[k][0], cs[k][1], cs[k][2]);
        nrm.push(n[0], n[1], n[2]);
      }
    }
    return { pos:new Float32Array(pos), nrm:new Float32Array(nrm) };
  })();

  let gl=null, prog=null, pprog=null, ready=false, GL2=false;
  let bufB=null, bufP=null, nBox=0, nPt=0, strideB=0, strideP=0;
  const U = {}, UP = {};

  function sh(t, s){
    const o = gl.createShader(t);
    gl.shaderSource(o, s); gl.compileShader(o);
    if(!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
    return o;
  }
  function mk(vs, fs){
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const o = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for(let i=0;i<n;i++){ const u = gl.getActiveUniform(p, i); o[u.name] = gl.getUniformLocation(p, u.name); }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for(let i=0;i<na;i++){ const a = gl.getActiveAttrib(p, i); o[a.name] = gl.getAttribLocation(p, a.name); }
    return { p, u:o };
  }

  function init(cv){
    try{
      const opt = {alpha:true, antialias:true, premultipliedAlpha:false, depth:true,
                   preserveDrawingBuffer:true};
      gl = cv.getContext('webgl2', opt);
      if(gl) GL2 = true; else gl = cv.getContext('webgl', opt) || cv.getContext('experimental-webgl', opt);
      if(!gl) return false;
      const a = mk(VS, FS); prog = a.p; Object.assign(U, a.u);
      const b = mk(PVS, PFS); pprog = b.p; Object.assign(UP, b.u);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      bufB = gl.createBuffer(); bufP = gl.createBuffer();
      ready = true;
      return true;
    }catch(e){
      window.__glerr = e.message;
      return false;
    }
  }

  /* boxes: [{x,y,z,ex,ey,ez,c:[r,g,b],a}]  —— 半长为 ex/ey/ez */
  function setBoxes(boxes){
    const n = boxes.length|0;
    nBox = n;
    if(!n || !gl) return;
    const S = 11;                       // pos3 nrm3 col3 sel1 alpha1
    strideB = S * 4;
    const d = new Float32Array(n * 36 * S);
    const P = CUBE.pos, N = CUBE.nrm;
    let o = 0;
    for(let i=0;i<n;i++){
      const b = boxes[i];
      const x=b.x, y=b.y, z=b.z, ex=b.ex, ey=b.ey, ez=b.ez;
      const c=b.c, al=b.a===undefined?1:b.a, sel=b.s?1:0;
      for(let k=0;k<36;k++){
        d[o++] = x + P[k*3]*ex;
        d[o++] = y + P[k*3+1]*ey;
        d[o++] = z + P[k*3+2]*ez;
        d[o++] = N[k*3]; d[o++] = N[k*3+1]; d[o++] = N[k*3+2];
        d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2];
        d[o++] = sel; d[o++] = al;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
  }
  /* pts: Float32Array [x,y,z,r,g,b,size] × n */
  function setPoints(arr){
    nPt = (arr.length / 7) | 0;
    if(!nPt || !gl) return;
    strideP = 7 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  }

  function clear(){
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /* 4x4 列主序矩阵工具 */
  const M4 = {
    ident: () => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),
    mul(a, b){
      const o = new Float32Array(16);
      for(let i=0;i<4;i++){
        const a0=a[i], a1=a[i+4], a2=a[i+8], a3=a[i+12];
        o[i]    = a0*b[0] + a1*b[1] + a2*b[2]  + a3*b[3];
        o[i+4]  = a0*b[4] + a1*b[5] + a2*b[6]  + a3*b[7];
        o[i+8]  = a0*b[8] + a1*b[9] + a2*b[10] + a3*b[11];
        o[i+12] = a0*b[12]+ a1*b[13]+ a2*b[14] + a3*b[15];
      }
      return o;
    },
    persp(fovy, asp, zn, zf){
      const f = 1 / Math.tan(fovy / 2);
      return new Float32Array([
        f/asp,0,0,0, 0,f,0,0,
        0,0,(zf+zn)/(zn-zf),-1, 0,0,(2*zf*zn)/(zn-zf),0]);
    },
    look(eye, ctr, up){
      let z0=eye[0]-ctr[0], z1=eye[1]-ctr[1], z2=eye[2]-ctr[2];
      let l = Math.hypot(z0,z1,z2)||1; z0/=l; z1/=l; z2/=l;
      let x0=up[1]*z2-up[2]*z1, x1=up[2]*z0-up[0]*z2, x2=up[0]*z1-up[1]*z0;
      l = Math.hypot(x0,x1,x2)||1; x0/=l; x1/=l; x2/=l;
      const y0=z1*x2-z2*x1, y1=z2*x0-z0*x2, y2=z0*x1-z1*x0;
      return new Float32Array([
        x0,y0,z0,0, x1,y1,z1,0, x2,y2,z2,0,
        -(x0*eye[0]+x1*eye[1]+x2*eye[2]),
        -(y0*eye[0]+y1*eye[1]+y2*eye[2]),
        -(z0*eye[0]+z1*eye[1]+z2*eye[2]), 1]);
    },
  };

  function draw(cam){
    if(!ready) return;
    clear();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const fogK = cam.fogK === undefined ? 0 : cam.fogK;

    /* --- 块体（drawArrays：顶点数据已展开三角形环绕，无索引上限） --- */
    if(nBox && cam.solid){
      gl.useProgram(prog);
      gl.enable(gl.CULL_FACE);
      for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
      gl.uniformMatrix4fv(U.uVP, false, cam.vp);
      gl.uniform3f(U.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
      gl.uniform1f(U.uAlpha, cam.alpha);
      gl.uniform1f(U.uFogK, fogK);
      gl.uniform3f(U.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
      gl.vertexAttribPointer(U.aPos, 3, gl.FLOAT, false, strideB, 0);
      gl.vertexAttribPointer(U.aNrm, 3, gl.FLOAT, false, strideB, 12);
      gl.vertexAttribPointer(U.aCol, 3, gl.FLOAT, false, strideB, 24);
      gl.vertexAttribPointer(U.aSel, 1, gl.FLOAT, false, strideB, 36);
      gl.enableVertexAttribArray(U.aPos);
      gl.enableVertexAttribArray(U.aNrm);
      gl.enableVertexAttribArray(U.aCol);
      gl.enableVertexAttribArray(U.aSel);
      gl.drawArrays(gl.TRIANGLES, 0, nBox * 36);
    }

    /* --- 环境点 --- */
    if(nPt){
      gl.useProgram(pprog);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
      gl.uniformMatrix4fv(UP.uVP, false, cam.vp);
      gl.uniform1f(UP.uPx, cam.px);
      gl.uniform1f(UP.uAlpha, cam.pAlpha);
      gl.uniform1f(UP.uFogK, fogK);
      gl.uniform3f(UP.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
      gl.uniform3f(UP.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
      gl.vertexAttribPointer(UP.aPos, 3, gl.FLOAT, false, strideP, 0);
      gl.vertexAttribPointer(UP.aCol, 3, gl.FLOAT, false, strideP, 12);
      gl.vertexAttribPointer(UP.aSz, 1, gl.FLOAT, false, strideP, 24);
      gl.enableVertexAttribArray(UP.aPos);
      gl.enableVertexAttribArray(UP.aCol);
      gl.enableVertexAttribArray(UP.aSz);
      gl.drawArrays(gl.POINTS, 0, nPt);
      gl.depthMask(true);
    }
  }
  /* 线段（网格 / 坐标轴）：每帧重建，量小 */
  let lineBuf = null, lineProg = null, lineU = {};
  const LVS = 'attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uVP;' +
              'varying vec3 vC; void main(){ vC=aCol; gl_Position = uVP*vec4(aPos,1.0); }';
  const LFS = 'precision mediump float; varying vec3 vC; uniform float uA;' +
              'void main(){ gl_FragColor = vec4(vC, uA); }';
  function initLines(){
    if(lineProg) return;
    const r = mk(LVS, LFS);
    lineProg = r.p; lineU = r.u;
    lineBuf = gl.createBuffer();
  }
  function drawLines(arr, alpha){
    if(!arr.length) return;
    initLines();
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(lineU.uVP, false, curVP);
    gl.uniform1f(lineU.uA, alpha);
    gl.disable(gl.CULL_FACE);
    // 清掉其它程序遗留的 enabled 属性，避免读到过小的缓冲导致整批绘制失败
    for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(lineU.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(lineU.aCol, 3, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(lineU.aPos);
    gl.enableVertexAttribArray(lineU.aCol);
    gl.drawArrays(gl.LINES, 0, arr.length / 6);
  }
  let curVP = null;

  return {
    init, setBoxes, setPoints, draw, drawLines, M4, clear, CUBE,
    get ok(){ return ready; }, get isGL2(){ return GL2; },
    get boxCount(){ return nBox; }, get ptCount(){ return nPt; },
    setVP(v){ curVP = v; },
  };
})();
"use strict";
/* ============================ 数据加载 ============================ */
/* 网站版：数据不再内嵌在页面里，改为两级按需加载
 *   1) 启动只取 /entity/catalog.json —— 全部地图的索引（约 90 KB gzip），侧栏列表用
 *   2) 选中某张图时再取 /entity/data/<slug>.bin —— 该图的 gzip 分片（平均约 16 KB）
 * 分片格式与原单文件完全一致：[4B 小端 JSON 长度][JSON][BIN]，整体 gzip。
 */
const DATA_BASE = window.__ENTITY_BASE__ || '/entity';
let BIN = null;                   // 当前图的二进制块区（密度底图 + 雷达 webp）
let CATALOG = null;               // 全部地图索引
const payloadCache = new Map();   // slug -> payload，重复切换不再请求

function hasDS(){ return typeof DecompressionStream === 'function'; }

async function fetchCatalog(){
  const res = await fetch(`${DATA_BASE}/catalog.json`);
  if(!res.ok) throw new Error(`目录加载失败 HTTP ${res.status}`);
  return res.json();
}

async function fetchMapPayload(slug){
  if(payloadCache.has(slug)) return payloadCache.get(slug);
  if(!hasDS()){
    throw new Error('当前浏览器不支持解压（DecompressionStream），请用较新的 Chrome / Edge 打开');
  }
  const res = await fetch(`${DATA_BASE}/data/${slug}.bin`);
  if(!res.ok) throw new Error(`地图数据加载失败 HTTP ${res.status}`);
  const ab = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const jlen = new DataView(ab).getUint32(0, true);
  const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jlen)));
  payload.bin = new Uint8Array(ab, 4 + jlen);
  payloadCache.set(slug, payload);
  return payload;
}

/* 打开一张图：拉分片 → 组装成原版 DATA 结构（maps 里只有这一张）→ 复用原有渲染流程 */
async function openMap(entry){
  if(!entry) return;
  const payload = await fetchMapPayload(entry.s);
  BIN = payload.bin;
  payload.map.__k = entry.k;
  payload.maps = { [entry.k]: payload.map };
  DATA = payload;
  CLS = payload.classes;
  MAPKEYS = [entry.k];
  S.entry = entry;
  if(S.listMode && entry.a !== S.listMode){ S.listMode = entry.a; const sel = $('lmode'); if(sel) sel.value = entry.a; }
  loadMap(entry.k);
}

function syncUrl(slug){
  try{
    const u = new URL(location.href);
    u.searchParams.set('map', slug);
    history.replaceState(null, '', u);
  }catch(e){ /* file:// 等场景忽略 */ }
}

let DATA=null, GMAP={}, CLS=[], MAPKEYS=[];
const S = { key:null, entry:null, listMode:'2001', mode:'3d', proj:'xy', hcol:false, psize:3, glow:false, full:false,
            off:new Set(), solo:null, sort:'k', bmap:true, bop:0.6, sel:null,
            vbox:true, bopa:0.88, cutz:1, stage:0 };
let view = {s:1, ox:0, oy:0};
/* 关卡过滤：0=全部 · -1=未标注 · n=第 n 关 */
function stageOk(o){
  if(!S.stage) return true;
  return S.stage === -1 ? !o.sg : o.sg === S.stage;
}

/* ---------------- 3D 相机 ---------------- */
const CAM = {
  tx:0, ty:0, tz:0,        // 目标点（世界坐标）
  dist:4000,               // 眼睛到目标距离
  yaw:-Math.PI/2, pitch:0.62,
  fogK:0, fog:[0.72,0.75,0.82],
  ready:false, lastT:0,
};
function camEye(){
  const cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
  return [CAM.tx + CAM.dist*cp*Math.cos(CAM.yaw),
          CAM.ty + CAM.dist*sp,
          CAM.tz + CAM.dist*cp*Math.sin(CAM.yaw)];
}
function camVP(){
  const eye = camEye();
  const p = GL3D.M4.persp(45*Math.PI/180, (W||1)/(H||1), Math.max(4, CAM.dist*0.004), CAM.dist*14);
  const v = GL3D.M4.look(eye, [CAM.tx, CAM.ty, CAM.tz], [0,1,0]);
  return { eye, vp: GL3D.M4.mul(p, v) };
}

/* ============================ 工具 ============================ */
window.addEventListener('error', function(ev){
  var el = document.getElementById('lmsg');
  if(el) el.textContent = '运行错误：' + ev.message + ' @line ' + (ev.lineno||'?');
  document.title = 'ERR ' + ev.message;
});

window.addEventListener('unhandledrejection', function(ev){
  var r = ev.reason || {};
  var el = document.getElementById('lmsg');
  if(el) el.textContent = '异步错误：' + (r.message || r);
  document.title = 'ERR ' + (r.stack || r.message || r);
});

const $ = id => document.getElementById(id);
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e4 ? (n/1e3).toFixed(1)+'k' : n.toLocaleString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* 类别 → 图层 规则（与数据构建脚本一致，优先级从上到下） */
const RULES = [
  ["tele", ["trigger_teleport","trigger_teleport_relative","point_teleport","info_teleport_destination","trigger_teleport_autocancel"]],
  ["break",["func_breakable","func_breakable_surf","func_physbox","prop_physics","prop_physics_multiplayer","prop_physics_override","prop_physics_multiplayer_override","func_brush_breakable"]],
  ["hurt", ["trigger_hurt","env_fire","env_explosion","trigger_ignite","trigger_waterydeath"]],
  ["trig", ["trigger_once","trigger_multiple","trigger_push","func_buyzone","trigger_brush","trigger_wind","trigger_look","trigger_*","func_ladder","func_illusionary"]],
  ["mech", ["func_button","func_door","func_door_rotating","prop_door_rotating","func_movelinear","func_rotating","func_wall_toggle","func_tracktrain","phys_thruster","func_water","func_brush","func_wall","func_*"]],
  ["path", ["path_track","path_corner","func_trackautochange","path_*"]],
  ["logic",["logic_relay","logic_case","logic_timer","logic_branch","logic_auto","logic_compare","logic_measure_movement","logic_collision_pair","logic_multiple","logic_script","math_counter","math_remap","math_*","point_template","env_entity_maker","point_servercommand","game_player_equip","logic_*","point_*"]],
  ["spawn",["info_player_terrorist","info_player_counterterrorist","info_player_start","info_player_teamspawn","info_player_*"]],
  ["item", ["weapon_*","item_*","game_*"]],
  ["prop", ["prop_*","prop_dynamic","prop_static","prop_ragdoll"]],
  ["env",  ["light_*","info_particle_system","env_particle_glow","env_combined_light_probe_volume","env_light_probe_volume","env_cubemap_box","point_soundevent","ambient_generic","env_soundscape","env_soundscape_proxy","snd_event_point","env_sky","post_processing_volume","path_particle_rope_clientside","cable_dynamic","point_worldtext","env_fade","env_shake","env_hudhint","game_text","info_target","worldspawn","cs_minimap_boundary","func_clip_vphysics","filter_*","env_*","info_*","water_lod_control","sky_camera","shadow_control","color_correction"]]
];
const _exact = new Map(), _wild = [];
for(const [gid, pats] of RULES){ for(const p of pats){ if(p.endsWith('*')) _wild.push([p.slice(0,-1), gid]); else if(!_exact.has(p)) _exact.set(p, gid); } }
function gidOf(cn){
  const e = _exact.get(cn); if(e) return e;
  for(const [pre, gid] of _wild) if(cn.startsWith(pre)) return gid;
  return 'misc';
}

function proj(x,y,z){
  if(S.proj==='xy') return [x, -y];
  if(S.proj==='xz') return [x, -z];
  return [y, -z];
}

/* ============================ 侧栏 ============================ */
const entryOf = k => CATALOG ? CATALOG.maps.find(m => m.k === k) : null;
function buildSide(){
  if(!CATALOG) return;
  const q = $('q').value.trim().toLowerCase();
  const lm = S.listMode;
  let arr = CATALOG.maps.filter(m => !lm || m.a === lm);
  if(q) arr = arr.filter(m => (m.m+' '+m.cn+' '+m.i).toLowerCase().includes(q));
  const sk = S.sort;
  arr.sort((a,b)=> sk==='m' ? (a.cn||a.m).localeCompare(b.cn||b.m, 'zh-Hans-CN') :
                    sk==='st' ? (b.st-a.st)||(b.k2-a.k2) : (b.k2-a.k2));
  const box = $('maps');
  box.innerHTML = arr.slice(0,800).map(m=>
    `<div class="mi${m.k===S.key?' on':''}" data-k="${esc(m.k)}">
       <div class="mi-t">${esc(m.cn || m.m)}</div>
       <div class="mi-s">${esc(m.m)} · <b>${fmt(m.k2)}</b> 实体${m.st?` · ${m.st} 关`:''}</div>
     </div>`).join('') || '<div class="side-empty">无匹配地图</div>';
  const cnt = $('lcount');
  if(cnt) cnt.textContent = `${arr.length} 张`;
}

/* ============================ 载入某图 ============================ */
let cur = null;
function loadMap(k){
  S.key = k;
  const m = DATA.maps[k];
  m.__k = k;
  const b = S.full ? m.fb : m.b;
  cur = { m, b,
    pad:0.06,
    pts:[], grid:new Map(), cell:128, groups:{} };
  const gmap = {}; DATA.groups.forEach(g => gmap[g.id]=g);
  const clsG = CLS.map(c => gidOf(c));

  let xs=[],ys=[],zs=[];
  for(const e of m.e){
    const gid = clsG[e[3]];
    const g = gmap[gid];
    if(!g) continue;
    const [px,py] = proj(e[0],e[1],e[2]);
    // 记录布局：[x,y,z,ci] + 可选 nm(string) / ai / gi，最后一位固定为关卡号（负值=就近推断）
    let nm=null, ai=-1, gi=-1, qp=4;
    if(typeof e[4]==='string'){ nm=e[4]; qp=5; }
    const end = e.length - 1;              // 最后一位 = sg
    if(end > qp){ ai = e[qp++]; }
    if(end > qp){ gi = e[qp]; }
    const sgr = e[end] || 0;
    const obj = {x:e[0],y:e[1],z:e[2],px,py,cn:CLS[e[3]],gid,nm:nm||'',ci:e[3],ai,gi,
                 sg:Math.abs(sgr), sgp:sgr<0};
    cur.pts.push(obj);
    cur.groups[gid] = (cur.groups[gid]||0)+1;
    const cx = Math.floor(px/cur.cell), cy = Math.floor(py/cur.cell);
    const kk = cx+':'+cy;
    let arr = cur.grid.get(kk); if(!arr){arr=[];cur.grid.set(kk,arr);}
    arr.push(obj);
    xs.push(px); ys.push(py);
  }
  const w = Math.max(b[3]-b[0], b[5]-b[2], b[4]-b[1], 1);
  cur.span = Math.abs(maxOf(xs)-minOf(xs)) || 1;
  cur.spanY = Math.abs(maxOf(ys)-minOf(ys)) || 1;
  cur.cx = (maxOf(xs)+minOf(xs))/2; cur.cy = (maxOf(ys)+minOf(ys))/2;

  $('mtitle').textContent = m.cn || m.m;
  $('mcode').textContent = m.i + (m.f?(' · 版本 '+m.f):'');
  S.sel = null; $('edetail').style.display='none';
  $('esres').style.display='none'; $('esq').value='';
  S.stage = 0;
  buildStageSel();
  renderLayers(); renderStats(); fit();
  buildSide();
  loadRadar(m);
  build3D(); resetCam();
  if(S.mode==='3d') render3D();
}
const minOf = a => a.length?Math.min.apply(null,a):0;
const maxOf = a => a.length?Math.max.apply(null,a):0;

/* ============================ 图层面板 ============================ */
function renderLayers(){
  const gmap={}; DATA.groups.forEach(g=>gmap[g.id]=g);
  const ids = Object.keys(cur.groups).sort((a,b)=>cur.groups[b]-cur.groups[a]);
  $('lbody').innerHTML = ids.map(id=>{
    const g = gmap[id]; if(!g) return '';
    const on = !S.off.has(id) && (!S.solo || S.solo===id);
    return `<div class="li${on?'':' off'}${S.solo===id?' solo':''}" data-g="${id}">
      <span class="dot" style="background:${g.color}"></span>
      <span class="nm">${esc(g.label)}</span>
      <span class="ct">${fmt(cur.groups[id])}</span></div>`;
  }).join('');
  const shown = ids.filter(id=>!S.off.has(id) && (!S.solo||S.solo===id)).length;
  $('lvis').textContent = ` ${shown}/${ids.length} 层`;
}
function renderStats(){
  const m = cur.m;
  const order = ['tele','break','mech','hurt','trig','path'];
  const cnt = cur.groups;
  $('stats').innerHTML = [
    `<span class="chip">实体 <b>${fmt(m.n)}</b></span>`,
    `<span class="chip">可绘点 <b>${fmt(cur.pts.length)}</b></span>`,
    m.h ? `<span class="chip">抽样隐藏环境点 <b>${fmt(m.h)}</b></span>` : '',
    m.st ? `<span class="chip">看板关卡数 <b>${m.st}</b></span>` : '<span class="chip">看板无此图</span>',
    m.d ? `<span class="chip">工坊发布 <b>${esc(m.d)}</b></span>` : '',
    m.lib ? `<span class="chip">在云朵小铺地图库</span>` : '',
    ...order.filter(g=>cnt[g]).map(g=>{
      const gg = DATA.groups.find(x=>x.id===g);
      return `<span class="chip"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;
        background:${gg.color};margin-right:4px"></span>${gg.label} <b>${fmt(cnt[g])}</b></span>`;
    }),
    `<span class="chip">Top 类：${(m.t||[]).slice(0,5).map(x=>esc(x[0])+' <b>'+fmt(x[1])+'</b>').join(' · ')}</span>`
  ].filter(Boolean).join('');
}

/* ============================ 底图（雷达 / 密度轮廓） ============================ */
const radarCache = new Map();     // key -> ImageBitmap | null(加载中)
const densCache = new Map();      // key -> canvas | null

function drawBase(){
  if(!S.bmap || S.proj!=='xy' || !cur) return;
  const m = cur.m;
  const bmp = radarCache.get(S.key);
  if(m.rb && bmp){
    drawRadar(m, bmp);
  } else if(m.bg && bmp !== null){
    drawDensity(m);
  }
}
function worldRectScreen(){
  const b = cur.m.b;
  return { dx: sx(b[0]), dw: sx(b[3]) - sx(b[0]),
           dy: sy(-b[4]), dh: sy(-b[1]) - sy(-b[4]) };
}
function drawRadar(m, bmp){
  const bb = m.rbb || [0,0,1,1];
  const r = worldRectScreen();
  ctx.save();
  ctx.globalAlpha = S.bop;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, bb[0]*bmp.width, bb[1]*bmp.height,
                (bb[2]-bb[0])*bmp.width, (bb[3]-bb[1])*bmp.height, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}
function drawDensity(m){
  let c = densCache.has(S.key) ? densCache.get(S.key) : undefined;
  if(c === undefined){
    c = buildDensityCanvas(m.bg);
    densCache.set(S.key, c);
  }
  if(!c) return;
  const r = worldRectScreen();
  ctx.save();
  ctx.globalAlpha = S.bop;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}
function buildDensityCanvas(rec){
  try{
    const u8 = BIN.subarray(rec[0], rec[0] + rec[1]);
    const res = (DATA.meta && DATA.meta.bg_res) || 128;
    const cvs = document.createElement('canvas');
    cvs.width = res; cvs.height = res;
    const c2 = cvs.getContext('2d');
    const img = c2.createImageData(res, res);
    const d = img.data;
    // 4 级灰蓝地形填充（数据行序 = world y 升序 → 屏幕需上下翻转）
    const LV = [[0,0,0,0],[126,136,160,34],[106,118,146,70],[86,98,128,112]];
    for(let iy=0; iy<res; iy++){
      const dstRow = res-1-iy;
      for(let ix=0; ix<res; ix++){
        const i = iy*res+ix;
        const lv = (u8[i>>2] >> ((i&3)*2)) & 3;
        if(!lv) continue;
        const di = (dstRow*res+ix)*4;
        const c = LV[lv];
        d[di]=c[0]; d[di+1]=c[1]; d[di+2]=c[2]; d[di+3]=c[3];
      }
    }
    c2.putImageData(img, 0, 0);
    return cvs;
  }catch(e){ return null; }
}
function loadRadar(m){
  if(!m.rb || radarCache.has(S.key)){ draw(); return; }
  radarCache.set(S.key, null);
  try{
    const u8 = BIN.subarray(m.rb[0], m.rb[0] + m.rb[1]);
    createImageBitmap(new Blob([u8], {type:'image/webp'})).then(bmp=>{
      radarCache.set(S.key, bmp);
      draw();
    }).catch(()=>{ draw(); });
  }catch(e){ draw(); }
}

/* ============================ 画布 ============================ */
const cv = $('cv'), ctx = cv.getContext('2d');
let W=0,H=0,DPR=1;

function resize(){
  DPR = window.devicePixelRatio || 1;
  const r = cv.parentElement.getBoundingClientRect();
  W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
  cv.width = Math.round(W*DPR); cv.height = Math.round(H*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  if(S.mode === '3d'){ render3D(); } else { draw(); }
}
window.addEventListener('resize', resize);

/* 键盘：R 复位 / T 俯视 / Esc 取消选中 */
window.addEventListener('keydown', e=>{
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea') return;
  const k = e.key.toLowerCase();
  if(k === 'r' && S.mode === '3d'){ resetCam(); render3D(); }
  else if(k === 't' && S.mode === '3d'){ topCam(); }
  else if(k === 'escape'){
    $('edetail').style.display='none';
    if(S.sel){ S.sel = null; build3D(); render3D(); draw(); }
  }
});

function fit(){
  if(!W || !H){ setTimeout(fit, 60); return; }
  const b = cur.b;
  const p0 = proj(b[0], b[1], b[2]);
  const p1 = proj(b[3], b[4], b[5]);
  const sw = Math.max(1, Math.abs(p1[0]-p0[0])), sh = Math.max(1, Math.abs(p1[1]-p0[1]));
  view.s = Math.min(W/(sw*1.18), H/(sh*1.18));
  view.ox = W/2 - (p0[0]+p1[0])/2*view.s;
  view.oy = H/2 - (p0[1]+p1[1])/2*view.s;
  draw();
}
const sx = px => px*view.s + view.ox;
const sy = py => py*view.s + view.oy;

function draw(){
  ctx.clearRect(0,0,W,H);
  if(!cur) return;
  const gmap={}; DATA.groups.forEach(g=>gmap[g.id]=g);
  const zmin = cur.m.fb[2], zmax = cur.m.fb[5], zr = Math.max(1, zmax-zmin);

  drawBase();

  // 顺序：先大后小 / 高信号置顶
  const order = ['env','misc','prop','item','spawn','logic','path','mech','trig','hurt','break','tele'];
  const base = S.psize;

  if(S.glow){
    ctx.globalCompositeOperation = 'lighter';
    forEachDrawable(gmap, (o,g)=>{
      if(o.gid!=='env' && stageOk(o)){
        const g2 = ctx.createRadialGradient(sx(o.px),sy(o.py),0,sx(o.px),sy(o.py), base*9);
        g2.addColorStop(0, hexA(g.color,.13)); g2.addColorStop(1, hexA(g.color,0));
        ctx.fillStyle=g2;
        ctx.beginPath(); ctx.arc(sx(o.px),sy(o.py), base*9, 0, 6.2832); ctx.fill();
      }
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  for(const gid of order){
    const g = gmap[gid]; if(!g) continue;
    if(S.off.has(gid) || (S.solo && S.solo!==gid)) continue;
    const r = Math.max(0.7, base*(g.r||1));
    for(const o of cur.pts){
      if(o.gid!==gid) continue;
      if(!stageOk(o)) continue;
      ctx.fillStyle = S.hcol ? ramp((o.z-zmin)/zr) : g.color;
      ctx.beginPath(); ctx.arc(sx(o.px), sy(o.py), r, 0, 6.2832); ctx.fill();
    }
  }
  if(S.sel){
    const o = S.sel;
    ctx.strokeStyle = '#ff3d7f'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(sx(o.px), sy(o.py), Math.max(7, base*3.6), 0, 6.2832); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx(o.px)-10, sy(o.py)); ctx.lineTo(sx(o.px)+10, sy(o.py));
    ctx.moveTo(sx(o.px), sy(o.py)-10); ctx.lineTo(sx(o.px), sy(o.py)+10);
    ctx.stroke();
  }
  drawHud();
}
function forEachDrawable(gmap, fn){
  for(const o of cur.pts){
    const g = gmap[o.gid]; if(!g) continue;
    if(S.off.has(o.gid) || (S.solo && S.solo!==o.gid)) continue;
    if(!stageOk(o)) continue;
    fn(o,g);
  }
}
function hexA(h,a){
  const n = parseInt(h.slice(1),16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function ramp(t){
  t = Math.max(0, Math.min(1, t));
  const st = [[0.0,96,165,250],[0.35,52,211,153],[0.6,250,204,21],[0.8,251,146,60],[1.0,239,68,68]];
  for(let i=0;i<st.length-1;i++){
    const a=st[i], b=st[i+1];
    if(t>=a[0] && t<=b[0]){
      const u=(t-a[0])/(b[0]-a[0]||1);
      return `rgb(${Math.round(a[1]+(b[1]-a[1])*u)},${Math.round(a[2]+(b[2]-a[2])*u)},${Math.round(a[3]+(b[3]-a[3])*u)})`;
    }
  }
  return 'rgb(239,68,68)';
}
function drawHud(){
  $('zoomlab').textContent = Math.round(view.s*100)+'%';
  const want = 96/view.s;                      // 想要约 96px 的标尺
  const nice = [128,256,512,1024,2048,4096,8192,16384];
  let pick = nice[0];
  for(const n of nice) if(n<=want) pick=n;
  const px = pick*view.s;
  $('sbline').style.width = Math.max(20,px)+'px';
  $('sblab').textContent = pick>=1024 ? (pick/1024)+'k u' : pick+' u';
  $('north').style.display = S.proj==='xy' ? '' : 'none';
}

/* =====================================================================
   ★ 3D 视图：场景构建 / 相机 / 拾取 / 渲染
   ===================================================================== */
const cv3 = $('cv3');
let GLok = false, GLerr = '';

function init3D(){
  GLok = GL3D.init(cv3);
  if(!GLok){
    GLerr = window.__glerr || '浏览器不支持 WebGL';
    const e = $('glerr');
    e.style.display = 'flex';
    e.innerHTML = '<div>⚠️ 3D 视图不可用：' + esc(GLerr) + '</div>' +
      '<div style="color:var(--ink3)">已自动切换到「平面」视图。请用较新的 Chrome / Edge 打开。</div>';
    setMode('2d');
    return;
  }
  size3D();
}
function size3D(){
  const r = cv3.parentElement.getBoundingClientRect();
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if(cv3.width !== w || cv3.height !== h){ cv3.width = w; cv3.height = h; }
}

/* --- 构建当前图的 3D 场景 --- */
let BOXES = [];
function build3D(){
  if(!GLok || !cur) return;
  const m = cur.m;
  const b = S.full ? m.fb : m.b;
  const gmap = {}; DATA.groups.forEach(g => gmap[g.id] = g);
  const clsG = CLS.map(c => gidOf(c));
  const half = DATA.clsHalf || [];
  const zLo = m.fb[2], zHi = m.fb[5], zR = Math.max(1, zHi - zLo);
  const cutZ = zLo + zR * S.cutz;

  const boxes = [];
  const parr = [];
  for(const o of cur.pts){
    if(S.off.has(o.gid) || (S.solo && S.solo !== o.gid)) continue;
    if(!stageOk(o)) continue;
    const g = gmap[o.gid]; if(!g) continue;
    const rgb = hex2rgb(S.hcol ? ramp((o.z - zLo) / zR) : g.color);
    // 高度剖切：只画下半部分（看内部触发区）
    if(o.z > cutZ && o.gid !== 'env') continue;

    if(o.gid === 'env' || o.gid === 'logic' || o.gid === 'misc' || o.gid === 'item' ||
       o.gid === 'spawn' || o.gid === 'prop') {
      // 轻量：用点精灵（世界 X=Source X，Y(上)=Source Z，Z=−Source Y）
      parr.push(o.x, o.z, -o.y, rgb[0]/255, rgb[1]/255, rgb[2]/255,
                o.gid === 'env' ? 0.55 : 1.0);
    } else {
      // 玩法实体：实体块（统一材质 + 类别色）
      const h = half[o.ci] || [30,30,30];
      const isSel = (S.sel === o);
      boxes.push({
        x:o.x, y:o.z, z:-o.y,
        ex:h[0], ey:h[2], ez:h[1],
        c: isSel ? [1.0,0.24,0.50] : [rgb[0]/255, rgb[1]/255, rgb[2]/255],
        a: isSel ? 1.0 : (o.gid === 'tele' ? S.bopa*0.72 : S.bopa),
        s: isSel,
        o: o,
      });
    }
  }
  if(!S.vbox) boxes.length = 0;
  BOXES = boxes;
  GL3D.setBoxes(boxes);
  GL3D.setPoints(new Float32Array(parr));
  $('v3info').innerHTML = `<b>${fmt(boxes.length)}</b> 块 · <b>${fmt(parr.length/7)}</b> 点`;
}
function hex2rgb(h){
  if(h[0] === '#'){
    const n = parseInt(h.slice(1), 16);
    return [(n>>16)&255, (n>>8)&255, n&255];
  }
  const m = h.match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [150,150,150];
}
/* 关卡下拉：从当前图的实体里收集关卡号，并记录每关包围盒（用于选中后聚焦） */
let stageBounds = null;
function buildStageSel(){
  const sel = $('stagesel');
  const st = new Set();
  stageBounds = {};
  if(cur) for(const o of cur.pts){
    if(!o.sg) continue;
    st.add(o.sg);
    let b = stageBounds[o.sg];
    if(!b) stageBounds[o.sg] = [o.x, o.y, o.z, o.x, o.y, o.z];
    else {
      if(o.x<b[0])b[0]=o.x; if(o.y<b[1])b[1]=o.y; if(o.z<b[2])b[2]=o.z;
      if(o.x>b[3])b[3]=o.x; if(o.y>b[4])b[4]=o.y; if(o.z>b[5])b[5]=o.z;
    }
  }
  const arr = [...st].sort((a,b)=>a-b);
  let html = '<option value="0">全部（' + (cur ? fmt(cur.pts.length) : 0) + ' 个实体）</option>';
  for(const n of arr){
    const c = cur.pts.reduce((a,o)=>a+(o.sg===n?1:0), 0);
    html += `<option value="${n}">第 ${n} 关（${fmt(c)}）</option>`;
  }
  if(arr.length) html += '<option value="-1">未标注关卡</option>';
  sel.innerHTML = html;
  sel.value = '0';
  $('rowsg').style.display = arr.length ? '' : 'none';
}
/* 选中关卡后把视角聚焦到该关区域 */
function focusStage(){
  if(!cur) return;
  const b = (S.stage > 0 && stageBounds) ? stageBounds[S.stage] : null;
  if(!b){
    if(S.mode === '3d'){ resetCam(); render3D(); } else fit();
    return;
  }
  const x0=b[0], y0=b[1], z0=b[2], x1=b[3], y1=b[4], z1=b[5];
  if(S.mode === '3d'){
    CAM.tx = (x0+x1)/2; CAM.ty = (z0+z1)/2; CAM.tz = -(y0+y1)/2;
    const span = Math.max(x1-x0, y1-y0, z1-z0, 256);
    CAM.dist = Math.max(300, span * 1.5);
    CAM.fogK = 0.22 / Math.max(span * 2.2, 600);
    render3D();
  } else {
    const p0 = proj(x0,y0,z0), p1 = proj(x1,y1,z1);
    const sw = Math.max(1, Math.abs(p1[0]-p0[0])), sh = Math.max(1, Math.abs(p1[1]-p0[1]));
    view.s = Math.min(W/(sw*1.35), H/(sh*1.35));
    view.ox = W/2 - (p0[0]+p1[0])/2*view.s;
    view.oy = H/2 - (p0[1]+p1[1])/2*view.s;
    draw();
  }
}
/* 复位相机：按包围盒自适应 */
function resetCam(){
  if(!cur) return;
  const b = S.full ? cur.m.fb : cur.m.b;
  const x0 = Math.min(b[0], b[3]), x1 = Math.max(b[0], b[3]);
  const y0 = Math.min(b[1], b[4]), y1 = Math.max(b[1], b[4]);
  const z0 = Math.min(b[2], b[5]), z1 = Math.max(b[2], b[5]);
  CAM.tx = (x0 + x1) / 2;
  CAM.tz = -(y0 + y1) / 2;
  CAM.ty = (z0 + z1) / 2;
  const span = Math.max(x1-x0, y1-y0, z1-z0, 256);
  CAM.dist = span * 1.30;
  CAM.span = span;
  CAM.yaw = -Math.PI/2; CAM.pitch = 0.62;
  CAM.fogK = 0.22 / span;
  CAM.ready = true;
}
function topCam(){
  CAM.yaw = -Math.PI/2; CAM.pitch = Math.PI/2 - 0.001;
  render3D();
}

/* --- 3D 渲染 --- */
function render3D(){
  if(!GLok || !cur) return;
  size3D();
  const { eye, vp } = camVP();
  GL3D.setVP(vp);
  GL3D.draw({
    vp, eye,
    alpha: 1.0,
    px: W / 700,
    pAlpha: 0.85,
    solid: S.vbox,
    fogK: CAM.fogK, fog: CAM.fog,
  });
  drawGrid(vp);
  drawAxis();
}
/* 地面网格 + 高度参考框（帮助建立三维空间感） */
function drawGrid(vp){
  const b = S.full ? cur.m.fb : cur.m.b;
  const x0 = Math.min(b[0], b[3]), x1 = Math.max(b[0], b[3]);
  const y0 = Math.min(b[1], b[4]), y1 = Math.max(b[1], b[4]);
  const z0 = Math.min(b[2], b[5]), z1 = Math.max(b[2], b[5]);
  const span = Math.max(x1-x0, y1-y0, z1-z0, 1);
  let step = Math.pow(10, Math.round(Math.log10(span/10)));
  if(span/step > 18) step *= 2;
  const gx0 = Math.floor(x0/step)*step, gx1 = Math.ceil(x1/step)*step;
  const gy0 = Math.floor(y0/step)*step, gy1 = Math.ceil(y1/step)*step;
  const arr = [];
  // z 轴朝上 → 世界 Y = Source Z
  const gy = z0;
  const cA = [0.80,0.82,0.87], cB = [0.72,0.74,0.80];
  for(let x = gx0; x <= gx1 + 1e-6; x += step){
    arr.push(x, gy, -y0, cB[0],cB[1],cB[2], x, gy, -y1, cB[0],cB[1],cB[2]);
  }
  for(let y = gy0; y <= gy1 + 1e-6; y += step){
    arr.push(x0, gy, -y, cB[0],cB[1],cB[2], x1, gy, -y, cB[0],cB[1],cB[2]);
  }
  // 高度范围竖直参考线（四角）
  const zt = z1;
  const corners = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  for(const [cx, cy] of corners){
    arr.push(cx, gy, -cy, cA[0],cA[1],cA[2], cx, zt, -cy, cA[0],cA[1],cA[2]);
  }
  GL3D.drawLines(new Float32Array(arr), 0.42);
}
/* 右上角方位指示（X/Y 轴 + 高度轴） */
function drawAxis(){
  const c = $('axis'), g = c.getContext('2d');
  const W2 = c.width, H2 = c.height, R = 44;
  g.clearRect(0,0,W2,H2);
  const eye = camEye();
  const dirs = [
    {v:[1,0,0], t:'X', col:'#ef4444'},
    {v:[0,0,-1], t:'Y', col:'#22c55e'},
    {v:[0,1,0], t:'Z', col:'#3b82f6'},
  ];
  // 简单正交投影：用相机方向做基
  const f = [CAM.tx-eye[0], CAM.ty-eye[1], CAM.tz-eye[2]];
  const fl = Math.hypot(...f) || 1; const fw = f.map(x=>x/fl);
  let rt = [fw[2], 0, -fw[0]]; const rl = Math.hypot(...rt) || 1; rt = rt.map(x=>x/rl);
  const up = [rt[1]*fw[2]-rt[2]*fw[1], rt[2]*fw[0]-rt[0]*fw[2], rt[0]*fw[1]-rt[1]*fw[0]];
  g.lineWidth = 3;
  g.lineCap = 'round';
  for(const d of dirs){
    const x = d.v[0]*rt[0] + d.v[1]*rt[1] + d.v[2]*rt[2];
    const y = d.v[0]*up[0] + d.v[1]*up[1] + d.v[2]*up[2];
    const sx2 = W2/2 + x*R, sy2 = H2/2 - y*R;
    g.strokeStyle = d.col; g.beginPath();
    g.moveTo(W2/2, H2/2); g.lineTo(sx2, sy2); g.stroke();
    g.fillStyle = d.col; g.font = 'bold 22px sans-serif';
    g.textAlign='center'; g.textBaseline='middle';
    g.fillText(d.t, W2/2 + x*(R+13), H2/2 - y*(R+13));
  }
}

/* --- 3D 交互 --- */
let drag3 = null;
cv3.addEventListener('contextmenu', e => e.preventDefault());
cv3.addEventListener('pointerdown', e => {
  if(!GLok) return;
  cv3.setPointerCapture(e.pointerId);
  cv3.classList.add('grabbing');
  drag3 = { x:e.clientX, y:e.clientY, yaw:CAM.yaw, pitch:CAM.pitch,
            tx:CAM.tx, ty:CAM.ty, tz:CAM.tz,
            pan: (e.button === 2 || e.shiftKey) };
});
cv3.addEventListener('pointerup', e => {
  if(drag3){
    const moved = Math.abs(e.clientX-drag3.x) + Math.abs(e.clientY-drag3.y);
    if(moved < 4 && !drag3.pan) pick3(e);
  }
  drag3 = null; cv3.classList.remove('grabbing');
});
cv3.addEventListener('pointermove', e => {
  if(!drag3) return;
  const dx = e.clientX - drag3.x, dy = e.clientY - drag3.y;
  if(drag3.pan){
    // 屏幕平移 → 世界平移（沿相机右向 / 上向）
    const eye = camEye();
    const f = [CAM.tx-eye[0], CAM.ty-eye[1], CAM.tz-eye[2]];
    const fl = Math.hypot(...f)||1; const fw = f.map(x=>x/fl);
    let rt = [fw[2], 0, -fw[0]]; const rl = Math.hypot(...rt)||1; rt = rt.map(x=>x/rl);
    const up = [rt[1]*fw[2]-rt[2]*fw[1], rt[2]*fw[0]-rt[0]*fw[2], rt[0]*fw[1]-rt[1]*fw[0]];
    const k = CAM.dist / Math.max(1, H) * 1.4;
    CAM.tx = drag3.tx - (rt[0]*dx - up[0]*dy) * k;
    CAM.ty = drag3.ty - (rt[1]*dx - up[1]*dy) * k;
    CAM.tz = drag3.tz - (rt[2]*dx - up[2]*dy) * k;
  } else {
    CAM.yaw = drag3.yaw - dx * 0.008;
    CAM.pitch = Math.max(-1.52, Math.min(1.52, drag3.pitch + dy * 0.008));
  }
  render3D();
});
cv3.addEventListener('wheel', e => {
  e.preventDefault();
  CAM.dist = Math.max(40, Math.min(60000, CAM.dist * (e.deltaY < 0 ? 1/1.13 : 1.13)));
  render3D();
}, {passive:false});

/* 3D 拾取：把所有块投影到屏幕，取最近命中 */
function pick3(e){
  if(!cur) return;
  const r = cv3.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const { vp } = camVP();
  const eye = camEye();
  let best = null, bd = 1e18;
  const lim = 13;
  for(const bo of BOXES){
    const p = projPt(vp, bo.x, bo.y, bo.z);
    if(!p) continue;
    const d = Math.hypot(p[0]-mx, p[1]-my);
    if(d > lim) continue;
    const dd = Math.hypot(bo.x-eye[0], bo.y-eye[1], bo.z-eye[2]);
    if(d < lim && dd < bd){ bd = dd; best = bo; }
  }
  if(best){
    const o = best.o;
    if(o){ selectEnt(o, false); build3D(); render3D(); }
  } else {
    $('edetail').style.display='none';
    if(S.sel){ S.sel = null; build3D(); render3D(); }
  }
}
function projPt(vp, x, y, z){
  const w = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
  if(w <= 0.001) return null;
  const cx = (vp[0]*x + vp[4]*y + vp[8]*z + vp[12]) / w;
  const cy = (vp[1]*x + vp[5]*y + vp[9]*z + vp[13]) / w;
  return [(cx*0.5+0.5)*W, (0.5-cy*0.5)*H];
}

function setMode(m){
  S.mode = m;
  [].forEach.call($('mode').children, b => b.classList.toggle('on', b.dataset.m === m));
  const is3 = m === '3d' && GLok;
  $('stage3d').classList.toggle('on', is3);
  cv.style.display = is3 ? 'none' : 'block';
  // 2D 专属控件在 3D 下隐藏：投影切换 / 高度着色 / 点径 / 光晕 / 底图行 / 2D HUD
  $('proj').style.display = is3 ? 'none' : '';
  $('broww').style.display = is3 ? 'none' : '';
  document.querySelectorAll('.ctl').forEach(el => {
    const id = el.querySelector('input') && el.querySelector('input').id;
    el.style.display = (is3 && (id === 'psize' || id === 'glow' || id === 'full' || id === 'hcol'))
      ? 'none' : '';
  });
  document.querySelector('.hud').style.display = is3 ? 'none' : '';
  // 3D 专属行
  $('row3da').style.display = is3 ? '' : 'none';
  $('row3db').style.display = is3 ? '' : 'none';
  if(is3){ render3D(); }
  else { resize(); }
}

/* ============================ 实体选中 / 详情 / 搜索 ============================ */
function groupColor(gid){
  const g = DATA.groups.find(x=>x.id===gid);
  return g ? g.color : '#999';
}
function selectEnt(o, focus){
  S.sel = o;
  showDetail(o);
  if(focus){
    if(S.mode === '3d'){
      // 3D：把相机目标移到实体上，并拉近
      CAM.tx = o.x; CAM.ty = o.z; CAM.tz = -o.y;
      CAM.dist = Math.max(220, Math.min(CAM.dist, (cur && cur.m ? Math.max(1, (cur.m.fb[5]-cur.m.fb[2])) : 400) * 1.1));
      build3D(); render3D();
      return;
    }
    if(view.s < 1.4) view.s = 1.4;
    view.ox = W/2 - o.px*view.s;
    view.oy = H/2 - o.py*view.s;
  }
  draw();
  if(S.mode === '3d'){ build3D(); render3D(); }
}
/* 属性 / 连线在数据构建期就已解析成可读文本，这里直接用：
 *   A2[i] = [[键名, 值], ...]        C2[i] = [[输出, 目标, 输入, 参数, 延迟], ...]
 */
function showDetail(o){
  const m = cur.m;
  let html = `<h5><span style="display:inline-block;width:9px;height:9px;border-radius:50%;
      background:${groupColor(o.gid)}"></span>${esc(o.cn)}
      <span class="close" id="edclose">✕</span></h5>`;
  if(o.nm) html += `<div class="dtx">名称 <b>${esc(o.nm)}</b></div>`;
  html += `<div class="dtx">坐标 <b>${Math.round(o.x)}, ${Math.round(o.y)}, ${Math.round(o.z)}</b> · 高度 ${Math.round(o.z)}</div>`;
  if(o.sg) html += `<div class="dtx">所属关卡 <b style="color:#d4547e">第 ${o.sg} 关</b>${o.sgp?'<span style="color:var(--ink3)">（按就近推断）</span>':''}</div>`;
  const attrs = (o.ai>=0 && m.A2 && m.A2[o.ai]) || [];
  if(attrs.length){
    html += `<div class="sec">属性</div><table>` +
      attrs.map(a=>`<tr><td>${esc(a[0])}</td><td><b>${esc(String(a[1]))}</b></td></tr>`).join('') +
      `</table>`;
  }
  const cxs = (o.gi>=0 && m.C2 && m.C2[o.gi]) || [];
  if(cxs.length){
    html += `<div class="sec">触发连接 ${cxs.length} 条</div>` + cxs.map(c=>
      `<div class="cx"><b>${esc(c[0])}</b> → ${esc(c[1])} : ${esc(c[2])}` +
      (c[3]?` <span style="color:var(--ink3)">（${esc(c[3])}）</span>`:'') +
      (c[4]!==0&&c[4]!==''&&c[4]!=null?` <span style="color:var(--ink3)">延迟 ${esc(String(c[4]))}s</span>`:'') +
      `</div>`).join('');
  }
  if(!attrs.length && !cxs.length){
    html += `<div class="dtx" style="margin-top:6px;color:var(--ink3)">该实体无附加属性 / 连接记录</div>`;
  }
  const el = $('edetail');
  el.innerHTML = html;
  el.style.display = 'block';
  $('edclose').onclick = ()=>{ el.style.display='none'; S.sel=null; draw(); };
}
/* 实体搜索 */
function esRender(){
  const q = $('esq').value.trim().toLowerCase();
  const box = $('esres');
  if(!q || !cur){ box.style.display='none'; box.__hits=null; return; }
  const hits = [];
  for(const o of cur.pts){
    if((o.nm && o.nm.toLowerCase().includes(q)) || o.cn.toLowerCase().includes(q)){
      hits.push(o);
      if(hits.length>=60) break;
    }
  }
  hits.sort((a,b)=>(b.nm?1:0)-(a.nm?1:0));
  box.innerHTML = hits.length
    ? hits.map((o,i)=>`<div class="esr" data-i="${i}">
        <span class="dot" style="background:${groupColor(o.gid)}"></span>
        <span class="en">${esc(o.nm||o.cn)}</span>
        <span class="ec">${esc(o.cn)}${o.sg?' · S'+o.sg:''}${o.nm?' · ['+Math.round(o.x)+', '+Math.round(o.y)+', '+Math.round(o.z)+']':''}</span>
      </div>`).join('')
    : '<div class="esr"><span class="ec">当前地图无匹配实体</span></div>';
  box.__hits = hits;
  box.style.display = 'block';
}
$('esq').addEventListener('input', esRender);
$('esq').addEventListener('keydown', e=>{ if(e.key==='Escape'){ $('esres').style.display='none'; } });
$('esres').addEventListener('click', e=>{
  const r = e.target.closest('.esr');
  if(!r || r.dataset.i===undefined || !$('esres').__hits) return;
  const o = $('esres').__hits[+r.dataset.i];
  if(!o) return;
  $('esres').style.display='none';
  selectEnt(o, true);
});

/* ============================ 交互 ============================ */
let drag=null, downPos=null;
cv.addEventListener('mousedown', e=>{ downPos=[e.clientX,e.clientY]; drag={x:e.clientX,y:e.clientY,ox:view.ox,oy:view.oy}; cv.style.cursor='grabbing'; });
window.addEventListener('mouseup', ()=>{ drag=null; cv.style.cursor='crosshair'; });
cv.addEventListener('click', e=>{
  if(downPos && (Math.abs(e.clientX-downPos[0])>4 || Math.abs(e.clientY-downPos[1])>4)) return;
  if(!cur) return;
  const r = cv.getBoundingClientRect();
  const o = pick(e.clientX-r.left, e.clientY-r.top);
  if(o){ selectEnt(o, false); }
  else { $('edetail').style.display='none'; if(S.sel){ S.sel=null; draw(); } }
});
cv.addEventListener('mousemove', e=>{
  if(drag){
    view.ox = drag.ox + (e.clientX-drag.x);
    view.oy = drag.oy + (e.clientY-drag.y);
    draw(); hideTip(); return;
  }
  hover(e);
});
cv.addEventListener('mouseleave', hideTip);
cv.addEventListener('wheel', e=>{
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX-r.left, my = e.clientY-r.top;
  const wx = (mx-view.ox)/view.s, wy = (my-view.oy)/view.s;
  const f = e.deltaY<0 ? 1.15 : 1/1.15;
  view.s = Math.max(0.02, Math.min(40, view.s*f));
  view.ox = mx - wx*view.s; view.oy = my - wy*view.s;
  draw(); hideTip();
}, {passive:false});
cv.addEventListener('dblclick', fit);

function pick(mx,my){
  if(!cur) return null;
  const gmap={}; DATA.groups.forEach(g=>gmap[g.id]=g);
  const wx=(mx-view.ox)/view.s, wy=(my-view.oy)/view.s;
  const cx=Math.floor(wx/cur.cell), cy=Math.floor(wy/cur.cell);
  let best=null, bd=1e18;
  const lim = (10/view.s)**2;
  for(let i=-1;i<=1;i++) for(let j=-1;j<=1;j++){
    const arr = cur.grid.get((cx+i)+':'+(cy+j)); if(!arr) continue;
    for(const o of arr){
      const g=gmap[o.gid]; if(!g) continue;
      if(S.off.has(o.gid) || (S.solo && S.solo!==o.gid)) continue;
      if(!stageOk(o)) continue;
      const d=(o.px-wx)**2+(o.py-wy)**2;
      if(d<bd){bd=d;best=o;}
    }
  }
  return (best && bd<=Math.max(lim, 400/view.s)) ? best : null;
}
function hover(e){
  const r = cv.getBoundingClientRect();
  const mx=e.clientX-r.left, my=e.clientY-r.top;
  const o = pick(mx,my);
  if(!o){ hideTip(); return; }
  const g = DATA.groups.find(x=>x.id===o.gid);
  $('tip').innerHTML =
    `<b>${esc(g?g.label:o.gid)}</b><br>` +
    `类别 <i>${esc(o.cn)}</i>` +
    (o.nm?`<br>名称 <i>${esc(o.nm)}</i>`:'') +
    `<br>坐标 <i>${Math.round(o.x)}, ${Math.round(o.y)}, ${Math.round(o.z)}</i>` +
    `<br><span style="color:#d4547e">单击查看属性详情</span>`;
  $('tip').style.display='block';
  const tw = $('tip').offsetWidth, th = $('tip').offsetHeight;
  let lx = mx+14, ly = my+14;
  if(lx+tw > W-6) lx = mx-tw-14;
  if(ly+th > H-6) ly = Math.max(4, my-th-14);
  $('tip').style.left=lx+'px'; $('tip').style.top=ly+'px';
}
function hideTip(){ $('tip').style.display='none'; }

/* 图层点击 */
$('lbody').addEventListener('click', e=>{
  const li = e.target.closest('.li'); if(!li) return;
  const g = li.dataset.g;
  if(e.detail>1){ S.solo = (S.solo===g) ? null : g; }
  else {
    if(S.off.has(g)){ S.off.delete(g); if(S.solo===g) S.solo=null; }
    else S.off.add(g);
  }
  renderLayers(); draw();
});

/* 图层悬停说明（点云层 + 面板内功能行） */
const GDESC = {
  tele:  {desc:'传送触发区与传送目的地。人类玩家踩中后被瞬间送往下一区域；成串出现通常就是关卡切换点或捷径入口，是读路线的第一入口。',cls:'trigger_teleport · info_teleport_destination · point_teleport'},
  break: {desc:'可被打碎的墙板、玻璃、木板、栅栏与物理道具。打碎后常开辟新路或露出隐藏房，部分地图靠炸墙改道。',cls:'func_breakable(_surf) · prop_physics · func_physbox'},
  hurt:  {desc:'持续掉血区与火焰、爆炸点。用于判断哪里不能停留、该跳该绕；单击实体可在详情卡看具体伤害数值（如 999999 即摸即死）。',cls:'trigger_hurt · env_fire · env_explosion'},
  trig:  {desc:'隐形的关卡开关：玩家进入后触发关门、刷怪、推动、胜利判定等事件。本身不可见，是理解关卡流程的关键。',cls:'trigger_once / multiple / push · func_ladder'},
  mech:  {desc:'可交互机关：按钮、平移/旋转门、电梯、旋转体等。决定通行与解谜方式，常与触发区、逻辑节点联动。',cls:'func_button · func_door · func_movelinear · func_rotating'},
  path:  {desc:'轨道路径节点：移动墙、载具、逃跑车等沿这些点运动。末段的「逃跑线」常是最终逃脱路线，跟着节点走即可。',cls:'path_track · path_corner'},
  logic: {desc:'无实体体积的逻辑中枢，相当于地图的程序代码，串联触发与机关；只表示事件流的枢纽位置，场景里看不到。',cls:'logic_relay / case / timer · math_counter'},
  spawn: {desc:'玩家出生与复活位置。开局站位、重生点与防守压力分布的参考。',cls:'info_player_start · info_player_terrorist / counterterrorist'},
  item:  {desc:'武器与道具生成点。捡补给、拿装备的位置参考。',cls:'weapon_* · item_* · game_*'},
  prop:  {desc:'装饰与动态模型：雕像、招牌、场景摆设等视觉元素，一般不影响玩法；可打碎的物理道具已归入「可破坏物」。',cls:'prop_dynamic · prop_static · prop_ragdoll'},
  env:   {desc:'灯光、粒子、音效、天空盒等环境实体，不参与玩法；抽样后其分布用于生成「地形轮廓」密度底图。',cls:'light_* · info_particle_system · ambient_generic'},
  misc:  {desc:'未归入上述类别的杂项实体，通常数量极少。',cls:'其余 classname'}
};
const ltipEl = $('ltip');
let ltipRow = null;
function ltipShow(row){
  if(ltipRow === row) return;
  ltipRow = row;
  let html = '';
  if(row.classList && row.classList.contains('li')){
    const gid = row.dataset.g;
    const g = DATA.groups.find(x=>x.id===gid);
    const d = GDESC[gid] || {desc:'',cls:''};
    const n = cur ? (cur.groups[gid]||0) : 0;
    html = `<span class="lt-head"><span class="lt-dot" style="background:${g?g.color:'#999'}"></span>`+
           `<b>${esc(g?g.label:gid)} · ${fmt(n)} 个点</b></span>`+
           (d.desc?`<br>${d.desc}`:'')+
           (d.cls?`<span class="lt-cls">典型类别：${esc(d.cls)}</span>`:'');
  } else {
    html = `<b>${esc(row.dataset.lt||'')}</b><br>${esc(row.dataset.desc||'')}`;
  }
  ltipEl.innerHTML = html;
  ltipEl.style.display = 'block';
  const r = row.getBoundingClientRect();
  const tw = ltipEl.offsetWidth, th = ltipEl.offsetHeight;
  let lx = r.left - tw - 10;
  if(lx < 8) lx = Math.min(r.right + 10, window.innerWidth - tw - 8);
  let ly = Math.min(Math.max(r.top, 8), window.innerHeight - th - 8);
  ltipEl.style.left = lx+'px'; ltipEl.style.top = ly+'px';
}
function ltipHide(){ ltipRow = null; ltipEl.style.display = 'none'; }
$('layers').addEventListener('mouseover', e=>{
  const li = e.target.closest('.li');
  const row = li || e.target.closest('[data-desc]');
  if(row) ltipShow(row);
});
$('layers').addEventListener('mouseleave', ltipHide);

/* 工具栏 */
$('mode').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  setMode(b.dataset.m);
});
$('proj').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  S.proj = b.dataset.p;
  [].forEach.call($('proj').children, x=>x.classList.toggle('on', x===b));
  if(S.key) loadMap(S.key);
});
$('hcol').addEventListener('change', e=>{ S.hcol=e.target.checked; draw(); if(S.mode==='3d'){ build3D(); render3D(); } });
$('glow').addEventListener('change', e=>{ S.glow=e.target.checked; draw(); });
$('full').addEventListener('change', e=>{ S.full=e.target.checked; if(S.key) loadMap(S.key); });
$('psize').addEventListener('input', e=>{ S.psize=parseFloat(e.target.value); draw(); });
$('vbox').addEventListener('change', e=>{ S.vbox=e.target.checked; build3D(); render3D(); });
$('bopa').addEventListener('input', e=>{ S.bopa=e.target.value/100; build3D(); render3D(); });
$('stagesel').addEventListener('change', e=>{
  S.stage = parseInt(e.target.value, 10) || 0;
  if(S.sel && !stageOk(S.sel)){ S.sel = null; $('edetail').style.display='none'; }
  renderLayers(); renderStats();
  draw();
  if(S.mode === '3d') build3D();
  focusStage();
});
$('cutz').addEventListener('input', e=>{
  S.cutz = e.target.value/100;
  $('cutzv').textContent = e.target.value + '%';
  build3D(); render3D();
});
$('fit').addEventListener('click', ()=>{ if(S.mode==='3d'){ resetCam(); render3D(); } else fit(); });
$('png').addEventListener('click', ()=>{
  if(!cur) return;
  const src = (S.mode==='3d' && GLok) ? cv3 : cv;
  const a=document.createElement('a');
  a.download = '地图实体预览_'+(cur.m.cn||cur.m.m)+'_'+S.mode+'.png';
  a.href = src.toDataURL('image/png'); a.click();
});
$('q').addEventListener('input', buildSide);
document.querySelectorAll('.side-tools button').forEach(b=>{
  b.addEventListener('click', ()=>{
    S.sort = b.dataset.sort;
    document.querySelectorAll('.side-tools button').forEach(x=>x.classList.toggle('on', x===b));
    buildSide();
  });
});
/* 窄屏抽屉：侧栏默认收起，选图后自动关闭 */
function setSide(open){
  const aside = document.querySelector('aside');
  const scrim = $('side-scrim');
  if(!aside) return;
  aside.classList.toggle('open', open);
  if(scrim) scrim.classList.toggle('open', open);
  clearTimeout(setSide._t);
  setSide._t = setTimeout(()=>window.dispatchEvent(new Event('resize')), 260);
}
$('side-toggle')?.addEventListener('click', ()=>{
  const aside = document.querySelector('aside');
  setSide(!(aside && aside.classList.contains('open')));
});
$('side-scrim')?.addEventListener('click', ()=>setSide(false));

$('maps').addEventListener('click', e=>{
  const mi = e.target.closest('.mi'); if(!mi) return;
  const entry = entryOf(mi.dataset.k); if(!entry) return;
  setSide(false);
  $('lmsg').textContent = '正在加载 '+(entry.cn||entry.m)+' …';
  $('loading').style.display = 'flex';
  openMap(entry).then(()=>{ syncUrl(entry.s); $('loading').style.display='none'; })
    .catch(err=>{ $('lmsg').innerHTML = '载入失败：'+esc(err.message); });
});
const lmodeEl = $('lmode');
if(lmodeEl) lmodeEl.addEventListener('change', ()=>{ S.listMode = lmodeEl.value; buildSide(); });
$('lclose').addEventListener('click', ()=>{ $('layers').style.display='none'; $('ltoggle').style.display='block'; ltipHide(); });
$('btoggle').addEventListener('click', ()=>{ S.bmap=!S.bmap; $('btoggle').classList.toggle('off',!S.bmap); draw(); });
$('bop').addEventListener('input', e=>{ S.bop=e.target.value/100; draw(); });
$('ltoggle').addEventListener('click', ()=>{ $('layers').style.display='flex'; $('ltoggle').style.display='none'; });

/* ============================ 启动 ============================ */
(async function(){
  try{
    CATALOG = await fetchCatalog();
  }catch(err){
    document.querySelector('.spin').style.display='none';
    $('lmsg').innerHTML = '目录加载失败：'+esc(err.message);
    return;
  }
  const meta = CATALOG.meta || {};
  $('hbadges').innerHTML =
    `<span class="badge">${CATALOG.count} 张地图（全部模式）</span>` +
    (meta.entities_all ? `<span class="badge">${fmt(meta.entities_all)} 实体</span>` : '') +
    (meta.entities_kept ? `<span class="badge">${fmt(meta.entities_kept)} 可绘点</span>` : '') +
    `<span class="badge">${(CATALOG.groups||[]).length} 个图层</span>` +
    (meta.built ? `<span class="badge">数据 ${esc(meta.built)}</span>` : '');
  buildSide();
  resize();
  init3D();

  // 窄屏：图层面板默认收起（否则会盖住大半张地图），并收起侧栏抽屉
  const narrow = window.innerWidth <= 820;
  if (narrow) {
    $('layers').style.display = 'none';
    $('ltoggle').style.display = 'block';
  }

  // 打开哪张图：?map=<slug|内部名|中文名>，否则挑一张「玩法实体最丰富」的
  const Q = new URLSearchParams(location.search);
  const wantMap = Q.get('map');
  let entry = null;
  if(wantMap){
    const w = wantMap.toLowerCase();
    entry = CATALOG.maps.find(m => m.s.toLowerCase() === w)
         || CATALOG.maps.find(m => m.m.toLowerCase() === w)
         || CATALOG.maps.find(m => m.m.toLowerCase().includes(w))
         || CATALOG.maps.find(m => (m.cn||'').toLowerCase().includes(w));
  }
  if(!entry){
    let best = null;
    for(const m of CATALOG.maps){
      if(m.a !== '2001') continue;
      const c = m.c || {};
      const sc = (c.tele||0)*4 + (c.break||0)*3 + (c.hurt||0)*3 + Math.min(c.mech||0,300) + (c.path||0)*2 + (c.trig||0)
               + (m.bg?25000:0) + (m.rb?40000:0);
      if(!best || sc>best[1]) best=[m,sc];
    }
    entry = best ? best[0] : CATALOG.maps[0];
  }
  try{ await openMap(entry); }
  catch(err){ $('lmsg').textContent = '载入失败：' + err.message; document.title = 'ERR ' + err.stack; }
  $('loading').style.display='none';
  // 默认 3D（若不支持 WebGL 已自动回落 2D）
  setMode(Q.get('view') === '2d' ? '2d' : '3d');
  // ?stage=N 直接选中关卡层（0=全部 / -1=未标注 / n=第 n 关）
  const qsg = new URLSearchParams(location.search).get('stage');
  if(qsg !== null && cur){
    const v = parseInt(qsg, 10);
    const sel = $('stagesel');
    if([...sel.options].some(op => op.value === String(v))){
      sel.value = String(v);
      sel.dispatchEvent(new Event('change'));
    }
  }
  // ?demo=1 自测：自动搜索并选中一个实体，便于截图验证
  if(new URLSearchParams(location.search).has('demo')){
    setTimeout(()=>{
      $('esq').value = 'trigger_hurt';
      esRender();
      setTimeout(()=>{
        if($('esres').__hits && $('esres').__hits.length){
          selectEnt($('esres').__hits[0], true);
          $('esres').style.display = 'none';
        }
      }, 400);
    }, 600);
  }
  // ?yaw= / ?pitch= 便于截图验证不同机位
  const qs = new URLSearchParams(location.search);
  if(qs.has('yaw') || qs.has('pitch')){
    if(qs.has('yaw')) CAM.yaw = parseFloat(qs.get('yaw'));
    if(qs.has('pitch')) CAM.pitch = parseFloat(qs.get('pitch'));
    if(qs.has('zoom')) CAM.dist *= parseFloat(qs.get('zoom'));
    render3D();
  }
  // ?ltip=<gid> 截图验证：强制显示某图层的悬停说明
  (function(){
    const v = qs.get('ltip');
    if(!v) return;
    setTimeout(()=>{
      const li = document.querySelector('.li[data-g="'+v+'"]') ||
                 document.querySelector('[data-lt]');
      if(li) ltipShow(li);
    }, 900);
  })();
})();
