/**
 * 账号系统（P4）的回归测试 —— `npm run test:worker`。
 *
 * 怎么做的：用 esbuild 把 `worker/index.ts` 打成一个 ESM bundle（Worker 的 TS 里
 * 只有 type import，节点里能直接跑），再用 `node:sqlite` 当 **D1 的替身** ——
 * 是**真 SQL**：`CREATE TABLE` / `PRAGMA table_info` / `RETURNING` / UPSERT 全都真跑，
 * 所以懒建表、限流、统计口径这些都能测到，不是打桩。然后直接
 * `worker.fetch(new Request(...))` 打接口，最后用 SQL 检查库里落了什么。
 *
 * 为什么这两个用例值得留着：
 *   · 「匿名投稿不能依赖 user_id 列」—— 老库没有这一列，写进 INSERT 列清单会让
 *     **还没人登录过时的第一条投稿**直接 500（账号系统把投稿拖垮）；
 *   · 「HMAC 的 hash 必填」—— `importKey(..., 'HMAC', ...)` 按规范会抛异常，注册接口整个 500。
 * 两个都是上线前在本地抓到的，不该有机会再回来。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(os.tmpdir(), `ze-worker-bundle-${process.pid}.mjs`);

buildSync({
  entryPoints: [path.join(ROOT, 'worker/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'node20',
  outfile: BUNDLE,
  logLevel: 'warning',
});
process.on('exit', () => fs.rmSync(BUNDLE, { force: true }));

/* ===== D1 替身（node:sqlite，语句都是真跑的） ===== */

/** 线上 0001：限流表 */
const SCHEMA_0001 = `
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL, window TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window)
);`;

/** 线上 0002：投稿表 —— **没有 user_id**，正是懒建表要补的那一列 */
const SCHEMA_0002 = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_slug TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
  note TEXT, submitter TEXT, contact TEXT, ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
  reviewed_at INTEGER, reviewer TEXT, reject_note TEXT, commit_sha TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions (status, created_at);
CREATE TABLE IF NOT EXISTS bans (ip_hash TEXT PRIMARY KEY, reason TEXT, banned_at INTEGER NOT NULL);`;

/** 线上 0003：账号表（只有「已经迁移过」的用例才预先建） */
const SCHEMA_0003 = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL, pass_ver INTEGER NOT NULL DEFAULT 1, contact TEXT,
  created_at INTEGER NOT NULL, last_login INTEGER, banned INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0);`;

const norm = (v) => (v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function makeD1({ migrated = false, empty = false } = {}) {
  const db = new DatabaseSync(':memory:');
  /* empty=true：完全空库（模拟「新建的 D1 / 本地 wrangler dev 第一次跑」）。
     2026-10-14 踩到的坑：ensureSchema 以前假定 submissions/bans 已存在，
     空库上补列那句 ALTER 会抛，把后面的 bans 一起带走 → isBanned 500。 */
  if (!empty) {
    db.exec(SCHEMA_0001);
    db.exec(SCHEMA_0002);
  }
  if (migrated) {
    db.exec(SCHEMA_0003);
    db.exec(`ALTER TABLE submissions ADD COLUMN user_id INTEGER`);
  }
  const DB = {
    prepare(sql) {
      /* 每次 prepare 都给个新对象，bind 可链式（和 D1 一样，不复用语句） */
      const make = (vals) => ({
        bind: (...v) => make(v),
        first: async () => db.prepare(sql).all(...vals.map(norm))[0] ?? null,
        all: async () => ({ results: db.prepare(sql).all(...vals.map(norm)) }),
        run: async () => db.prepare(sql).run(...vals.map(norm)),
      });
      return make([]);
    },
  };
  return { db, DB };
}

/* ===== 起一个「本地 Worker」 ===== */

const HOST = 'http://localhost:8787';
let loadSeq = 0;

async function setup(opts = {}) {
  /* 每个用例一份新的模块实例（换个 URL 查询串）—— 否则 ensureSchema 的 schemaReady
     会被上一个用例的库缓存住，懒建表就测不到了。 */
  const worker = (await import(pathToFileURL(BUNDLE).href + `?v=${++loadSeq}`)).default;
  const { db, DB } = makeD1(opts);
  const env = { DB, IP_SALT: 'test-salt', ASSETS: { fetch: async () => new Response('asset') } };
  /*
   * Cookie 罐：以前只盯 zc_sess，加了 GitHub 登录之后还要带上 zc_gh_state
   * （state Cookie 的 Path=/api/auth，回调请求照样会带；浏览器行为，测试里手动模拟）。
   * Max-Age=0 表示清除（登出、或回调结束时清 state）。
   */
  const jar = { cookies: new Map(), get cookie() {
    return [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  } };

  const call = async (pathname, { method = 'GET', body, cookie, ip, headers = {}, redirect = 'manual' } = {}) => {
    const useCookie = cookie !== undefined ? cookie : jar.cookie;
    const res = await worker.fetch(
      new Request(HOST + pathname, {
        method,
        redirect,
        headers: {
          origin: HOST,
          /* 默认同一个出口 IP；测限流时用 ip 换成别的，走的就是另一套桶 */
          'cf-connecting-ip': ip ?? '203.0.113.7',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(useCookie ? { cookie: useCookie } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env
    );
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const cleared = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (cleared || !value) jar.cookies.delete(name);
      else jar.cookies.set(name, value);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON（例如 HTML 500）：data 留 null，由断言去暴露 */
    }
    return { status: res.status, data, res, setCookies };
  };

  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => rows(sql, ...args)[0];

  return { worker, env, db, call, rows, one, jar };
}

const submitBody = (extra = {}) => ({
  map: 'ze_flowering',
  field: 'difficulty',
  value: '困难',
  submitter: '路人甲',
  contact: '',
  note: '',
  ...extra,
});

/** 注册并返回 userId（顺带把 Cookie 放进 jar） */
async function register(call, name, password = 'pass12345', contact = '') {
  const r = await call('/api/register', { method: 'POST', body: { name, password, contact } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}

/*
 * 假仓库：审核台写回 / 采纳要「读 data/ 再 commit」，本地不联网，所以把 globalThis.fetch 换成
 * 内存文件系统 —— 走真的 contents 读、真的 git data 写，写完的东西能立刻断言。
 * 用法：const repo = installFakeRepo({ 'data/research/x.json': '…' })，结束 repo.restore()。
 */
function installFakeRepo(files) {
  const prevFetch = globalThis.fetch;
  const jsonRes = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.includes('api.github.com')) return prevFetch(input, init);
    const key = Object.keys(files).find((k) => url.includes(k));
    if (url.includes('/contents/')) {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body ?? '{}'));
        files[key] = Buffer.from(String(body.content ?? ''), 'base64').toString('utf8');
        return jsonRes({ content: { sha: 'blobsha' } });
      }
      if (!key) return jsonRes({ message: 'Not Found' }, 404);
      return jsonRes({ content: Buffer.from(files[key], 'utf8').toString('base64'), sha: 'sha1' });
    }
    if (url.includes('/git/ref/heads/')) return jsonRes({ object: { sha: 'head1' } });
    if (url.includes('/git/commits/')) return jsonRes({ tree: { sha: 'tree1' } });
    if (url.includes('/git/trees')) {
      /* commitFiles 对文本文件是把内容**内联在 tree 条目**里提交的（不是走 /contents PUT） */
      const body = JSON.parse(String(init.body ?? '{}'));
      for (const entry of body.tree ?? []) {
        if (entry && typeof entry.path === 'string' && typeof entry.content === 'string') files[entry.path] = entry.content;
      }
      return jsonRes({ sha: 'tree2' });
    }
    if (url.includes('/git/commits')) return jsonRes({ sha: 'commit1' });
    if (url.includes('/git/refs/heads/')) return jsonRes({ object: { sha: 'commit1' } });
    return jsonRes({ message: 'unexpected ' + url }, 500);
  };
  return { files, restore: () => { globalThis.fetch = prevFetch; } };
}

/* ===== 1. 不登录也能投稿 ===== */

test('不登录也能投稿：匿名通道完全不依赖账号结构', async (t) => {
  const { call, one, db } = await setup();

  assert.equal(one(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`), undefined, '投稿前不该有账号表');

  const r = await call('/api/submit', { method: 'POST', body: submitBody() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.autoApproved, false);

  const row = one(`SELECT submitter, status, user_id FROM submissions ORDER BY id DESC LIMIT 1`);
  assert.equal(row.submitter, '路人甲', '匿名投稿的署名用手填昵称');
  assert.equal(row.status, 'pending');
  assert.equal(row.user_id, null);

  await t.test('未登录的 /api/me 是 200 + user:null（不是 401，前端不必分支出错态）', async () => {
    const me = await call('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user, null);
  });

  await t.test('投稿状态查询只回状态，不回显昵称与联系方式', async () => {
    const st = await call(`/api/submission?id=${r.data.id}`);
    assert.equal(st.data.status, 'pending');
    assert.equal(st.data.reject_note, null);
    assert.equal(st.data.submitter, undefined);
    assert.equal(st.data.contact, undefined);
  });
});

test('懒建表整段失败时，投稿照收（账号系统坏了不能挡住贡献）', async () => {
  /* 单开一个库：先占掉 users 这个名字（同名视图）。这样
     CREATE TABLE IF NOT EXISTS users 会静默跳过，紧接着的 CREATE INDEX 报
     「views may not be indexed」，ensureSchema 整段失败 —— user_id 也就补不上。
     注意本用例不能先调 /api/me：那会先把 users 表建出来。 */
  const { call, one, db } = await setup();
  db.exec(`CREATE VIEW users AS SELECT 1 AS id`);

  const r = await call('/api/submit', { method: 'POST', body: submitBody() });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const cols = db.prepare(`SELECT name FROM pragma_table_info('submissions')`).all().map((c) => c.name);
  assert.ok(!cols.includes('user_id'), '这一轮就是要让 user_id 补不上，才测得到降级路径');
  /* 稿子照样进队列（这条 SQL 里没提 user_id，所以能跑） */
  assert.equal(one(`SELECT status, submitter FROM submissions ORDER BY id DESC LIMIT 1`).status, 'pending');
  assert.equal(one(`SELECT submitter FROM submissions ORDER BY id DESC LIMIT 1`).submitter, '路人甲');
});

/* ===== 2. 注册 / 登录 / 会话 ===== */

test('注册与登录：口令只存派生值，会话是无状态签名 Cookie', async (t) => {
  const { call, one } = await setup();
  const { setCookies } = await register(call, '测试员', 'pass12345', 'QQ 123');

  const user = one(`SELECT * FROM users`);
  /* ⚠️ 迭代次数不能超过 10 万：Workers 的 WebCrypto 硬限制，超了注册接口直接 500
     （2026-10-11 线上真踩过：本地 Node 没这个限制，所以只有这条断言能拦住它）。
     数字写在哈希串里，改大改小都不会让老口令失效。 */
  const iter = Number(/^pbkdf2\$(\d+)\$/.exec(user.pass_hash)?.[1]);
  assert.ok(Number.isFinite(iter) && iter >= 100_000, '迭代次数不该低于 10 万：' + iter);
  assert.ok(iter <= 100_000, 'Cloudflare 的 PBKDF2 上限是 10 万，超了线上会 NotSupportedError：' + iter);
  assert.ok(!JSON.stringify(user).includes('pass12345'), '库里不该出现明文口令');
  assert.equal(
    one(`SELECT COUNT(*) AS n FROM pragma_table_info('submissions') WHERE name='user_id'`).n,
    1,
    '懒建表要顺手把 submissions.user_id 补上'
  );

  await t.test('localhost 下发的 Cookie 不带 Secure（带浏览器就不收），但必须是 HttpOnly + SameSite', () => {
    const cookie = setCookies.join(';');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.ok(!/Secure/i.test(cookie));
  });

  await t.test('重名 → 409；昵称太短 / 带尖括号 / 口令太短 → 400', async () => {
    /* 每次都换个出口 IP：注册限流是「单 IP 3 个」，这些用例要测的是**校验**，
       不能被限流抢先拦掉（429 会把真正的失败原因盖住）。 */
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '测试员', password: 'pass12345' }, ip: '198.51.100.11' })).status, 409);
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '测', password: 'pass12345' }, ip: '198.51.100.12' })).status, 400);
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '<img src=x>', password: 'pass12345' }, ip: '198.51.100.13' })).status, 400);
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '短口令', password: '123' }, ip: '198.51.100.14' })).status, 400);
  });

  await t.test('带 Cookie 认得出；改签名 / 伪造载荷 / 别人的 id 都认不出来', async () => {
    const me = await call('/api/me');
    assert.equal(me.data.user.name, '测试员');
    assert.deepEqual(me.data.submissions, []);
    assert.equal(me.setCookies.length, 0, '/api/me 不该重新下发 Cookie');

    const forged = Buffer.from(JSON.stringify({ u: 1, v: 1, t: 9_999_999_999 })).toString('base64url');
    const bad = await call('/api/me', { cookie: `zc_sess=${forged}.fakesig` });
    assert.equal(bad.data.user, null);

    const tampered = await call('/api/me', { cookie: 'zc_sess=abc.def' });
    assert.equal(tampered.data.user, null);
  });

  await t.test('登录：口令错与昵称不存在给同一句 401', async () => {
    const wrong = await call('/api/login', { method: 'POST', body: { name: '测试员', password: '不对的口令' } });
    const missing = await call('/api/login', { method: 'POST', body: { name: '查无此人', password: 'pass12345' } });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.data.error, missing.data.error, '不能给撞库的人区分依据');

    const ok = await call('/api/login', { method: 'POST', body: { name: '测试员', password: 'pass12345' } });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookies.join(';'), /zc_sess=/);
  });
});

/* ===== 3. 登录后投稿：署名 / 个人主页 / 等级 / 免审 ===== */

test('登录后投稿：署名用账号昵称、记进个人主页，等级按已写回条数算', async (t) => {
  const { call, one, db } = await setup();
  await register(call, '测试员');

  const r = await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_samosbor', submitter: '冒名者' }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const mine = one(`SELECT submitter, user_id, status FROM submissions ORDER BY id DESC LIMIT 1`);
  assert.equal(mine.submitter, '测试员', '手填的「冒名者」不算数：署名固定用账号昵称');
  assert.ok(Number.isInteger(mine.user_id), '登录投稿必须落 user_id');
  assert.equal(mine.status, 'pending');
  const uid = mine.user_id;

  const me = await call('/api/me');
  assert.equal(me.data.submissions.length, 1);
  assert.equal(me.data.submissions[0].map_slug, 'ze_samosbor');
  assert.equal(me.data.submissions[0].status, 'pending', '「我的投稿」要能看到自己的稿子');
  assert.equal(me.data.user.level, '路人');
  assert.equal(me.data.user.trusted, false);
  /* counts：个人页那四个数字块（口径与等级统计不同 —— 这里数的是条数） */
  assert.deepEqual(me.data.counts, { pending: 1, approved: 0, applied: 0, rejected: 0 });

  await t.test('?lite=1 只回用户本身（页头账号按钮每个页面问一次，不该拖上投稿列表与计数）', async () => {
    const lite = await call('/api/me?lite=1');
    assert.equal(lite.status, 200);
    assert.equal(lite.data.user.name, '测试员');
    assert.equal(lite.data.user.level, '路人');
    assert.equal(lite.data.submissions, undefined);
    assert.equal(lite.data.counts, undefined);
  });

  await t.test('写回仓库（status=applied）后才涨通过数、才升级', async () => {
    db.prepare(`UPDATE submissions SET status='applied', commit_sha='abcdef1234567890' WHERE user_id=?`).run(uid);
    const after = await call('/api/me');
    assert.equal(after.data.user.approved, 1);
    assert.equal(after.data.user.level, '入门贡献者');
    assert.deepEqual(after.data.user.next, { level: '资料整理者', need: 4 });
    assert.equal(after.data.user.trusted, false);
    assert.equal(after.data.submissions[0].commit_sha, 'abcdef1234567890', '写回提交号要显示出来');
  });

  await t.test('通过 ≥10 条且驳回不多 → 免审直发（status=approved）', async () => {
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, user_id) VALUES (?,?,?,?, 'applied', ?, ?)`
    );
    for (let i = 0; i < 9; i++) ins.run(`ze_fill_${i}`, 'difficulty', '"困难"', 'h', Date.now(), uid);

    const me = await call('/api/me');
    assert.equal(me.data.user.approved, 10);
    assert.equal(me.data.user.trusted, true, '通过 10 条、驳回 0 条 → 应有免审资格');
    assert.equal(me.data.user.level, '资深编辑');

    const auto = await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_only_up' }) });
    assert.equal(auto.data.autoApproved, true);
    assert.equal(one(`SELECT status FROM submissions ORDER BY id DESC LIMIT 1`).status, 'approved');
    /* 免审直发那条进的是「待写回」，不是「已通过」—— 数字块要分开数 */
    const after = await call('/api/me');
    assert.deepEqual(after.data.counts, { pending: 0, approved: 1, applied: 10, rejected: 0 });
  });

  await t.test('统计口径：待写回不算通过数；同图同字段只算一次', async () => {    /* 上一条免审直发的还停在 approved（待写回），所以通过数没变 */
    assert.equal((await call('/api/me')).data.user.approved, 10);

    db.prepare(`UPDATE submissions SET status='rejected', reject_note='测试' WHERE map_slug='ze_only_up'`).run();
    const dup = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, user_id) VALUES ('ze_only_up','difficulty','"困难"','h','rejected',?,?)`
    );
    dup.run(Date.now(), uid);
    dup.run(Date.now(), uid);

    const me = await call('/api/me');
    assert.equal(me.data.user.approved, 10, '待写回的不算通过');
    assert.equal(me.data.user.rejected, 1, '同图同字段的多条驳回只算一次');
    assert.equal(me.data.user.trusted, true, '驳回 1 条（≤ 通过/5）不该立刻掉免审');
    /* 一共 13 条：1 条已写回 + 9 条补的 + 1 条免审直发 + 2 条补的驳回 */
    assert.equal(one(`SELECT COUNT(*) AS n FROM submissions WHERE user_id=?`, uid).n, 13);
  });

  await t.test('退出登录后再投稿 → 回到匿名通道', async () => {
    const out = await call('/api/logout', { method: 'POST', body: {} });
    assert.match(out.setCookies.join(';'), /Max-Age=0/);
    const anon = await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_icecap_escape_ia_super', submitter: '又一位路人' }) });
    assert.equal(anon.data.autoApproved, false);
    const row = one(`SELECT submitter, user_id FROM submissions ORDER BY id DESC LIMIT 1`);
    assert.equal(row.submitter, '又一位路人');
    assert.equal(row.user_id, null);
  });
});

/* ===== 4. 改口令 / 改资料 / 限流 ===== */

test('账号设置：改口令让旧 Cookie 失效，改昵称不动历史署名', async (t) => {
  const { call, one, jar } = await setup();
  await register(call, '测试员');
  await call('/api/submit', { method: 'POST', body: submitBody() });
  const beforeCookie = jar.cookie;

  const wrong = await call('/api/password', { method: 'POST', body: { oldPassword: 'wrong', newPassword: 'newpass123' } });
  assert.equal(wrong.status, 401);

  const changed = await call('/api/password', { method: 'POST', body: { oldPassword: 'pass12345', newPassword: 'newpass123' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const freshCookie = changed.setCookies.find((c) => c.startsWith('zc_sess=')).split(';')[0];
  assert.notEqual(freshCookie, beforeCookie, '改口令要换一个新的会话');

  await t.test('旧口令登不上，新口令能登上', async () => {
    assert.equal((await call('/api/login', { method: 'POST', body: { name: '测试员', password: 'pass12345' } })).status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: { name: '测试员', password: 'newpass123' } })).status, 200);
  });

  await t.test('改完口令，之前发出去的 Cookie 立刻失效（pass_ver +1）', async () => {
    assert.equal((await call('/api/me', { cookie: beforeCookie })).data.user, null);
    assert.equal((await call('/api/me', { cookie: freshCookie })).data.user.name, '测试员');
  });

  await t.test('改昵称只影响以后的署名，历史投稿不动；撞别人的昵称 → 409', async () => {
    const r = await call('/api/profile', { method: 'POST', body: { name: '测试员二', contact: 'QQ 456' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.user.name, '测试员二');
    assert.equal(r.data.user.contact, 'QQ 456');
    assert.equal(one(`SELECT submitter FROM submissions ORDER BY id LIMIT 1`).submitter, '测试员', '历史署名不该被追改');

    await call('/api/logout', { method: 'POST', body: {} });
    await register(call, '另一个人');
    await call('/api/logout', { method: 'POST', body: {} });
    await call('/api/login', { method: 'POST', body: { name: '测试员二', password: 'newpass123' } });
    assert.equal((await call('/api/profile', { method: 'POST', body: { name: '另一个人' } })).status, 409);
  });

  await t.test('登录限流：同一 IP 每小时 30 次（注册另有更严的桶）', async () => {
    for (let i = 0; i < 30; i++) await call('/api/login', { method: 'POST', body: { name: 'x', password: 'bad' } });
    const blocked = await call('/api/login', { method: 'POST', body: { name: 'x', password: 'bad' } });
    assert.equal(blocked.status, 429);
  });
});

/* ===== 5. 防「大量注册」（站长最担心的那条） ===== */

test('防大量注册：四道闸逐层收紧，且都不在算哈希之前', async (t) => {
  await t.test('保留昵称不许注册（防冒充站方），已知贡献者的名字**不**在保留名单里', async () => {
    const { call } = await setup();
    let n = 20;
    for (const bad of ['站长', 'Admin', 'ADMINISTRATOR', '官方']) {
      /* 每个名字换个 IP：单 IP 一天只能注册 3 个，别让限流把「保留昵称」的结论盖住 */
      const r = await call('/api/register', { method: 'POST', body: { name: bad, password: 'pass12345' }, ip: `198.51.100.${n++}` });
      assert.equal(r.status, 400, bad + ' 应该被拒：' + JSON.stringify(r.data));
      assert.match(r.data.error, /保留/);
    }
    /* 这四个是历史贡献者，将来要按名字回填功劳 —— 不能用保留名单把他们自己挡住 */
    for (const ok of ['SiKi', '白叶', 'Liyuu~', '路人甲']) {
      const r = await call('/api/register', { method: 'POST', body: { name: ok, password: 'pass12345' }, ip: `198.51.100.${n++}` });
      assert.equal(r.status, 200, ok + ' 应该能注册：' + JSON.stringify(r.data));
    }
  });

  await t.test('同一 IP 一小时最多 3 个（第 4 个 429），而且两个桶都记了数', async () => {
    const { call, rows } = await setup();
    for (let i = 0; i < 3; i++) {
      const r = await call('/api/register', { method: 'POST', body: { name: '刷号测试' + i, password: 'pass12345' } });
      assert.equal(r.status, 200, `第 ${i + 1} 个应该成功：` + JSON.stringify(r.data));
    }
    const fourth = await call('/api/register', { method: 'POST', body: { name: '刷号测试3', password: 'pass12345' } });
    assert.equal(fourth.status, 429);
    assert.match(fourth.data.error, /一小时最多 3 个/);

    /* 小时桶与天桶用的是同一个 'register' 前缀、不同窗口 —— 两条记录都要在。
       注意计数：第 4 次是**先记数再拒绝**（allowWrite 的语义），所以小时桶 4、天桶 3
       （天桶在小时闸就返回了，没走到）。 */
    const wins = rows(`SELECT window, count FROM rate_limits WHERE window LIKE 'register:%'`);
    assert.equal(wins.length, 2, '应该同时占掉「小时」和「天」两个桶：' + JSON.stringify(wins));
    const hour = wins.find((w) => /^register:\d{4}-\d{2}-\d{2}T\d{2}$/.test(w.window));
    const day = wins.find((w) => /^register:\d{4}-\d{2}-\d{2}$/.test(w.window));
    assert.ok(hour, '缺小时桶：' + JSON.stringify(wins));
    assert.ok(day, '缺天桶：' + JSON.stringify(wins));
    assert.equal(Number(hour.count), 4, '小时桶应记到 4（含被拒的那次）');
    assert.equal(Number(day.count), 3, '天桶只记走到那一步的 3 次');
  });

  await t.test('全站 24 小时新账号到顶就停（挡住机器人批量占昵称）', async () => {
    const { call, db } = await setup();
    /* 先让懒建表把表建出来（这一步同时验证「没登录时 /api/me 也会补结构」） */
    await call('/api/me?lite=1');
    /* 直接塞 200 个「最近 24 小时建的」账号，省掉 200 次 PBKDF2；然后第一发注册就该被拦 */
    const ins = db.prepare(`INSERT INTO users (name, name_key, pass_hash, created_at) VALUES (?,?,?,?)`);
    for (let i = 0; i < 200; i++) ins.run('配额占位' + i, '配额占位' + i, 'pbkdf2$100000$x$y', Date.now() - 60_000);
    const r = await call('/api/register', { method: 'POST', body: { name: '还想注册', password: 'pass12345' }, ip: '203.0.113.99' });
    assert.equal(r.status, 429);
    assert.match(r.data.error, /名额已经用完/);
    assert.equal(r.data.error.includes('不登录也能投'), true, '被限流时要说清「不影响投稿」');
  });

  await t.test('被封禁的 IP 连注册和登录都不给（以前这里漏了检查）', async () => {
    const { call, db } = await setup();
    db.prepare(`INSERT INTO bans (ip_hash, reason, banned_at) VALUES (?,?,?)`).run(
      /* 与 Worker 里 ipHash 的算法一致：sha256(IP_SALT:IP)，见 worker/http.ts 的 sha256Hex */
      createHash('sha256').update('test-salt:203.0.113.7').digest('hex'),
      '测试封禁',
      Date.now()
    );
    const reg = await call('/api/register', { method: 'POST', body: { name: '被封的人', password: 'pass12345' } });
    assert.equal(reg.status, 403);
    const login = await call('/api/login', { method: 'POST', body: { name: '被封的人', password: 'pass12345' } });
    assert.equal(login.status, 403);
  });
});

test('账号锁定与封号：换 IP 也猜不动，站长能一键停用', async (t) => {
  const { call, one, env, db } = await setup();
  await register(call, '受害者');

  await t.test('连续 5 次口令错 → 账号被锁 15 分钟，连正确口令也进不去', async () => {
    for (let i = 0; i < 5; i++) {
      /* 每次都换 IP：证明挡的是**账号**，不是出口 */
      const r = await call('/api/login', { method: 'POST', body: { name: '受害者', password: 'wrong-pass' }, ip: `198.51.100.${10 + i}` });
      assert.equal(r.status, 401, `第 ${i + 1} 次错口令应该 401`);
    }
    assert.equal(one(`SELECT fail_count FROM users WHERE name = '受害者'`).fail_count, 0, '锁定时计数清零，解锁后从头算');
    assert.ok(Number(one(`SELECT locked_until FROM users WHERE name = '受害者'`).locked_until) > Date.now(), '应该写入了锁定时间');

    const right = await call('/api/login', { method: 'POST', body: { name: '受害者', password: 'pass12345' }, ip: '198.51.100.77' });
    assert.equal(right.status, 429);
    assert.match(right.data.error, /连续输错/);

    /* 模拟 15 分钟过去：锁定解除后正确口令能进 */
    db.prepare(`UPDATE users SET locked_until = ?1 WHERE name = '受害者'`).run(Date.now() - 1000);
    const again = await call('/api/login', { method: 'POST', body: { name: '受害者', password: 'pass12345' }, ip: '198.51.100.78' });
    assert.equal(again.status, 200, JSON.stringify(again.data));
  });

  await t.test('审核台能看账号列表、停用、恢复（以前只能手改数据库）', async () => {
    env.ADMIN_TOKEN = 'test-admin-token';
    const noAuth = await call('/api/admin/accounts');
    assert.equal(noAuth.status, 401, '没有密钥不给看');

    const list = await call('/api/admin/accounts', { headers: { authorization: 'Bearer test-admin-token' } });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.totals.all, 1);
    assert.equal(list.data.limits.newAccountsPerDay, 200);
    assert.equal(list.data.limits.registerPerDay, 3);
    assert.equal(list.data.items[0].name, '受害者');
    const id = list.data.items[0].id;

    const banned = await call('/api/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token' },
      body: { id, action: 'ban' },
    });
    assert.equal(banned.status, 200, JSON.stringify(banned.data));

    /* 他手上的登录立刻失效，也登不进来了 */
    assert.equal((await call('/api/me')).data.user, null);
    const relogin = await call('/api/login', { method: 'POST', body: { name: '受害者', password: 'pass12345' }, ip: '198.51.100.90' });
    assert.equal(relogin.status, 403);
    assert.match(relogin.data.error, /已被停用/);

    const unbanned = await call('/api/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token' },
      body: { id, action: 'unban' },
    });
    assert.equal(unbanned.status, 200);
    const ok = await call('/api/login', { method: 'POST', body: { name: '受害者', password: 'pass12345' }, ip: '198.51.100.91' });
    assert.equal(ok.status, 200, '解封后应该能登录');

    const bad = await call('/api/admin/accounts', { method: 'POST', headers: { authorization: 'Bearer test-admin-token' }, body: { id, action: '删库' } });
    assert.equal(bad.status, 400, 'action 白名单');
  });

  await t.test('忘记口令：站长能一键重置（本站不收邮箱，这是唯一的人工找回入口）', async () => {
    env.ADMIN_TOKEN = 'test-admin-token';
    const id = one(`SELECT id FROM users WHERE name = '受害者'`).id;
    /* 先把他锁上，验证重置会顺手解锁 */
    db.prepare(`UPDATE users SET fail_count = 3, locked_until = ?1 WHERE id = ?2`).run(Date.now() + 600000, id);

    const r = await call('/api/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token' },
      body: { id, action: 'reset' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const temp = r.data.tempPassword;
    assert.equal(typeof temp, 'string');
    assert.ok(temp.length >= 10, '临时口令要够长：' + temp);

    const row = one(`SELECT pass_ver, fail_count, locked_until FROM users WHERE id = ?1`, id);
    assert.equal(row.pass_ver, 2, '重置要把 pass_ver +1：旧设备上的登录立刻失效');
    assert.equal(row.fail_count, 0);
    assert.equal(row.locked_until, null, '顺手解锁');

    /* 新口令能登进去，老口令不行 */
    const oldPass = await call('/api/login', { method: 'POST', body: { name: '受害者', password: 'pass12345' }, ip: '198.51.100.100' });
    assert.equal(oldPass.status, 401, '重置后旧口令必须失效');
    const newPass = await call('/api/login', { method: 'POST', body: { name: '受害者', password: temp }, ip: '198.51.100.101' });
    assert.equal(newPass.status, 200, '临时口令要能登录：' + JSON.stringify(newPass.data));
  });
});

/* ===== 5. 老库 / 新库都要能跑 ===== */

test('懒建表是幂等的：已经迁移过的库上再跑一遍也不出错', async () => {
  const { call, one } = await setup({ migrated: true });
  await register(call, '老库用户');
  const r = await call('/api/submit', { method: 'POST', body: submitBody() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(one(`SELECT COUNT(*) AS n FROM submissions WHERE user_id IS NOT NULL`).n, 1);
});

test('method 不对时回 405 而不是 500', async () => {
  const { call } = await setup();
  const r = await call('/api/me', { method: 'POST', body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.data.ok, false);
});

/* ===== 6. 等级最高档（2026-10-11 站长加的「资料奠基人」） ===== */

test('等级最高档：79 条停在「百科元老」，80 条才进「资料奠基人」', async () => {
  const { call, one, db } = await setup();
  await register(call, '冲榜的人');
  const uid = one(`SELECT id FROM users WHERE name = '冲榜的人'`).id;

  const ins = db.prepare(
    `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, user_id) VALUES (?,?,?,?, 'applied', ?, ?)`
  );
  for (let i = 0; i < 79; i++) ins.run(`ze_tier_${i}`, 'difficulty', '"困难"', 'h', Date.now(), uid);

  let me = await call('/api/me');
  assert.equal(me.data.user.approved, 79);
  assert.equal(me.data.user.level, '百科元老', '79 条还差一条，别提前给最高档');
  assert.deepEqual(me.data.user.next, { level: '资料奠基人', need: 1 });

  ins.run('ze_tier_79', 'difficulty', '"困难"', 'h', Date.now(), uid);
  me = await call('/api/me');
  assert.equal(me.data.user.approved, 80);
  assert.equal(me.data.user.level, '资料奠基人');
  assert.equal(me.data.user.next, null, '最高档不该再有下一级');
  assert.match(me.data.user.hint, /铺出来/);
  assert.equal(me.data.user.trusted, true, '到这一档当然也免审');
});

/* ===== 8. 昵称审核（2026-10-11 站长要求：别让人注册违法/广告名） ===== */

test('昵称审核：广告 / 违法 / 联系方式 / 乱码一律拒，正常名字照收', async (t) => {
  await t.test('通用词库与联系方式：直接拒绝，且理由分得清', async () => {
    const { call } = await setup();
    const cases = [
      ['代练上分加微信', /不被允许的内容|联系方式/],
      ['出售低价账号', /不被允许的内容/],
      ['澳门博彩开户', /不被允许的内容/],
      ['123456789', /联系方式/],            /* 连续 9 位数字 = QQ/手机号 */
      ['看我的 www.abc.com', /联系方式/],
      ['vx:abc12345', /联系方式/],
      ['aaaaaaaaaa', /乱码|不被允许/],       /* 同字符连 6 个以上 */
      ['★★★★★★', /乱码/],
    ];
    let ip = 30;
    for (const [name, expect] of cases) {
      const r = await call('/api/register', { method: 'POST', body: { name, password: 'pass12345' }, ip: `198.51.100.${ip++}` });
      assert.equal(r.status, 400, `「${name}」应该被拒：` + JSON.stringify(r.data));
      assert.match(r.data.error, expect, `「${name}」的提示不对：` + r.data.error);
    }
    /* 关键：提示里**不能回显命中的词**（否则等于把词库送给想绕过的人） */
    const echo = await call('/api/register', { method: 'POST', body: { name: '代练上分', password: 'pass12345' }, ip: '198.51.100.60' });
    assert.ok(!echo.data.error.includes('代练'), '不该回显命中的词：' + echo.data.error);
  });

  await t.test('变体绕过也拦得住（归一化之后再查）', async () => {
    const { call } = await setup();
    const variants = ['管 理 员', '管·理·员', '４ｄｍｉｎ', '4dmin', 'ADMIN'];
    let ip = 70;
    for (const name of variants) {
      const r = await call('/api/register', { method: 'POST', body: { name, password: 'pass12345' }, ip: `198.51.100.${ip++}` });
      assert.equal(r.status, 400, `「${name}」应该被拒：` + JSON.stringify(r.data));
    }
  });

  await t.test('政治类词表走 Worker 变量（不进仓库），配了就生效', async () => {
    const { call, env } = await setup();
    /* 用两个无害的假词模拟「额外词表」，验证链路：变量 → 解析 → 拦截 */
    env.NICKNAME_EXTRA = '某个测试词, 另一个# 这行是注释';
    const hit = await call('/api/register', { method: 'POST', body: { name: '我叫某个测试词', password: 'pass12345' }, ip: '198.51.100.80' });
    assert.equal(hit.status, 400, JSON.stringify(hit.data));
    assert.match(hit.data.error, /不被允许的内容/);
    const ok = await call('/api/register', { method: 'POST', body: { name: '某个正常玩家', password: 'pass12345' }, ip: '198.51.100.81' });
    assert.equal(ok.status, 200, '不含敏感词的名字要能注册：' + JSON.stringify(ok.data));
  });

  await t.test('正常昵称全部放行（别误伤真玩家）', async () => {
    const { call } = await setup();
    let ip = 90;
    for (const name of ['老玩家阿伟', 'SiKi', '白叶', 'Liyuu~', '夜行者', 'ZE-老六', '肝帝本帝', '阿伟1024']) {
      const r = await call('/api/register', { method: 'POST', body: { name, password: 'pass12345' }, ip: `198.51.100.${ip++}` });
      assert.equal(r.status, 200, `「${name}」不该被拦：` + JSON.stringify(r.data));
    }
  });

  await t.test('审核台能一键改名（违规昵称的兜底处理）', async () => {
    const { call, env, one } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    await register(call, '正常名字');
    const id = one(`SELECT id FROM users WHERE name = '正常名字'`).id;
    /* 先投一稿（状态 pending），验证改名会顺手改掉未写回的署名 */
    await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_flowering' }) });

    const bad = await call('/api/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token' },
      body: { id, action: 'rename', name: '代练加微信' },
    });
    assert.equal(bad.status, 400, '改名也要过昵称规则');

    const ok = await call('/api/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token' },
      body: { id, action: 'rename', name: `用户#${id}` },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(one(`SELECT name FROM users WHERE id = ?1`, id).name, `用户#${id}`);
    assert.equal(one(`SELECT submitter FROM submissions WHERE user_id = ?1`, id).submitter, `用户#${id}`, '未写回的署名要跟着改');
  });
});

/* ===== 9. 人机验证（Turnstile）=====
 *
 * 本地不联网，所以把 globalThis.fetch 换成一个假的 siteverify ——
 * 这正好是「配了 secret 之后会发生什么」的确定性验证（真实调用在线上另有冒烟）。
 */
test('人机验证：配了 secret 就必过，token 不对与服务不可达给不同提示', async (t) => {
  const realFetch = globalThis.fetch;
  const stub = (reply) => {
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/turnstile/v0/siteverify')) return reply();
      return realFetch(url, init);
    });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const pass = () => new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
  const turnstileFail = () =>
    new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { headers: { 'content-type': 'application/json' } });

  await t.test('没配 secret：完全跳过（现有部署不受影响）', async () => {
    const { call } = await setup();
    stub(turnstileFail);
    const r = await call('/api/register', { method: 'POST', body: { name: '没配密钥', password: 'pass12345' } });
    assert.equal(r.status, 200, '没配 secret 时不该要求验证：' + JSON.stringify(r.data));
  });

  await t.test('配了 secret：不带 token → 注册/登录 400（投稿是宽松的，见下一条）', async () => {
    const { call, env } = await setup();
    env.TURNSTILE_SECRET = 'test-secret';
    stub(pass);
    const reg = await call('/api/register', { method: 'POST', body: { name: '没带token', password: 'pass12345' } });
    assert.equal(reg.status, 400);
    assert.match(reg.data.error, /小方框/);
    const login = await call('/api/login', { method: 'POST', body: { name: '没带token', password: 'pass12345' } });
    assert.equal(login.status, 400, '登录同样要验证');
  });

  await t.test('token 通过 → 注册与投稿都放行', async () => {
    const { call, env } = await setup();
    env.TURNSTILE_SECRET = 'test-secret';
    stub(pass);
    const reg = await call('/api/register', { method: 'POST', body: { name: '真人', password: 'pass12345', turnstileToken: 'tok' } });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const submit = await call('/api/submit', { method: 'POST', body: submitBody({ turnstileToken: 'tok' }) });
    assert.equal(submit.status, 200, JSON.stringify(submit.data));
  });

  await t.test('投稿是**宽松**的：没带 token 也收（保住「谁都能投稿」）', async () => {
    const { call, env } = await setup();
    env.TURNSTILE_SECRET = 'test-secret';
    /* siteverify 全判失败：如果投稿还要 token，这里就会 400 */
    stub(turnstileFail);
    const anon = await call('/api/submit', { method: 'POST', body: submitBody() });
    assert.equal(anon.status, 200, '匿名投稿不该被验证挡住：' + JSON.stringify(anon.data));
    /* 但**带了** token 就要认真验 —— 假 token 照样拒 */
    const bad = await call('/api/submit', { method: 'POST', body: submitBody({ turnstileToken: 'forged' }) });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /没通过/);
  });

  await t.test('siteverify 说 token 无效 → 400（"没通过"），不是服务故障', async () => {
    const { call, env } = await setup();
    env.TURNSTILE_SECRET = 'test-secret';
    stub(turnstileFail);
    const r = await call('/api/register', { method: 'POST', body: { name: '假token', password: 'pass12345', turnstileToken: 'bad' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /没通过/);
  });

  await t.test('siteverify 连不上 → "服务暂时不可用"，别把锅甩给用户', async () => {
    const { call, env } = await setup();
    env.TURNSTILE_SECRET = 'test-secret';
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/turnstile/v0/siteverify')) throw new Error('network down');
      return realFetch(url, init);
    });
    const r = await call('/api/register', { method: 'POST', body: { name: '服务挂了', password: 'pass12345', turnstileToken: 'tok' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /暂时不可用/);
    assert.match(r.data.error, /不是你的问题/);
  });

  await t.test('siteverify 返回 500 → 也归到"服务不可用"', async () => {
    const { call, env } = await setup();
    env.TURNSTILE_SECRET = 'test-secret';
    stub(() => new Response('boom', { status: 500 }));
    const r = await call('/api/login', { method: 'POST', body: { name: '谁', password: 'pass12345', turnstileToken: 'tok' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /暂时不可用/);
  });

  await t.test('批量投稿：一次交 3 项，同一个 batch 号，逐项校验', async () => {
    const { call, db } = await setup();
    /* 先让懒建表把表建出来（这也是「batch 列会自动补上」的验证） */
    await call('/api/me');
    const r = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_demo',
        items: [
          { field: 'difficulty', value: '困难' },
          { field: 'tags', value: ['神器', '多关卡'] },
          { field: 'sources', value: ['https://example.com/a'] },
        ],
        submitter: '整理者',
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.count, 3);
    assert.equal(r.data.ids.length, 3);
    assert.match(r.data.batch, /^b/);
    const rows = db.prepare(`SELECT id, field, batch FROM submissions ORDER BY id`).all();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((x) => x.field), ['difficulty', 'tags', 'sources']);
    assert.equal(new Set(rows.map((x) => x.batch)).size, 1, '同一批共用一个 batch 号');

    const bad = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_demo', items: [{ field: 'difficulty', value: '中等' }] },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /第 1 项/);

    const tooMany = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_demo', items: Array.from({ length: 11 }, () => ({ field: 'tags', value: ['神器'] })) },
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /最多提交 10 项/);
  });

  await t.test('仓库贡献者称号：没有名单就不发（宁可不发，也不凭一句话发称号）', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    await call('/api/register', { method: 'POST', body: { name: '贡献者', password: 'pass12345' } });
    /* 没配 GITHUB_TOKEN → 读不到贡献者名单 → 必须拒绝，而不是照发 */
    const r = await call('/api/admin/accounts', {
      method: 'POST',
      body: { id: 1, action: 'linkgh', name: 'somebody' },
      headers: { authorization: 'Bearer test-admin-token' },
    });
    assert.equal(r.status, 502, JSON.stringify(r.data));
    assert.match(r.data.error, /核对贡献者名单失败|没有名单就不发称号/);
    assert.equal((await call('/api/me')).data.user.gh, undefined, '没发成就不该有徽章');
  });

  await t.test('仓库贡献者称号：核对通过才发；支持一人多个 GitHub 号', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh';
    env.GITHUB_API_BASE = 'https://api.github.test';
    /* 假 GitHub：贡献者名单里只有 trrrr-ai 与 xianoom */
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/contributors')) {
        return new Response(JSON.stringify([{ login: 'trrrr-ai', contributions: 17 }, { login: 'xianoom', contributions: 3 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(url, init);
    });
    await call('/api/register', { method: 'POST', body: { name: '贡献者', password: 'pass12345' } });
    const auth = { authorization: 'Bearer test-admin-token' };

    const none = await call('/api/admin/accounts', {
      method: 'POST',
      body: { id: 1, action: 'linkgh', name: 'nobody-here' },
      headers: auth,
    });
    assert.equal(none.status, 400, JSON.stringify(none.data));
    assert.match(none.data.error, /都不在仓库贡献者名单里/);

    const ok = await call('/api/admin/accounts', {
      method: 'POST',
      body: { id: 1, action: 'linkgh', name: 'trrrr-ai, MiKU' },
      headers: auth,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.match(ok.data.message, /trrrr-ai（17 次提交）/);
    assert.match(ok.data.message, /MiKU 不在贡献者名单里/);

    const me = await call('/api/me');
    assert.deepEqual(me.data.user.gh.logins, ['trrrr-ai', 'MiKU']);
    assert.match(me.data.user.gh.url, /graphs\/contributors$/, '多个号时指向仓库贡献者页');

    await call('/api/admin/accounts', { method: 'POST', body: { id: 1, action: 'unlinkgh' }, headers: auth });
    assert.equal((await call('/api/me')).data.user.gh, undefined, '摘掉后立刻没有徽章');
  });

  /* ===== 整篇草稿 + 采纳（2026-10-13：大面积修改的入口） ===== */

  await t.test('整篇草稿必须登录：匿名投被拒，登录后收下', async () => {
    const { call } = await setup();
    const draft = '导语一段。\n\n## 简介\n正文…\n';

    const anon = await call('/api/submit', { method: 'POST', body: { map: 'ze_demo', field: 'draft', value: draft } });
    assert.equal(anon.status, 401, JSON.stringify(anon.data));
    assert.match(anon.data.error, /需要先登录/);

    await call('/api/register', { method: 'POST', body: { name: '整理者', password: 'pass12345' } });
    const ok = await call('/api/submit', { method: 'POST', body: { map: 'ze_demo', field: 'draft', value: draft } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.ok, true);
  });

  await t.test('草稿必须有 `## 小节`（否则没东西可按节合并）', async () => {
    const { call } = await setup();
    await call('/api/register', { method: 'POST', body: { name: '整理者', password: 'pass12345' } });
    const r = await call('/api/submit', { method: 'POST', body: { map: 'ze_demo', field: 'draft', value: '一大段没有小节的文字' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /## 小节标题/);
  });

  await t.test('采纳要有「已写回的草稿」：没有就明确告诉审核员下一步做什么', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const r = await call('/api/admin/adopt', {
      method: 'POST',
      body: { slug: 'ze_demo' },
      headers: { authorization: 'Bearer test-admin-token' },
    });
    assert.equal(r.status, 404, JSON.stringify(r.data));
    assert.match(r.data.error, /先把它通过并写回仓库/);
  });

  await t.test('没有密钥不能采纳（采纳是审核台的动作）', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const r = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo' } });
    assert.equal(r.status, 401);
  });

  /*
   * 2026-10-14 线上真事故的回归测试：
   * 采纳时把 submissions.value **原样**（没 JSON.parse）交给 mergeDraft，
   * 于是 `"## 小节\n正文"` 这串带引号、带字面 \n 的文本被当成导语：
   * 解析出 0 个小节 → summary 写成一坨带引号的原文、sections 写成 [] →
   * generate-map-entries 的「sections 必须是非空数组」当场让构建失败
   * （ze_tenkinoko_welkin_z，站点整整一轮构建挂掉）。
   * 这里用**真库真行**跑一遍：必须先 parse，再合并，且 sections 不许为空。
   */
  await t.test('采纳：库里存的是 JSON 字符串，必须先 parse 再合并（否则写坏原稿、构建挂）', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    /* commitFiles 走 Git Data API，需要 GITHUB_TOKEN；这里用假 token + 假 GitHub */
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const draft = '## 基本信息\n\n地图由 [Lopb] 绘制\n\n- 3+1(ZM)个关卡\n';
    db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES ('ze_demo','draft',?,'h','applied',?, 'AntiLockwise')`
    ).run(JSON.stringify(draft), Date.now());

    const repo = installFakeRepo({
      'data/research/ze_demo.json': JSON.stringify({ difficulty: '困难', tags: [], confidence: 'low' }, null, 1) + '\n',
      'data/community/ze_demo.json': JSON.stringify({ v: 1, slug: 'ze_demo', fields: {}, notes: [], items: [], log: [] }, null, 2) + '\n',
    });
    const repoFiles = repo.files;
    try {
      const r = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo' }, headers: auth });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.deepEqual(r.data.added, ['基本信息'], '草稿那一节应当被「新增」进去');
      const written = JSON.parse(repoFiles['data/research/ze_demo.json']);
      assert.equal(written.sections.length, 1, 'sections 必须非空 —— 空数组会让构建脚本直接抛错');
      assert.equal(written.sections[0].title, '基本信息');
      assert.match(written.sections[0].body, /Lopb/);
      assert.equal(written.summary, undefined, '草稿没有导语，就不该动 summary（更不能把带引号的原文写进去）');
      assert.equal(written.confidence, 'medium');
      /* 社区文档：草稿清空 + 记一条已采纳 */
      const doc = JSON.parse(repoFiles['data/community/ze_demo.json']);
      assert.equal(doc.draft, null);
      assert.match(String(doc.fields.draft?.v ?? ''), /已采纳/);
    } finally {
      repo.restore();
    }
  });

  /*
   * 重复采纳的护栏（2026-10-14 加，跟着上面那起事故一起来）：
   * 采纳之后投稿行仍是 applied（审核台要能对账），「采纳为原稿」按钮也还在 ——
   * 手一抖再点一次，就是拿**同一份旧草稿**再合并一遍，会把「采纳后又被手工修过的原稿」盖回去
   * （ze_tenkinoko_welkin_z 正是这样抢修回来的）。现在第二次会被 409 拦下，仓库一个字节都不动；
   * 真要用同一份草稿重来，得显式带 force。
   */
  await t.test('采纳：同一条草稿第二次被 409 拦住（要 force 才重来），新草稿不受影响', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES ('ze_demo4','draft',?,'h','applied',?, '整理者')`
    );
    ins.run(JSON.stringify('## 基本信息\n\n原始内容\n'), Date.now());

    const repo = installFakeRepo({
      'data/research/ze_demo4.json':
        JSON.stringify({ sections: [{ title: '基本信息', body: '原来的一句话' }], confidence: 'low' }, null, 2) + '\n',
      'data/community/ze_demo4.json':
        JSON.stringify({ v: 1, slug: 'ze_demo4', updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] }, null, 2) + '\n',
    });
    const repoFiles = repo.files;
    try {
      const first = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo4' }, headers: auth });
      assert.equal(first.status, 200, JSON.stringify(first.data));

      /* 采纳之后站长手工修原稿（线上那次抢修就是这么干的） */
      repoFiles['data/research/ze_demo4.json'] = JSON.stringify(
        { sections: [{ title: '基本信息', body: '人工修好的内容' }], confidence: 'medium' },
        null,
        2
      ) + '\n';

      const second = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo4' }, headers: auth });
      assert.equal(second.status, 409, JSON.stringify(second.data));
      assert.equal(second.data.code, 'already-adopted');
      assert.match(second.data.error, /已经.*采纳过/);
      assert.match(repoFiles['data/research/ze_demo4.json'], /人工修好的内容/, '被拦下时仓库必须原封不动');

      const forced = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo4', force: true }, headers: auth });
      assert.equal(forced.status, 200, JSON.stringify(forced.data));
      assert.match(repoFiles['data/research/ze_demo4.json'], /原始内容/, 'force 时才按同一份草稿重新合并');

      /* 又来了一份**新**草稿（新的投稿行）→ 不该被当成「已采纳过」而拦下 */
      ins.run(JSON.stringify('## 关卡\n\n新的整理稿\n'), Date.now() + 1);
      const third = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo4' }, headers: auth });
      assert.equal(third.status, 200, JSON.stringify(third.data));
      const written = JSON.parse(repoFiles['data/research/ze_demo4.json']);
      assert.deepEqual(
        written.sections.map((s) => s.title),
        ['基本信息', '关卡'],
        '新草稿照旧合并（同名替换、新节追加）'
      );
    } finally {
      repo.restore();
    }
  });

  await t.test('采纳：草稿没有 `## 小节` 时**拒绝**（宁可报错，也不写坏仓库）', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    /* 造一条「存库格式不对」的草稿：整段没有小节（模拟老数据 / 手改过的行） */
    db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES ('ze_demo2','draft',?,'h','applied',?, '某人')`
    ).run(JSON.stringify('一大段没有小节的文字'), Date.now());

    const r = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo2' }, headers: auth });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, /没有 `## 小节标题`|无法按小节合并/);
  });

  /*
   * 「把条目标题行当小节名」的护栏（2026-10-14 加，ze_tenkinoko_welkin_z 的第二次丑事）：
   * 草稿长这样 `## - ze_demo5 (示例图) -\n\n地图由 … 绘制` —— 那行是**标题**，不是小节名。
   * 直接采纳它跟原稿任何一节都不同名，会被当新小节追加：页面上多出一个
   * 「- ze_demo5 (示例图) -」标题，内容还跟「基本信息」重复。
   * 现在：不改写就 400（仓库一个字节不动）；带 retitle 改写成「基本信息」才合并，且照实报出来。
   */
  await t.test('采纳：标题行当小节名 → 不改写就拒（placeholder-title），带 retitle 才合并', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const banner = '- ze_demo5 (示例图) -';
    const draft = `## ${banner}\n\n地图由 [某人] 绘制\n\n- 3 个关卡\n`;
    db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES ('ze_demo5','draft',?,'h','applied',?, '整理者')`
    ).run(JSON.stringify(draft), Date.now());

    const repo = installFakeRepo({
      'data/research/ze_demo5.json':
        JSON.stringify({ title: '示例图', sections: [{ title: '基本信息', body: '原来的一句话' }], confidence: 'low' }, null, 2) + '\n',
      'data/community/ze_demo5.json':
        JSON.stringify({ v: 1, slug: 'ze_demo5', updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] }, null, 2) + '\n',
    });
    const repoFiles = repo.files;
    try {
      const refused = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_demo5' }, headers: auth });
      assert.equal(refused.status, 400, JSON.stringify(refused.data));
      assert.equal(refused.data.code, 'placeholder-title');
      assert.deepEqual(refused.data.titles, [banner]);
      assert.match(refused.data.error, /标题行/);
      assert.match(repoFiles['data/research/ze_demo5.json'], /原来的一句话/, '被拦下时仓库必须原封不动');

      const ok = await call('/api/admin/adopt', {
        method: 'POST',
        body: { slug: 'ze_demo5', retitle: { [banner]: '基本信息' } },
        headers: auth,
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.deepEqual(ok.data.renamed, [{ from: banner, to: '基本信息' }]);
      assert.deepEqual(ok.data.added, [], '改写后是替换同名小节，不该再多出一节');
      assert.deepEqual(ok.data.replaced, ['基本信息']);
      const written = JSON.parse(repoFiles['data/research/ze_demo5.json']);
      assert.deepEqual(
        written.sections.map((s) => s.title),
        ['基本信息'],
        '页面上不该出现「- ze_demo5 (示例图) -」这种小节标题'
      );
      assert.match(written.sections[0].body, /地图由 \[某人\] 绘制/);
    } finally {
      repo.restore();
    }
  });

  /*
   * 审核台改版（2026-10-13）：队列列表不再逐图读 GitHub 取「现值」——
   * 一次 Worker 调用只有 50 个子请求额度，limit 允许到 200，50 张不同的图就撞上限
   * （线上真的报过 500 Too many subrequests，整个审核台打不开）。
   * 现在列表只花 3 个子请求，现值走 /api/admin/current 按需取。
   */
  await t.test('队列列表：不再逐图读现值，只回投稿本身', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES (?,?,?, 'h', 'pending', ?, ?)`
    );
    ins.run('ze_alpha', 'difficulty', '"困难"', Date.now(), '甲');
    ins.run('ze_beta', 'story', '"一段故事"', Date.now() + 1, '乙');

    const r = await call('/api/admin/queue?status=pending', { headers: { authorization: 'Bearer test-admin-token' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items.length, 2);
    assert.equal(r.data.items[0].current, null, '现值不在列表里取（交给 /api/admin/current）');
    assert.equal(r.data.items[0].currentPending, true, '待审的要告诉前端「现值还没取」');
    assert.equal(r.data.total, 2);
    assert.equal(r.data.limit, 50);
    assert.equal(r.data.offset, 0);
    assert.equal(r.data.gitReady, false, '没配 GITHUB_TOKEN 时如实说明');
  });

  await t.test('队列筛选：关键词 / 地图 / 分页都对', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter, note)
       VALUES (?,?,?, 'h', ?, ?, ?, ?)`
    );
    /* 三条待审 + 一条已上线（不该混进来） */
    ins.run('ze_alpha', 'difficulty', '"困难"', 'pending', 1000, '甲', '');
    ins.run('ze_alpha', 'story', '"甲写的故事"', 'pending', 2000, '甲', '');
    ins.run('ze_beta', 'story', '"乙写的故事"', 'pending', 3000, '乙', '来自 B 站');
    ins.run('ze_beta', 'story', '"已经上线的"', 'applied', 4000, '丙', '');

    const all = await call('/api/admin/queue?status=pending', { headers: auth });
    assert.equal(all.data.items.length, 3);
    assert.equal(all.data.total, 3, 'total 只数当前状态');

    const byMap = await call('/api/admin/queue?status=pending&map=ze_alpha', { headers: auth });
    assert.equal(byMap.data.items.length, 2);
    assert.ok(byMap.data.items.every((i) => i.map_slug === 'ze_alpha'));

    const byWord = await call('/api/admin/queue?status=pending&q=乙', { headers: auth });
    assert.equal(byWord.data.items.length, 1, '关键词能匹配署名');
    assert.equal(byWord.data.items[0].submitter, '乙');

    const byContent = await call('/api/admin/queue?status=pending&q=' + encodeURIComponent('故事'), { headers: auth });
    assert.equal(byContent.data.items.length, 2, '关键词也能匹配投稿内容');
    assert.equal(byContent.data.total, 2);

    const paged = await call('/api/admin/queue?status=pending&limit=1&offset=1', { headers: auth });
    assert.equal(paged.data.items.length, 1);
    assert.equal(paged.data.items[0].created_at, 2000, '按时间升序的第 2 条');
    assert.equal(paged.data.total, 3, '分页不影响 total');

    /* LIKE 的通配符要转义：用户搜 % 不该把整张表捞回来 */
    const wildcard = await call('/api/admin/queue?status=pending&q=%25', { headers: auth });
    assert.equal(wildcard.data.items.length, 0, '% 当普通字符，不是通配符');

    const badMap = await call('/api/admin/queue?status=pending&map=../../etc', { headers: auth });
    assert.equal(badMap.data.items.length, 3, '非法地图参数被忽略（不当成过滤条件）');
  });

  await t.test('现值接口：要密钥、限 10 条、按 id 回值', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES ('ze_alpha','difficulty','"困难"','h','pending',?, '甲')`
    ).run(Date.now());
    const id = db.prepare(`SELECT id FROM submissions ORDER BY id DESC LIMIT 1`).get().id;

    const noAuth = await call(`/api/admin/current?ids=${id}`);
    assert.equal(noAuth.status, 401, '没有密钥不能取现值');

    const empty = await call('/api/admin/current?ids=', { headers: auth });
    assert.equal(empty.status, 400);

    const tooMany = await call(`/api/admin/current?ids=${Array.from({ length: 11 }, (_, i) => i + 1).join(',')}`, { headers: auth });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /最多取 10 条/);

    /* 没配 GITHUB_TOKEN：取不到社区文档不算错误，值回 null，但 id 要认出来 */
    const ok = await call(`/api/admin/current?ids=${id},999999`, { headers: auth });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(Object.prototype.hasOwnProperty.call(ok.data.current, String(id)), '认识的 id 要有键');
    assert.equal(ok.data.current[String(id)], null, '读不到文档时现值是 null');
    assert.equal(ok.data.current['999999'], undefined, '不存在的 id 不编造');
    assert.equal(ok.data.docsRead, 1, '一张图只读一次');
  });

  await t.test('mergeDraft：同名小节替换、新节追加、没写到的小节原样保留', async () => {
    const { mergeDraft, serializeResearch } = await import('../shared/draft-merge.mjs');
    const research = {
      slug: 'ze_demo',
      summary: '旧简介',
      sections: [
        { title: '背景故事', body: '老故事' },
        { title: '关卡流程', body: '老流程' },
      ],
      sources: ['https://example.com/a'],
      confidence: 'low',
      verified: true,
    };
    const r = mergeDraft(research, '新导语。\n\n## 关卡流程\n新流程\n\n## 神器 / 道具\n新写的表\n');
    assert.equal(r.summary, '新导语。', '第一个 ## 之前的文字变成简介');
    assert.deepEqual(r.replaced, ['关卡流程']);
    assert.deepEqual(r.added, ['神器 / 道具']);
    assert.deepEqual(r.kept, ['背景故事']);
    assert.deepEqual(r.next.sections, [
      { title: '背景故事', body: '老故事' },
      { title: '关卡流程', body: '新流程' },
      { title: '神器 / 道具', body: '新写的表' },
    ]);
    assert.equal(r.next.confidence, 'medium', '社区整理 + 站长采纳，可信度至少 medium');
    assert.equal(r.next.verified, true, 'verified 是站长逐条核对过的标记，采纳不该动它');
    assert.deepEqual(r.next.sources, research.sources, 'sources 必须原样保留');

    /* 只改一节 = 只替换那一节；草稿没写导语就不动简介 */
    const one = mergeDraft(research, '## 背景故事\n重写的故事');
    assert.deepEqual(one.next.sections, [
      { title: '背景故事', body: '重写的故事' },
      { title: '关卡流程', body: '老流程' },
    ]);
    assert.equal(one.next.summary, '旧简介');

    /* 序列化沿用原文件缩进与换行，别把整份原稿重排（审阅时看不出改了什么） */
    assert.equal(serializeResearch({ a: 1, b: 2 }, '{\n "a": 1,\n "b": 2\n}'), '{\n "a": 1,\n "b": 2\n}\n');
    assert.equal(serializeResearch({ a: 1 }, '{\r\n  "a": 1\r\n}\r\n'), '{\r\n  "a": 1\r\n}\r\n');
  });

  /* ===== 授权 UP 主称号（2026-10-13 加） =====
     同意名单在 R2（不进仓库），所以这里塞一个假的 TERR：只认 video-meta/agreed.json。 */
  const withAgreed = (env, ups) => {
    env.TERR = {
      get: async (key) =>
        key === 'video-meta/agreed.json'
          ? { body: new Response(JSON.stringify({ updatedAt: '2026-10-13', ups })).body }
          : null,
    };
    return env;
  };

  await t.test('称号只人工发：昵称与 UP 一模一样也**不**自动给', async () => {
    const { call, env } = await setup();
    withAgreed(env, [{ u: '雨宫鹿奈', m: '254673567', videos: 6, maps: ['ze_a', 'ze_b'] }]);
    await call('/api/register', { method: 'POST', body: { name: '雨宫鹿奈', password: 'pass12345' } });
    const r = await call('/api/me');
    assert.equal(r.status, 200);
    assert.equal(
      r.data.user.up,
      undefined,
      '谁先把昵称注册成 UP 的名字谁就白拿称号 —— 那等于冒名零成本，所以一律不给'
    );
  });

  await t.test('管理台人工 linkup 之后才有徽章（昵称不一样也能挂）', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    withAgreed(env, [{ u: '雨宫鹿奈_shikaNiko', m: '254673567', videos: 6, maps: ['ze_a'] }]);
    await call('/api/register', { method: 'POST', body: { name: '雨宫鹿奈', password: 'pass12345' } });
    assert.equal((await call('/api/me')).data.user.up, undefined, '默认没有称号');

    const auth = { authorization: 'Bearer test-admin-token' };
    const bad = await call('/api/admin/accounts', {
      method: 'POST',
      body: { id: 1, action: 'linkup', name: '不在名单里的人' },
      headers: auth,
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.data));
    assert.match(bad.data.error, /同意名单里没有/);

    const ok = await call('/api/admin/accounts', {
      method: 'POST',
      body: { id: 1, action: 'linkup', name: '雨宫鹿奈_shikaNiko' },
      headers: auth,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const me = await call('/api/me');
    assert.equal(me.data.user.up.name, '雨宫鹿奈_shikaNiko');
    assert.equal(me.data.user.up.mid, '254673567', '带上 B 站 UID，页面才好做主页链接');

    await call('/api/admin/accounts', { method: 'POST', body: { id: 1, action: 'unlinkup' }, headers: auth });
    assert.equal((await call('/api/me')).data.user.up, undefined, '摘掉之后立刻没有徽章');
  });
});

/* ===== 6. GitHub 登录（2026-10-14 加，可选的一条路） =====
 *
 * 怎么测：把 GitHub 的两个端点（授权站 + API 站）换成假站（`env.GITHUB_OAUTH_BASE` /
 * `env.GITHUB_API_BASE`）；Worker 里的 fetch 就在同一个进程里，直接替换 globalThis.fetch。
 * 这样 state 校验、换 token、读 profile、建号 / 绑定 / 找回、贡献者称号自动核对
 * 全都能端到端跑一遍 —— 不需要真的 GitHub 账号，也不会碰线上。
 */
test('GitHub 登录：可选、可绑定、可找回，且不碰口令这条路', async (t) => {
  const realFetch = globalThis.fetch;
  /** 假 GitHub：/login/oauth/access_token 换 token；/user 读资料；/repos/.../contributors 读贡献者名单 */
  const fakeGithub = (opts = {}) => {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input.url);
      calls.push({ url, method: init.method ?? 'GET', body: init.body ?? '' });
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

      if (url.startsWith('https://gh.test/login/oauth/access_token')) {
        const sent = JSON.parse(String(init.body ?? '{}'));
        if (sent.code !== opts.goodCode) return json({ error: 'bad_verification_code' });
        return json({ access_token: 'gho_fake_token', token_type: 'bearer', scope: 'read:user' });
      }
      if (url.startsWith('https://api.gh.test/user')) {
        const auth = String((init.headers ?? {}).authorization ?? '');
        if (!auth.includes('gho_fake_token')) return json({ message: 'Bad credentials' }, 401);
        return json(opts.profile ?? { id: 4242, login: 'octocat', avatar_url: 'https://avatars.example/u/4242' });
      }
      if (url.includes('/contributors')) {
        if (!opts.contributors) return json({ message: 'Not Found' }, 404);
        return json(opts.contributors);
      }
      return json({ message: 'unexpected ' + url }, 500);
    };
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
  };

  const withGithub = (env, extra = {}) => {
    env.GITHUB_OAUTH_CLIENT_ID = 'Iv1.test';
    env.GITHUB_OAUTH_CLIENT_SECRET = 'secret';
    env.GITHUB_OAUTH_BASE = 'https://gh.test';
    env.GITHUB_API_BASE = 'https://api.gh.test';
    return Object.assign(env, extra);
  };

  await t.test('没配密钥：整条路自动关闭，口令注册照旧能用', async () => {
    const { call, env } = await setup();
    const me = await call('/api/me');
    assert.equal(me.data.github.enabled, false, '页面据此把按钮换成说明，而不是给一个点了没反应的按钮');
    const start = await call('/api/auth/github/start');
    assert.equal(start.status, 503);
    assert.match(start.data.error, /还没开启 GitHub 登录/);
    const reg = await call('/api/register', { method: 'POST', body: { name: '口令用户', password: 'pass12345' } });
    assert.equal(reg.status, 200, '口令注册不受影响');
  });

  await t.test('start：302 到假 GitHub 并带上 state，state 写进 HttpOnly Cookie', async () => {
    const { call, env } = await setup();
    withGithub(env);
    const r = await call('/api/auth/github/start');
    assert.equal(r.status, 302);
    const loc = r.res.headers.get('location') ?? '';
    assert.ok(loc.startsWith('https://gh.test/login/oauth/authorize?'), loc);
    const u = new URL(loc);
    assert.equal(u.searchParams.get('client_id'), 'Iv1.test');
    assert.equal(u.searchParams.get('scope'), 'read:user', '只读公开资料，不申请 user:email');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8787/api/auth/github/callback');
    const state = u.searchParams.get('state') ?? '';
    assert.ok(state.length >= 20, 'state 要够随机');
    const cookie = r.setCookies.join(';');
    assert.match(cookie, /zc_gh_state=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\/api\/auth/);
  });

  await t.test('callback：state 不对 / 缺 code / 用户取消 → 一律不发号', async () => {
    const { call, env, db } = await setup();
    withGithub(env);

    const noState = await call('/api/auth/github/callback?code=x&state=wrong');
    assert.equal(noState.status, 302);
    assert.match(noState.res.headers.get('location') ?? '', /gh=state/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 0, 'state 不对不能建号');

    const cancel = await call('/api/auth/github/callback?error=access_denied');
    assert.match(cancel.res.headers.get('location') ?? '', /gh=cancel/);

    await call('/api/auth/github/start');
    const badCode = await call('/api/auth/github/callback?code=wrong&state=' + new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state'));
    assert.match(badCode.res.headers.get('location') ?? '', /gh=token/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 0, '换不到 token 不能建号');
  });

  await t.test('callback：新用户 → 建号并登录（昵称取 GitHub 登录名）', async () => {
    const { call, env } = await setup();
    /* 贡献者名单要 GITHUB_TOKEN 才读得到（拿不到就静默跳过，见下一条用例） */
    withGithub(env, { GITHUB_TOKEN: 'test-gh-token' });
    const gh = fakeGithub({ goodCode: 'code-1', contributors: [{ login: 'octocat', contributions: 3 }] });
    await call('/api/auth/github/start');
    const state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');

    const r = await call(`/api/auth/github/callback?code=code-1&state=${state}`);
    assert.equal(r.status, 302, '成功后 302 回 /account/，别把用户留在 JSON 上');
    assert.match(r.res.headers.get('location') ?? '', /gh=new/);
    assert.match(r.setCookies.join(';'), /zc_sess=/, '要发会话 Cookie');
    gh.restore();

    const me = await call('/api/me');
    assert.equal(me.data.user.name, 'octocat');
    assert.equal(me.data.user.ghLogin.login, 'octocat');
    assert.equal(me.data.user.ghLogin.hasPassword, false, 'GitHub 建的号没有口令');
    assert.equal(me.data.user.gh.logins[0], 'octocat', '在贡献者名单里 → 自动挂「仓库贡献者」称号');
    assert.equal(me.data.github.enabled, true);
  });

  await t.test('全新的空库也能用（本地 wrangler dev / 重建 D1 的场景）', async () => {
    const { call, env, one } = await setup({ empty: true });
    withGithub(env);
    const gh = fakeGithub({ goodCode: 'code-empty' });
    await call('/api/auth/github/start');
    const state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');

    const r = await call(`/api/auth/github/callback?code=code-empty&state=${state}`);
    gh.restore();
    assert.equal(r.status, 302, '空库上不能 500 —— ensureSchema 得自己把表建齐');
    assert.match(r.res.headers.get('location') ?? '', /gh=new/);

    /* 四张基础表都要真的建出来（以前是假定已存在） */
    for (const table of ['users', 'bans', 'rate_limits', 'submissions']) {
      const hit = one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table);
      assert.ok(hit, `缺表：${table}`);
    }
    /* 投稿这条路也要能用（匿名通道不依赖账号结构） */
    const sub = await call('/api/submit', { method: 'POST', body: submitBody() });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
  });

  /*
   * 空库上的**第一个请求**：注册（2026-10-14 补）。
   * 上面那条用例先跑了 GitHub 回调（它会 ensureSchema），所以掩盖了这个洞：
   * 注册 / 登录 / 投稿 / 投票都是**先查封禁与限流（bans / rate_limits）、后建表**，
   * 空库上第一个请求必然 500 `no such table: bans` —— 本地 wrangler dev 起新库时就是这么炸的。
   * 现在 http.ts 的 isBanned / allowWrite 把「表还没建」当成「没有记录」（只吞这一种错）。
   */
  await t.test('空库上的第一个请求就是注册：不能 500（封禁与限流表还没建）', async () => {
    const { call, one } = await setup({ empty: true });
    const r = await call('/api/register', { method: 'POST', body: { name: '空库第一人', password: 'pass12345' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.user.name, '空库第一人');
    for (const table of ['users', 'bans', 'rate_limits']) {
      assert.ok(one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table), `缺表：${table}`);
    }
    /* 紧接着的第二个请求要走正常的限流计数（表已经建好了） */
    const again = await call('/api/register', { method: 'POST', body: { name: '空库第二人', password: 'pass12345' } });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.ok(Number(one(`SELECT COUNT(*) AS n FROM rate_limits`).n) > 0, '限流计数开始记了');
  });

  await t.test('拿不到贡献者名单（没配 GITHUB_TOKEN）→ 照样能登录，只是不自动发称号', async () => {    const { call, env } = await setup();
    withGithub(env); // 故意不给 GITHUB_TOKEN
    const gh = fakeGithub({ goodCode: 'code-1', contributors: [{ login: 'octocat', contributions: 3 }] });
    await call('/api/auth/github/start');
    const state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    const r = await call(`/api/auth/github/callback?code=code-1&state=${state}`);
    gh.restore();

    assert.match(r.res.headers.get('location') ?? '', /gh=new/, '名单读不到不该挡住登录');
    const me = await call('/api/me');
    assert.equal(me.data.user.ghLogin.login, 'octocat', '绑定信息照样有');
    assert.equal(me.data.user.gh, undefined, '称号要有人工/名单依据，读不到就不发');
  });

  await t.test('callback：同一个 GitHub 号再来一次 → 还是那个账号（不会重复建号）', async () => {
    const { call, env, db } = await setup();
    withGithub(env);
    let gh = fakeGithub({ goodCode: 'code-1' });
    await call('/api/auth/github/start');
    let state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    await call(`/api/auth/github/callback?code=code-1&state=${state}`);
    gh.restore();

    await call('/api/logout', { method: 'POST', body: {} });
    gh = fakeGithub({ goodCode: 'code-2' });
    await call('/api/auth/github/start');
    state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    const again = await call(`/api/auth/github/callback?code=code-2&state=${state}`);
    gh.restore();
    assert.match(again.res.headers.get('location') ?? '', /gh=ok/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 1, '一个 GitHub 号只对应一个站内账号');
  });

  await t.test('已登录 + 已有口令账号 → 绑定 GitHub（不新建账号）', async () => {
    const { call, env, db } = await setup();
    withGithub(env);
    await call('/api/register', { method: 'POST', body: { name: '老用户', password: 'pass12345' } });
    assert.equal((await call('/api/me')).data.user.ghLogin, undefined, '一开始没绑');

    const gh = fakeGithub({ goodCode: 'code-bind' });
    await call('/api/auth/github/start');
    const state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    const r = await call(`/api/auth/github/callback?code=code-bind&state=${state}`);
    gh.restore();

    assert.match(r.res.headers.get('location') ?? '', /gh=bound/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 1, '绑定不该多出一个账号');
    const me = await call('/api/me');
    assert.equal(me.data.user.name, '老用户', '昵称不变');
    assert.equal(me.data.user.ghLogin.login, 'octocat');
    assert.equal(me.data.user.ghLogin.hasPassword, true);
    assert.equal(me.data.user.gh, undefined, '没在贡献者名单里 → 不该凭空多一个称号');
    /* 绑定之后照样能用口令登录（GitHub 只是多了一条路） */
    await call('/api/logout', { method: 'POST', body: {} });
    const byPass = await call('/api/login', { method: 'POST', body: { name: '老用户', password: 'pass12345' } });
    assert.equal(byPass.status, 200, '口令这条路完全没被动过');
  });

  await t.test('一个 GitHub 号不能同时绑两个站内账号', async () => {
    const { call, env, db } = await setup();
    withGithub(env);
    await call('/api/register', { method: 'POST', body: { name: '甲用户', password: 'pass12345' } });
    let gh = fakeGithub({ goodCode: 'code-a' });
    await call('/api/auth/github/start');
    let state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    await call(`/api/auth/github/callback?code=code-a&state=${state}`);
    gh.restore();
    await call('/api/logout', { method: 'POST', body: {} });

    await call('/api/register', { method: 'POST', body: { name: '乙用户', password: 'pass12345' } });
    gh = fakeGithub({ goodCode: 'code-b' });
    await call('/api/auth/github/start');
    state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    const r = await call(`/api/auth/github/callback?code=code-b&state=${state}`);
    gh.restore();
    assert.match(r.res.headers.get('location') ?? '', /gh=taken/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE gh_id IS NOT NULL`).get().n, 1, '还是只有一个账号绑着它');
  });

  await t.test('昵称已被占用 → 换个候选名建号，不抢别人的名字', async () => {
    const { call, env, db } = await setup();
    withGithub(env);
    await call('/api/register', { method: 'POST', body: { name: 'octocat', password: 'pass12345' } });
    await call('/api/logout', { method: 'POST', body: {} });

    const gh = fakeGithub({ goodCode: 'code-dup' });
    await call('/api/auth/github/start');
    const state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    await call(`/api/auth/github/callback?code=code-dup&state=${state}`);
    gh.restore();

    const rows = db.prepare(`SELECT name, gh_id FROM users ORDER BY id`).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'octocat');
    assert.equal(rows[0].gh_id, null, '原来那个口令账号没被抢走 / 没被绑定');
    assert.notEqual(rows[1].name, 'octocat', '新号换了个候选名');
    assert.equal(rows[1].gh_id, 4242);
  });

  await t.test('被封禁的账号 / 来源 → GitHub 登录也进不来', async () => {
    const { call, env, db } = await setup();
    withGithub(env);
    let gh = fakeGithub({ goodCode: 'code-1' });
    await call('/api/auth/github/start');
    let state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    await call(`/api/auth/github/callback?code=code-1&state=${state}`);
    gh.restore();

    db.prepare(`UPDATE users SET banned = 1 WHERE gh_id = 4242`).run();
    await call('/api/logout', { method: 'POST', body: {} });
    gh = fakeGithub({ goodCode: 'code-2' });
    await call('/api/auth/github/start');
    state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    const banned = await call(`/api/auth/github/callback?code=code-2&state=${state}`);
    gh.restore();
    assert.match(banned.res.headers.get('location') ?? '', /gh=disabled/);
    assert.equal((await call('/api/me')).data.user, null, '没发号');
  });

  await t.test('解绑：没口令的账号先拒（否则会把自己锁在外面）；设了口令才能解绑', async () => {
    const { call, env } = await setup();
    withGithub(env);
    const gh = fakeGithub({ goodCode: 'code-1' });
    await call('/api/auth/github/start');
    const state = new URL((await call('/api/auth/github/start')).res.headers.get('location')).searchParams.get('state');
    await call(`/api/auth/github/callback?code=code-1&state=${state}`);
    gh.restore();

    const refused = await call('/api/auth/github/unbind', { method: 'POST', body: {} });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /先.*设一个口令|还没有口令/);

    /* 没有口令也能设口令（不校验原口令）——这是 GitHub 建的号唯一能设口令的路径 */
    const set = await call('/api/password', { method: 'POST', body: { oldPassword: '', newPassword: 'newpass12345' } });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    assert.match(set.data.message, /已设置口令/);

    const ok = await call('/api/auth/github/unbind', { method: 'POST', body: {} });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.user.ghLogin, undefined);
    /* 解绑后用新口令照样登录 */
    await call('/api/logout', { method: 'POST', body: {} });
    const byPass = await call('/api/login', { method: 'POST', body: { name: 'octocat', password: 'newpass12345' } });
    assert.equal(byPass.status, 200, '解绑后口令这条路必须还在');
  });

  await t.test('已有的口令账号不能用「空原口令」改口令（安全底线）', async () => {
    const { call, env } = await setup();
    withGithub(env);
    await call('/api/register', { method: 'POST', body: { name: '有口令的人', password: 'pass12345' } });
    const bad = await call('/api/password', { method: 'POST', body: { oldPassword: '', newPassword: 'newpass12345' } });
    assert.equal(bad.status, 401, '有口令的账号仍然必须验原口令');
  });
});

/* ===== 站内收件箱（2026-10-14） =====
 *
 * 站长要的：审核通过 / 写回上线 / 草稿被采纳 / 站长公告 → 账号旁边一个红点，点开逐条看，也能一键已读。
 * 这一组用例把「谁会收到、收到什么、已读怎么算、会不会串号」全部钉住：
 *   · 每条通知都必须挂在**正确的人**头上（别人的私信看不到、也标不了已读）；
 *   · 公告只有一行（user_id IS NULL），但每个人的已读互不影响；
 *   · 未登录 401、旧库没表也能用（懒建表）、标记已读是幂等的。
 */
test('站内收件箱：审核 / 写回 / 采纳 / 公告都进收件箱，已读各算各的', async (t) => {
  await t.test('没登录不给看：GET / POST 都是 401', async () => {
    const { call } = await setup();
    const list = await call('/api/me/notifications');
    assert.equal(list.status, 401, JSON.stringify(list.data));
    const read = await call('/api/me/notifications/read', { method: 'POST', body: { all: true } });
    assert.equal(read.status, 401);
  });

  await t.test('空库也能用：新账号收件箱是空的，unread=0', async () => {
    const { call } = await setup();
    await register(call, '新来的');
    const r = await call('/api/me/notifications');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.items, []);
    assert.equal(r.data.unread, 0);
    assert.equal(r.data.total, 0);
  });

  await t.test('投稿通过 / 驳回：各来一条通知，理由跟着走；已读幂等', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const me = await register(call, '投稿的人');
    const userId = me.data.user.id;

    /* 两条投稿：一条通过、一条驳回（都挂在这个账号上） */
    const a = await call('/api/submit', {
      method: 'POST',
      body: submitBody({ map: 'ze_alpha', field: 'difficulty', value: '困难' }),
    });
    const b = await call('/api/submit', {
      method: 'POST',
      body: submitBody({ map: 'ze_beta', field: 'difficulty', value: '普通' }),
    });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(b.status, 200, JSON.stringify(b.data));

    await call('/api/admin/review', { method: 'POST', body: { id: a.data.id, action: 'approve' }, headers: auth });
    await call('/api/admin/review', {
      method: 'POST',
      body: { id: b.data.id, action: 'reject', rejectNote: '难度写错了' },
      headers: auth,
    });

    const list = await call('/api/me/notifications');
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.unread, 2, '通过 + 驳回各一条');
    const titles = list.data.items.map((x) => x.title);
    assert.ok(titles.some((x) => /投稿已通过/.test(x)), titles.join(' / '));
    assert.ok(titles.some((x) => /投稿被驳回/.test(x)), titles.join(' / '));
    const rejected = list.data.items.find((x) => /驳回/.test(x.title));
    assert.match(rejected.body, /难度写错了/, '驳回理由要原样带上');
    assert.equal(rejected.submissionId, b.data.id);
    assert.equal(rejected.read, false);
    assert.equal(rejected.broadcast, false);

    /* 单条已读：只影响那一条 */
    const one = await call('/api/me/notifications/read', { method: 'POST', body: { ids: [rejected.id] } });
    assert.equal(one.status, 200, JSON.stringify(one.data));
    assert.equal(one.data.marked, 1);
    assert.equal(one.data.unread, 1);

    /* 重复标同一条：幂等，不再增加 marked */
    const again = await call('/api/me/notifications/read', { method: 'POST', body: { ids: [rejected.id] } });
    assert.equal(again.data.marked, 0, 'OR IGNORE：重复标记不报错也不重复计数');
    assert.equal(again.data.unread, 1);

    /* 全部已读 */
    const all = await call('/api/me/notifications/read', { method: 'POST', body: { all: true } });
    assert.equal(all.data.unread, 0);
    const after = await call('/api/me/notifications');
    assert.ok(after.data.items.every((x) => x.read), '全部标记后每条都是已读');
    assert.equal(userId, me.data.user.id);
  });

  await t.test('写回上线：按「人 + 图」聚合成一条，带上字段与页面链接', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '整理的人');

    /* 同一个人对同一张图投了两个字段 → 写回后应当只有 1 条通知、字段列两个 */
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter, user_id)
       VALUES ('ze_gamma', ?, ?, 'h', 'approved', ?, '整理的人', 1)`
    );
    ins.run('difficulty', JSON.stringify('困难'), Date.now());
    ins.run('duration', JSON.stringify('40 分钟'), Date.now() + 1);

    const repo = installFakeRepo({
      'data/community/ze_gamma.json':
        JSON.stringify({ v: 1, slug: 'ze_gamma', updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] }, null, 2) + '\n',
    });
    try {
      const flush = await call('/api/admin/flush', { method: 'POST', body: {}, headers: auth });
      assert.equal(flush.status, 200, JSON.stringify(flush.data));
      assert.equal(flush.data.committed, 2);
    } finally {
      repo.restore();
    }

    const list = await call('/api/me/notifications');
    const up = list.data.items.filter((x) => x.kind === 'flush');
    assert.equal(up.length, 1, '同一张图的多条投稿聚合成一条通知');
    assert.match(up[0].title, /投稿已上线/);
    assert.match(up[0].title, /ze_gamma/);
    assert.match(up[0].body, /2 条投稿/);
    assert.match(up[0].body, /难度/);
    assert.match(up[0].body, /时长|游戏时长|单局时长|40 分钟/, '字段中文名要写进正文');
    assert.equal(up[0].link, '/maps/ze_gamma/');
  });

  await t.test('草稿被采纳：整理者收到一条「已采纳」', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '写草稿的人');

    const draft = '## 关卡流程\n\n第一关：跳刀。\n';
    db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter, user_id)
       VALUES ('ze_delta','draft',?,'h','applied',?, '写草稿的人', 1)`
    ).run(JSON.stringify(draft), Date.now());

    const repo = installFakeRepo({
      'data/research/ze_delta.json':
        JSON.stringify({ title: '德尔塔', sections: [{ title: '基本信息', body: '原样' }], confidence: 'medium' }, null, 2) + '\n',
      'data/community/ze_delta.json':
        JSON.stringify({ v: 1, slug: 'ze_delta', updatedAt: null, fields: {}, notes: [], draft: draft, items: [], log: [] }, null, 2) + '\n',
    });
    try {
      const adopt = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_delta' }, headers: auth });
      assert.equal(adopt.status, 200, JSON.stringify(adopt.data));
    } finally {
      repo.restore();
    }

    const list = await call('/api/me/notifications');
    const hit = list.data.items.find((x) => x.kind === 'adopt');
    assert.ok(hit, '采纳后应当有通知：' + list.data.items.map((x) => x.title).join(' / '));
    assert.match(hit.title, /草稿已被采纳/);
    assert.match(hit.body, /新增 1 节|替换 1 节/);
    assert.equal(hit.link, '/maps/ze_delta/');
  });

  await t.test('公告：只有一行，两个账号都看得到，已读互不影响', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '甲甲');
    const jia = (await call('/api/me')).data.user.id;

    const post = await call('/api/admin/announce', {
      method: 'POST',
      body: { title: '站点维护通知', body: '今晚 23:00 重建一次，页面短暂 502 属正常。', link: '/about/' },
      headers: auth,
    });
    assert.equal(post.status, 200, JSON.stringify(post.data));
    assert.equal(post.data.recipients, 1, '当时只有 1 个账号');

    const rows = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id IS NULL`).all();
    assert.equal(rows[0].n, 1, '公告只存一行（不是每人一行）');

    /* 甲读了 */
    const listA = await call('/api/me/notifications');
    assert.equal(listA.data.unread, 1);
    assert.equal(listA.data.items[0].broadcast, true, '公告要标出来');
    await call('/api/me/notifications/read', { method: 'POST', body: { all: true } });
    assert.equal((await call('/api/me/notifications')).data.unread, 0);

    /* 乙后注册（公告是注册前发的，照样看得到），但他还是未读 —— 已读各算各的 */
    await call('/api/logout', { method: 'POST', body: {} });
    await register(call, '乙乙');
    const listB = await call('/api/me/notifications');
    assert.equal(listB.data.unread, 1, '别人的已读不影响我');
    assert.equal(listB.data.items[0].title, '站点维护通知');
    const yi = (await call('/api/me')).data.user.id;
    assert.notEqual(yi, jia);
  });

  await t.test('不会串号：看不到别人的私信，也标不了别人的已读', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };

    await register(call, '甲甲');
    const sub = await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_alpha' }) });
    await call('/api/admin/review', { method: 'POST', body: { id: sub.data.id, action: 'approve' }, headers: auth });
    const mine = await call('/api/me/notifications');
    const myId = mine.data.items[0].id;

    await call('/api/logout', { method: 'POST', body: {} });
    await register(call, '乙乙');
    const other = await call('/api/me/notifications');
    assert.equal(other.data.items.length, 0, '乙不该看到甲的审核通知');
    assert.equal(other.data.unread, 0);

    const tryMark = await call('/api/me/notifications/read', { method: 'POST', body: { ids: [myId] } });
    assert.equal(tryMark.status, 200, JSON.stringify(tryMark.data));
    assert.equal(tryMark.data.marked, 0, '别人的通知标不了');
    assert.equal(tryMark.data.unread, 0);
  });

  await t.test('分页与入参校验：limit/offset 生效，垃圾入参被拒', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '收公告的人');
    for (let i = 0; i < 3; i++) {
      await call('/api/admin/announce', { method: 'POST', body: { title: `公告 ${i + 1}` }, headers: auth });
    }

    const page1 = await call('/api/me/notifications?limit=2');
    assert.equal(page1.data.items.length, 2);
    assert.equal(page1.data.total, 3);
    assert.equal(page1.data.unread, 3);
    const page2 = await call('/api/me/notifications?limit=2&offset=2');
    assert.equal(page2.data.items.length, 1);
    assert.notEqual(page2.data.items[0].id, page1.data.items[0].id, '第二页不该和第一页重复');

    const noIds = await call('/api/me/notifications/read', { method: 'POST', body: {} });
    assert.equal(noIds.status, 400);
    const tooMany = await call('/api/me/notifications/read', {
      method: 'POST',
      body: { ids: Array.from({ length: 101 }, (_, i) => i + 1) },
    });
    assert.equal(tooMany.status, 400);
    const noTitle = await call('/api/admin/announce', { method: 'POST', body: { title: '  ' }, headers: auth });
    assert.equal(noTitle.status, 400);
  });

  await t.test('账号事件也进收件箱：停用 / 恢复 / 重置口令 / 改名', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const me = await register(call, '被处理的账号');
    const id = me.data.user.id;

    await call('/api/admin/accounts', { method: 'POST', body: { id, action: 'ban' }, headers: auth });
    await call('/api/admin/accounts', { method: 'POST', body: { id, action: 'unban' }, headers: auth });
    await call('/api/admin/accounts', { method: 'POST', body: { id, action: 'reset' }, headers: auth });
    await call('/api/admin/accounts', { method: 'POST', body: { id, action: 'rename', name: '改过的名字' }, headers: auth });

    /* 重置口令会让旧会话失效 → 用新昵称 + 临时口令重新登录（临时口令只在管理员响应里） */
    const reset = await call('/api/admin/accounts', { method: 'POST', body: { id, action: 'reset' }, headers: auth });
    const temp = reset.data.tempPassword;
    await call('/api/login', { method: 'POST', body: { name: '改过的名字', password: temp } });

    const list = await call('/api/me/notifications');
    const titles = list.data.items.map((x) => x.title);
    for (const want of ['账号已被停用', '账号已恢复', '口令已被站长重置', '你的昵称被站长改了']) {
      assert.ok(titles.includes(want), `缺「${want}」，现有：${titles.join(' / ')}`);
    }
    const resetNote = list.data.items.find((x) => x.title === '口令已被站长重置');
    assert.doesNotMatch(resetNote.body, /[a-zA-Z0-9]{10}/, '临时口令绝不能写进收件箱');
    assert.ok(list.data.unread >= 4);
  });
});

/* ===== 邮箱页（/inbox/，2026-10-15） =====
 *
 * 站长的原话：「能不能单开一个邮箱标签页，里面可以查看每次的公告及个人通告之类的，
 * 就跟正常的邮箱一样」。页面本身是静态的，功能全在这两个接口上：
 *   GET  /api/me/notifications?folder=…  四个文件夹（全部/未读/公告/投稿/账号）+ 各自的条数
 *   POST /api/me/notifications/read      { ids, unread: true } 标为未读（正常邮箱都有这个键）
 * 这一组用例钉住：分类口径、条数、未读过滤、标为未读，以及「别人的信照样动不了」。
 */
test('邮箱页：文件夹分类、各自条数、标为未读', async (t) => {
  await t.test('folder 分四类，counts 给各档条数（公告 / 投稿 / 账号互斥且加起来是全部）', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '收信的人');

    /* 一条公告 + 一条投稿通知（审核通过）+ 一条账号事件（改名） */
    await call('/api/admin/announce', { method: 'POST', body: { title: '站长公告一' }, headers: auth });
    const sub = await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_mailbox' }) });
    await call('/api/admin/review', {
      method: 'POST',
      body: { id: sub.data.id, action: 'approve' },
      headers: auth,
    });
    const me = await call('/api/me');
    await call('/api/admin/accounts', {
      method: 'POST',
      body: { id: me.data.user.id, action: 'rename', name: '改了名的收信人' },
      headers: auth,
    });

    const all = await call('/api/me/notifications?folder=all');
    assert.equal(all.status, 200, JSON.stringify(all.data));
    assert.equal(all.data.folder, 'all');
    assert.equal(all.data.total, 3, '三封信都在「全部」里');
    assert.equal(all.data.counts.all, 3);
    assert.equal(all.data.counts.announce, 1, '公告 1');
    assert.equal(all.data.counts.mine, 1, '投稿通知 1（审核通过）');
    assert.equal(all.data.counts.account, 1, '账号事件 1（改名）');
    assert.equal(all.data.counts.unread, 3);
    assert.equal(
      all.data.counts.announce + all.data.counts.mine + all.data.counts.account,
      all.data.counts.all,
      '三类互斥，加起来正好是全部'
    );

    const announce = await call('/api/me/notifications?folder=announce');
    assert.equal(announce.data.total, 1);
    assert.equal(announce.data.items[0].title, '站长公告一');
    assert.equal(announce.data.items[0].broadcast, true);

    const mine = await call('/api/me/notifications?folder=mine');
    assert.equal(mine.data.total, 1);
    assert.equal(mine.data.items[0].kind, 'review', '投稿通知 = 审核 / 写回 / 采纳');

    const account = await call('/api/me/notifications?folder=account');
    assert.equal(account.data.total, 1);
    assert.equal(account.data.items[0].kind, 'account');

    /* counts 是「全局」的：切到某一档时也要给全（左栏一直要画那几个数字） */
    assert.equal(mine.data.counts.all, 3, 'counts 与当前档无关');
    assert.equal(mine.data.counts.announce, 1);

    /* 不认识的 folder 当 all，别 400 —— 前端拼错一个参数不该让整页打不开 */
    const junk = await call('/api/me/notifications?folder=nonsense');
    assert.equal(junk.status, 200);
    assert.equal(junk.data.folder, 'all');
    assert.equal(junk.data.total, 3);
  });

  await t.test('未读档：只列未读；标为已读后从这一档消失，条数跟着掉', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '未读测试');
    for (let i = 0; i < 3; i++) {
      await call('/api/admin/announce', { method: 'POST', body: { title: `公告 ${i + 1}` }, headers: auth });
    }

    const unreadFold = await call('/api/me/notifications?folder=unread');
    assert.equal(unreadFold.data.total, 3);
    const first = unreadFold.data.items[0];

    await call('/api/me/notifications/read', { method: 'POST', body: { ids: [first.id] } });
    const after = await call('/api/me/notifications?folder=unread');
    assert.equal(after.data.total, 2, '读过的不再算未读');
    assert.ok(
      !after.data.items.some((x) => x.id === first.id),
      '读过的那条不在未读档里'
    );
    assert.equal(after.data.counts.unread, 2);
    assert.equal(after.data.counts.all, 3, '「全部」那档照旧三条');
  });

  await t.test('标为未读：{ ids, unread:true } 把已读的放回未读，红点重新亮起来', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '标未读的人');
    await call('/api/admin/announce', { method: 'POST', body: { title: '一封公告' }, headers: auth });

    const list = await call('/api/me/notifications');
    const id = list.data.items[0].id;
    await call('/api/me/notifications/read', { method: 'POST', body: { all: true } });
    assert.equal((await call('/api/me/notifications')).data.unread, 0);

    const back = await call('/api/me/notifications/read', { method: 'POST', body: { ids: [id], unread: true } });
    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal(back.data.marked, 1, '放回了一条');
    assert.equal(back.data.unread, 1, '未读数回到 1');

    const after = await call('/api/me/notifications?folder=unread');
    assert.equal(after.data.total, 1);
    assert.equal(after.data.items[0].read, false);

    /* 幂等：再标一次不报错，也不会变成 2 条未读 */
    const again = await call('/api/me/notifications/read', { method: 'POST', body: { ids: [id], unread: true } });
    assert.equal(again.data.marked, 0);
    assert.equal(again.data.unread, 1);

    const noIds = await call('/api/me/notifications/read', { method: 'POST', body: { unread: true } });
    assert.equal(noIds.status, 400, '标为未读要写 ids');
  });

  await t.test('别人的信还是动不了：folder 里看不到，标未读也标不了', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };

    await register(call, '甲甲');
    const sub = await call('/api/submit', { method: 'POST', body: submitBody({ map: 'ze_mailbox2' }) });
    await call('/api/admin/review', { method: 'POST', body: { id: sub.data.id, action: 'approve' }, headers: auth });
    const mine = await call('/api/me/notifications?folder=mine');
    const myId = mine.data.items[0].id;
    await call('/api/me/notifications/read', { method: 'POST', body: { ids: [myId] } });

    await call('/api/logout', { method: 'POST', body: {} });
    await register(call, '乙乙');
    const other = await call('/api/me/notifications?folder=mine');
    assert.equal(other.data.total, 0, '乙的「投稿通知」里没有甲的信');
    assert.equal(other.data.counts.mine, 0);

    const tryUnread = await call('/api/me/notifications/read', { method: 'POST', body: { ids: [myId], unread: true } });
    assert.equal(tryUnread.data.marked, 0, '标不了别人的未读');
    assert.equal(tryUnread.data.unread, 0);
  });
});

/* ===== R2 同源回退（/terr/*）：地形分片与图集图片 =====
 *
 * 为什么值得单测：这条路是**国内部分网络下站点还能用的唯一依靠** ——
 * R2 自定义域 terr.ze-map.cn 在那些网络里不通，前端失败后回退到这里。
 * 2026-10-15 之前它只认 `terr/<id>.bin`，图集图片（十几张、每张 ~45 KB）没有回退，
 * 域不通的用户看到的就是一片裂图。这里钉住：图集路径收、危险路径不收、类型/缓存头对。
 */
test('R2 同源回退：地形分片与图集图片都能取，路径不合法一律 400', async (t) => {
  const { call, env } = await setup();
  const store = new Map([
    ['terr/3716633440.bin', { body: 'BIN', type: 'application/octet-stream' }],
    ['gallery/ze_visualizer/u357.webp', { body: 'WEBP', type: 'image/webp' }],
    ['gallery/ze_visualizer/05-workshop.jpg', { body: 'JPG', type: 'image/jpeg' }],
  ]);
  env.TERR = {
    get: async (key) => {
      const hit = store.get(key);
      return hit ? { body: new Response(hit.body).body, size: hit.body.length } : null;
    },
  };
  /* Node 里没有 Cloudflare 的 caches.default：给个空壳，命中/写缓存都不影响断言 */
  const cacheStore = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => cacheStore.get(new Request(req).url),
      put: async (req, res) => {
        cacheStore.set(new Request(req).url, res);
      },
    },
  };

  await t.test('地形分片：200 + octet-stream + 一年不可变', async () => {
    const r = await call('/terr/3716633440.bin');
    assert.equal(r.res.status, 200);
    assert.equal(r.res.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.res.headers.get('cache-control') ?? '', /immutable/);
  });

  await t.test('图集图片：200 + 正确的 image 类型（webp / jpg 都要认）', async () => {
    const webp = await call('/terr/gallery/ze_visualizer/u357.webp');
    assert.equal(webp.res.status, 200, '图集图片必须有回退 —— 不然 terr 域不通时图片集全是裂图');
    assert.equal(webp.res.headers.get('content-type'), 'image/webp');
    assert.match(webp.res.headers.get('cache-control') ?? '', /immutable/);

    const jpg = await call('/terr/gallery/ze_visualizer/05-workshop.jpg');
    assert.equal(jpg.res.status, 200);
    assert.equal(jpg.res.headers.get('content-type'), 'image/jpeg');
  });

  await t.test('路径不合法：400 / 404，不能拿它当任意 R2 读取器', async () => {
    /* %2e%2e%2f 不会被 URL 解析器规范化掉 —— 这才真的走到路由里（未编码的 ../ 会被浏览器/解析器先规整） */
    const evil = await call('/terr/gallery/%2e%2e%2f%2e%2e%2fsecret.webp');
    assert.equal(evil.res.status, 400, '穿目录的路径必须拒');
    const badExt = await call('/terr/gallery/ze_visualizer/payload.bin');
    assert.equal(badExt.res.status, 400, '图集只收图片扩展名');
    const badPrefix = await call('/terr/videos/x.mp4');
    assert.equal(badPrefix.res.status, 400);
    const missing = await call('/terr/gallery/ze_visualizer/nope.webp');
    assert.equal(missing.res.status, 404, 'R2 里没有就是 404');
    const post = await call('/terr/3716633440.bin', { method: 'POST' });
    assert.equal(post.res.status, 405);
  });
});

/* ===== 审核台「整篇草稿」那一档（2026-10-15） =====
 *
 * 站长的原话：「找整篇条目草稿太麻烦，审核好的全都堆叠在一块，很难采纳为原稿」。
 * 于是队列加了 `field` 过滤 + `fieldCounts`（草稿档那几个小标签的计数）。
 * 这一组用例钉住：只看 draft、不串别的字段、字段不合法要拒、现值回的是「草稿状态对象」。
 */
test('审核台整篇草稿档：field 过滤 + 计数 + 草稿现值（采纳过没有）', async (t) => {
  await t.test('field=draft 只回草稿；fieldCounts 给出各状态条数', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES (?,?,?,'h',?,?, '某人')`
    );
    ins.run('ze_drafts', 'draft', JSON.stringify('## 关卡\n第一关：跳刀。\n'), 'applied', 1000);
    ins.run('ze_drafts2', 'draft', JSON.stringify('## 关卡\n另一篇。\n'), 'applied', 2000);
    ins.run('ze_drafts3', 'draft', JSON.stringify('## 关卡\n待审的。\n'), 'pending', 3000);
    ins.run('ze_other', 'difficulty', JSON.stringify('困难'), 'applied', 4000);

    const all = await call('/api/admin/queue?status=applied', { headers: auth });
    assert.equal(all.data.items.length, 3, '不筛字段时：两条草稿 + 一条难度');

    const drafts = await call('/api/admin/queue?status=applied&field=draft', { headers: auth });
    assert.equal(drafts.status, 200, JSON.stringify(drafts.data));
    assert.equal(drafts.data.items.length, 2, '只回整篇草稿');
    assert.ok(drafts.data.items.every((x) => x.field === 'draft'), '不混别的字段');
    assert.equal(drafts.data.total, 2);
    assert.equal(drafts.data.field, 'draft');
    assert.equal(drafts.data.fieldCounts.applied, 2, '待采纳 2 条');
    assert.equal(drafts.data.fieldCounts.pending, 1, '待审 1 条');

    const bad = await call('/api/admin/queue?status=applied&field=nope', { headers: auth });
    assert.equal(bad.status, 400, '不认识的字段要拒');
  });

  /*
   * 采纳过的草稿要从「待采纳」里走开（2026-10-15 加）。
   * 站长的原话是「审核好的全都堆叠在一块我怎么找」—— 光按字段分开还不够：
   * 采纳完的草稿仍留在那一档里，攒上十几条又变成一堆翻不完的存货，
   * 而且它们其实已经进正文了、点「采纳为原稿」只会撞 409。
   * 现在采纳时往 submissions.adopted_at 记一笔，队列默认把它们排除（adopted=1 才列）。
   */
  await t.test('采纳过的草稿不再列在「待采纳」里（adopted=1 才看得到）', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES (?,?,?,'h','applied',?, '整理者')`
    );
    ins.run('ze_adopt1', 'draft', JSON.stringify('## 基本信息\n\n甲篇内容\n'), 1000);
    ins.run('ze_adopt2', 'draft', JSON.stringify('## 基本信息\n\n乙篇内容\n'), 2000);
    ins.run('ze_adopt3', 'difficulty', JSON.stringify('困难'), 3000);

    const before = await call('/api/admin/queue?status=applied&field=draft', { headers: auth });
    assert.equal(before.data.items.length, 2, '两条草稿都还等着采纳');
    assert.equal(before.data.fieldCounts.applied, 2);
    assert.equal(before.data.adoptedCount, 0, '还没采纳过');
    assert.ok(
      before.data.items.every((x) => x.adopted_at == null),
      '待采纳的条目不带采纳时间'
    );

    /* 真走一遍采纳（假仓库 + 假 GitHub），看 adopted_at 有没有落下 */
    const repo = installFakeRepo({
      'data/research/ze_adopt1.json':
        JSON.stringify({ sections: [{ title: '基本信息', body: '旧的一节' }], confidence: 'low' }, null, 2) + '\n',
      'data/community/ze_adopt1.json':
        JSON.stringify({ v: 1, slug: 'ze_adopt1', updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] }, null, 2) + '\n',
    });
    try {
      const adopted = await call('/api/admin/adopt', { method: 'POST', body: { slug: 'ze_adopt1' }, headers: auth });
      assert.equal(adopted.status, 200, JSON.stringify(adopted.data));
    } finally {
      repo.restore();
    }
    const row = db.prepare(`SELECT adopted_at, commit_sha FROM submissions WHERE map_slug='ze_adopt1'`).get();
    assert.ok(Number(row.adopted_at) > 0, '采纳后必须记下采纳时间（审核台靠它排掉已采纳的）');
    assert.ok(row.commit_sha, '顺手记下提交号');

    const after = await call('/api/admin/queue?status=applied&field=draft', { headers: auth });
    assert.equal(after.data.items.length, 1, '已采纳的从待采纳里走开');
    assert.equal(after.data.items[0].map_slug, 'ze_adopt2', '留下的是还没采纳的那条');
    assert.equal(after.data.fieldCounts.applied, 1, '「待采纳」计数要跟着掉');
    assert.equal(after.data.adoptedCount, 1, '另给一句「已采纳 1 篇」');

    const adoptedOnly = await call('/api/admin/queue?status=applied&field=draft&adopted=1', { headers: auth });
    assert.equal(adoptedOnly.data.items.length, 1, 'adopted=1 时只看已采纳的');
    assert.equal(adoptedOnly.data.items[0].map_slug, 'ze_adopt1');
    assert.ok(Number(adoptedOnly.data.items[0].adopted_at) > 0);

    /* 别的字段不受影响：difficulty 那条照旧列出来（它没有「采纳」这一步） */
    const other = await call('/api/admin/queue?status=applied&field=difficulty', { headers: auth });
    assert.equal(other.data.items.length, 1, '难度的队列不该被采纳标记影响');
    assert.equal(other.data.adoptedCount, 0, '非草稿字段没有「已采纳」这回事');
  });

  /*
   * 同一张图攒下多条「已写回」草稿时，只列最新的一条（2026-10-15 加）。
   * 作者改一版就重投一次，老的那几条既采纳不到（服务端取的是 ORDER BY id DESC LIMIT 1），
   * 内容又跟真正会合并进去的那篇不一样 —— 列出来只会让「待采纳」重新变长、还容易看错。
   */
  await t.test('同一张图多条已写回草稿：待采纳只列最新那条，计数同口径', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    const ins = db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES (?,?,?,'h',?,?, '整理者')`
    );
    ins.run('ze_dup', 'draft', JSON.stringify('## 基本信息\n第一版\n'), 'applied', 1000);
    ins.run('ze_dup', 'draft', JSON.stringify('## 基本信息\n第二版（最新）\n'), 'applied', 2000);
    ins.run('ze_dup', 'draft', JSON.stringify('## 基本信息\n第三版还在审\n'), 'pending', 3000);
    ins.run('ze_other2', 'draft', JSON.stringify('## 基本信息\n别的图\n'), 'applied', 4000);
    const newest = db.prepare(`SELECT MAX(id) AS id FROM submissions WHERE map_slug='ze_dup' AND status='applied'`).get();

    const q = await call('/api/admin/queue?status=applied&field=draft', { headers: auth });
    assert.equal(q.data.items.length, 2, '一张图一条 + 另一张图一条');
    const dup = q.data.items.find((x) => x.map_slug === 'ze_dup');
    assert.equal(dup.id, newest.id, '留下的是最新那版');
    assert.match(String(dup.value), /第二版/);
    assert.equal(q.data.fieldCounts.applied, 2, '角标数跟列表条数一致（不是 3）');

    /* 别的状态档不受这条规则影响：待审那版照样列出来 */
    const p = await call('/api/admin/queue?status=pending&field=draft', { headers: auth });
    assert.equal(p.data.items.length, 1, '待审档该有几条是几条');
    assert.match(String(p.data.items[0].value), /第三版/);
    assert.equal(p.data.fieldCounts.pending, 1);
  });

  await t.test('草稿现值：没采纳时给字数与整理者；采纳后给「已采纳」标记', async () => {
    const { call, env, db } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    db.prepare(
      `INSERT INTO submissions (map_slug, field, value, ip_hash, status, created_at, submitter)
       VALUES ('ze_draftcur','draft',?,'h','applied',?, '整理者')`
    ).run(JSON.stringify('## 关卡\n第一关：跳刀。\n'), 1000);
    const row = db.prepare(`SELECT id FROM submissions WHERE map_slug='ze_draftcur'`).get();

    /* 页面上正挂着草稿（没采纳） */
    const repo = installFakeRepo({
      'data/community/ze_draftcur.json':
        JSON.stringify(
          {
            v: 1,
            slug: 'ze_draftcur',
            updatedAt: null,
            fields: {},
            notes: [],
            draft: { text: '## 关卡\n第一关：跳刀。\n', by: '整理者', at: '2026-10-15T00:00:00.000Z', submission: row.id },
            items: [],
            log: [],
          },
          null,
          2
        ) + '\n',
    });
    try {
      const cur = await call(`/api/admin/current?ids=${row.id}`, { headers: auth });
      assert.equal(cur.status, 200, JSON.stringify(cur.data));
      const info = cur.data.current[String(row.id)];
      assert.equal(info.adopted, null, '还没采纳');
      assert.equal(info.draftBy, '整理者');
      assert.ok(info.draftChars > 5, `草稿字数要算出来（实际 ${info.draftChars}）`);
    } finally {
      repo.restore();
    }

    /* 采纳之后：草稿位清空、fields.draft 记「已采纳」 */
    const repo2 = installFakeRepo({
      'data/community/ze_draftcur.json':
        JSON.stringify(
          {
            v: 1,
            slug: 'ze_draftcur',
            updatedAt: null,
            fields: { draft: { v: '已采纳 2026-10-15', by: '整理者', at: '2026-10-15T02:00:00.000Z', submission: row.id } },
            notes: [],
            draft: null,
            items: [],
            log: [],
          },
          null,
          2
        ) + '\n',
    });
    try {
      const cur = await call(`/api/admin/current?ids=${row.id}`, { headers: auth });
      const info = cur.data.current[String(row.id)];
      assert.equal(info.adopted, '已采纳 2026-10-15', '审核台要能看出这条已经采纳过');
      assert.equal(info.draftChars, 0, '采纳后草稿位是空的');
    } finally {
      repo2.restore();
    }
  });
});

/* ===== 社区整理：自定义小节（2026-10-15 加） =====
 *
 * 社区朋友要的「现有标准条目 + 1 个自定义区」：投稿人自己起小节名，放标准字段装不下的长篇见解。
 * 2026-10-15 同一天扩成**一次可写 1~3 节**（站长要的「能加多个小节标题」），
 * 一张图累计上限 6 节。这一组用例钉住：必须登录、标题逐节受控（撞本站小节名 / 同批重名 / 太短）、
 * 累计上限、写回后每节各成一条 note 且标题不丢（normalizeDoc 是白名单式重建，最容易踩的坑）。
 */
test('社区整理（自定义小节）：登录才能投、标题逐节受控、累计有上限、写回后标题不丢', async (t) => {
  await t.test('没登录 → 401（长篇要能追到人）', async () => {
    const { call } = await setup();
    const r = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_flowering', field: 'section', value: { title: '彩蛋与机关', text: '正文' }, submitter: '路人' },
    });
    assert.equal(r.status, 401, JSON.stringify(r.data));
    assert.match(r.data.error, /登录/);
  });

  await t.test('标题校验：撞本站小节名 / 太短 / 尖括号 / 空正文 一律拒', async () => {
    const { validateValue } = await import('../shared/submission-fields.mjs');
    assert.equal(validateValue('section', { sections: [{ title: '彩蛋与机关', text: '正文' }] }).ok, true);
    /* 老形状（单节 { title, text }）仍然收 —— 线上可能还有这种投稿在队列里 */
    assert.equal(validateValue('section', { title: '老单节', text: '正文' }).ok, true);
    for (const [sections, want] of [
      [[{ title: '基本信息', text: '正文' }], /本站自己的小节名/],
      [[{ title: '神器/道具', text: '正文' }], /本站自己的小节名/],
      [[{ title: '彩蛋', text: 'a<b' }], /不能出现/],
      [[{ title: 'a', text: '正文' }], /至少/],
      [[{ title: '正文', text: '' }], /不能为空/],
      [[{ title: '', text: '正文' }], /要写一个/],
      /* 一次最多 3 节；同一批里不许重名 */
      [[1, 2, 3, 4].map((i) => ({ title: `第${i}节`, text: 'x' })), /最多 3 节/],
      [[{ title: '彩蛋', text: 'a' }, { title: '彩蛋', text: 'b' }], /重名/],
      [[{ title: '彩蛋', text: 'a' }, { title: '基本信息', text: 'b' }], /第 2 节/],
    ]) {
      const r = validateValue('section', { sections });
      assert.equal(r.ok, false, `本该被拒：${JSON.stringify(sections).slice(0, 40)}`);
      assert.match(r.error, want);
    }
    /* 多节通过时，值是 { sections: [...] } */
    const multi = validateValue('section', {
      sections: [
        { title: '彩蛋与机关', text: 'a' },
        { title: '老玩家心得', text: 'b' },
      ],
    });
    assert.equal(multi.ok, true);
    assert.equal(multi.value.sections.length, 2);
  });

  await t.test('登录后能投，队列里带着每一节的标题；同图累计超 6 节才拦', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '写小节的人');

    /* 一次投 2 节 */
    const first = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_flowering',
        field: 'section',
        value: {
          sections: [
            { title: '彩蛋与机关', text: '第三关有个隐藏开关。' },
            { title: '老玩家心得', text: '别在第二关贪枪。' },
          ],
        },
      },
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));

    const queue = await call('/api/admin/queue?status=pending', { headers: auth });
    const row = (queue.data.items ?? []).find((x) => x.field === 'section');
    assert.ok(row, '队列里应当有这条');
    assert.deepEqual(row.titles, ['彩蛋与机关', '老玩家心得'], '审核台要看到每一节的标题');
    assert.match(String(row.value), /隐藏开关/, '正文照旧在 value 里');

    /* 再投 3 节 → 累计 5 节，仍然允许（上限 6） */
    const second = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_flowering',
        field: 'section',
        value: { sections: [1, 2, 3].map((i) => ({ title: `补遗${i}`, text: 'x' })) },
      },
    });
    assert.equal(second.status, 200, JSON.stringify(second.data));

    /* 再加 2 节 → 7 节 > 6，拦下 */
    const third = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_flowering',
        field: 'section',
        value: { sections: [1, 2].map((i) => ({ title: `又补${i}`, text: 'x' })) },
      },
    });
    assert.equal(third.status, 409, JSON.stringify(third.data));
    assert.match(third.data.error, /上限 6 节/);

    /* 别的图各自计数，不受影响 */
    const other = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_other', field: 'section', value: { sections: [{ title: '老玩家心得', text: '别的图' }] } },
    });
    assert.equal(other.status, 200, JSON.stringify(other.data));
  });

  await t.test('写回仓库：多节各成一条 note，都带标题；再读一遍标题还在', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '写小节的人');
    const sub = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_demo9',
        field: 'section',
        value: {
          sections: [
            { title: '彩蛋与机关', text: '第三关有个隐藏开关。' },
            { title: '老玩家心得', text: '别在第二关贪枪。' },
          ],
        },
      },
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    const ok = await call('/api/admin/review', { method: 'POST', body: { id: sub.data.id, action: 'approve' }, headers: auth });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));

    const repo = installFakeRepo({
      'data/community/ze_demo9.json':
        JSON.stringify({ v: 1, slug: 'ze_demo9', updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] }, null, 2) + '\n',
    });
    try {
      const flush = await call('/api/admin/flush', { method: 'POST', body: {}, headers: auth });
      assert.equal(flush.status, 200, JSON.stringify(flush.data));
    } finally {
      repo.restore();
    }

    const doc = JSON.parse(repo.files['data/community/ze_demo9.json']);
    assert.equal((doc.notes ?? []).length, 2, '两节各成一条 note');
    assert.deepEqual(doc.notes.map((n) => n.title), ['彩蛋与机关', '老玩家心得']);
    assert.deepEqual(doc.notes.map((n) => n.field), ['section', 'section']);
    assert.match(doc.notes[0].text, /隐藏开关/);
    assert.equal(doc.notes[0].by, '写小节的人');

    /* normalizeDoc 是白名单式重建：不带 title 的话这里会变成 null（页面上的小节名就没了） */
    const { normalizeDoc } = await import('../shared/community-doc.mjs');
    const reread = normalizeDoc('ze_demo9', doc);
    assert.deepEqual(reread.notes.map((n) => n.title), ['彩蛋与机关', '老玩家心得'], '重新读一遍标题必须在');
  });

  /*
   * 修订不该占新名额（2026-10-15 修，站长点的那个 bug）。
   * 「修订这条」是**替换**：D1 里会插一条新投稿行、老行仍是 applied，
   * 按行累加的话同一节改两次就吃掉 3 个名额 —— 页面上明明只有一节，却提示「超过上限 6 节」。
   * 这里用真库真行跑一遍：改多少次都只算一节，配额该留的还留着。
   */
  await t.test('「修订这条」是替换，不占新名额：反复改同一节也不吃配额', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '来回改的人');

    /* 先铺满：一次 3 节 + 一次 3 节 = 6 节（正好到顶） */
    const a = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_revise', field: 'section', value: { sections: [1, 2, 3].map((i) => ({ title: `第一节组${i}`, text: 'x' })) } },
    });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const b = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_revise', field: 'section', value: { sections: [1, 2, 3].map((i) => ({ title: `第二节组${i}`, text: 'x' })) } },
    });
    assert.equal(b.status, 200, JSON.stringify(b.data));

    /* 到顶了：再新增一节必须被拦 */
    const full = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_revise', field: 'section', value: { sections: [{ title: '挤不进来', text: 'x' }] } },
    });
    assert.equal(full.status, 409, JSON.stringify(full.data));
    assert.match(full.data.error, /已经有 6 节/);

    /* 改第 3 节（第一次）—— 替换，不该被拦 */
    const r1 = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_revise',
        field: 'section',
        value: { sections: [{ title: '第一节组3', text: '改过一次' }], reviseOf: String(a.data.id) },
      },
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));

    /* 再改同一节两次 —— 还是 6 节，仍然不该被拦（这就是修之前会 409 的那一步） */
    for (let i = 0; i < 2; i++) {
      const again = await call('/api/submit', {
        method: 'POST',
        body: {
          map: 'ze_revise',
          field: 'section',
          value: { sections: [{ title: '第一节组3', text: `第 ${i + 2} 次改` }], reviseOf: String(a.data.id) },
        },
      });
      assert.equal(again.status, 200, `第 ${i + 2} 次修订不该被配额拦住：${JSON.stringify(again.data)}`);
    }

    /* 但配额没被"改"掉：新增第 7 节照旧拦 */
    const seventh = await call('/api/submit', {
      method: 'POST',
      body: { map: 'ze_revise', field: 'section', value: { sections: [{ title: '第七节', text: 'x' }] } },
    });
    assert.equal(seventh.status, 409, JSON.stringify(seventh.data));
    assert.match(seventh.data.error, /已经有 6 节|已经有 5 节|已经有 7 节/, `配额口径要照实报：${seventh.data.error}`);
    assert.doesNotMatch(seventh.data.error, /已经有 8 节|已经有 9 节|已经有 10 节/, '修订不会被重复计数');
  });

  /*
   * 多节投稿的每一节要有**各自的 id**（2026-10-15 修）。
   * 以前一个投稿行拆成 N 条 note，N 条共用同一个 submission 编号 → id 重了，
   * 页面上点第 2 节的「修订这条」会改到第 1 节（findNoteIndex 只认第一个匹配）。
   * 现在多节的 id 是 `123p1 / 123p2`，单节的仍是老样子 `123`（不动已有数据）。
   */
  await t.test('多节投稿：每节 id 各不相同（123p1 / 123p2），修订第 2 节改的是第 2 节', async () => {
    const { call, env } = await setup();
    env.ADMIN_TOKEN = 'test-admin-token';
    env.GITHUB_TOKEN = 'test-gh-token';
    const auth = { authorization: 'Bearer test-admin-token' };
    await register(call, '多节的人');

    const sub = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_parts',
        field: 'section',
        value: {
          sections: [
            { title: '彩蛋与机关', text: '第一版彩蛋' },
            { title: '老玩家心得', text: '第一版心得' },
          ],
        },
      },
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    await call('/api/admin/review', { method: 'POST', body: { id: sub.data.id, action: 'approve' }, headers: auth });

    const repo = installFakeRepo({
      'data/community/ze_parts.json':
        JSON.stringify({ v: 1, slug: 'ze_parts', updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] }, null, 2) + '\n',
    });
    try {
      assert.equal((await call('/api/admin/flush', { method: 'POST', body: {}, headers: auth })).status, 200);
    } finally {
      repo.restore();
    }

    const { notePublicId, normalizeDoc } = await import('../shared/community-doc.mjs');
    const doc = normalizeDoc('ze_parts', JSON.parse(repo.files['data/community/ze_parts.json']));
    assert.equal(doc.notes.length, 2);
    const ids = doc.notes.map((n, i) => notePublicId(n, i));
    assert.deepEqual(ids, [`${sub.data.id}p1`, `${sub.data.id}p2`], '每节一个唯一 id');
    assert.equal(new Set(ids).size, 2, 'id 不能重（重了「修订这条」就会改错节）');
    /* part 必须活着穿过 normalizeDoc（白名单式重建，漏掉就又重了） */
    assert.deepEqual(doc.notes.map((n) => n.part), [1, 2]);

    /* 拿第 2 节的 id 提一条修订 → 落库后在页面上该改的是「老玩家心得」 */
    const revise = await call('/api/submit', {
      method: 'POST',
      body: {
        map: 'ze_parts',
        field: 'section',
        value: { sections: [{ title: '老玩家心得', text: '改过的第二版心得' }], reviseOf: `${sub.data.id}p2` },
      },
    });
    assert.equal(revise.status, 200, JSON.stringify(revise.data));
    await call('/api/admin/review', { method: 'POST', body: { id: revise.data.id, action: 'approve' }, headers: auth });
    const repo2 = installFakeRepo({ 'data/community/ze_parts.json': repo.files['data/community/ze_parts.json'] });
    try {
      assert.equal((await call('/api/admin/flush', { method: 'POST', body: {}, headers: auth })).status, 200);
    } finally {
      repo2.restore();
    }
    const after = normalizeDoc('ze_parts', JSON.parse(repo2.files['data/community/ze_parts.json']));
    assert.equal(after.notes.length, 2, '仍然是两节（替换，不是新增）');
    assert.equal(after.notes[0].text, '第一版彩蛋', '第 1 节没被动');
    assert.equal(after.notes[1].text, '改过的第二版心得', '改的是第 2 节');
    assert.equal(after.notes[1].revision, 1, '记了一次修订');
  });
});

/* ===== 神器 / 道具行：能删（2026-10-14 改口径） =====
 *
 * 站长在 ze_visualizer 上看到的怪事：服务器配置是 10 行英文名（Heal / Energy Ball…），
 * 社区又把中文名（治愈 / 能量球…）作为「新增」补了一遍 —— 同一批神器在表里躺了两份（20 行）。
 * 想删掉英文那几行时才发现：投稿页只有「本图没有这件」这个勾，而它以前**只是加一句备注**，
 * 行还在表里。现在删除会让那一行从表里消失（留痕在社区文档与 git 历史里，表下有一句说明）。
 */
test('神器表：反馈「本图没有这件」时整行从表里去掉（不再是只加标注）', async (t) => {
  const { mergeItems, visibleItemRows, ITEM_ACTIONS } = await import('../shared/items.mjs');

  await t.test('删除：标成 removed 并从渲染列表里去掉，但记着是谁说的', () => {
    const base = [
      { name: 'Heal', cd: 100, maxuses: 0 },
      { name: 'Energy Ball', cd: 3, maxuses: 0 },
      { name: 'Square', cd: 60, maxuses: 0 },
    ];
    const rows = [
      { action: 'add', name: '治愈 (人类)', cd: '100', uses: '99', by: 'AntiLockwise' },
      { action: 'remove', name: 'heal', note: '中文名叫「治愈」', by: 'AntiLockwise' },
    ];
    const r = mergeItems(base, rows);
    assert.deepEqual(r.removed, ['Heal'], '名字大小写不敏感也要能命中');
    assert.deepEqual(
      visibleItemRows(r.rows).map((x) => x.name),
      ['Energy Ball', 'Square', '治愈 (人类)'],
      '被删的那行不再出现在表里，社区补充照旧追加到末尾'
    );
    const gone = r.rows.find((x) => x.name === 'Heal');
    assert.equal(gone.kind, 'removed');
    assert.equal(gone.by, 'AntiLockwise', '谁反馈的要留着（表下那句说明要用）');
    assert.equal(gone.note, '中文名叫「治愈」');
    assert.equal(r.changed, 2);
  });

  await t.test('删除社区自己补的行：也能撤掉（改成 removed 后不再显示）', () => {
    const r = mergeItems(
      [],
      [
        { action: 'add', name: '错误的神器', cd: 10, by: '某人' },
        { action: 'remove', name: '错误的神器', by: '站长' },
      ]
    );
    assert.deepEqual(r.removed, ['错误的神器']);
    assert.deepEqual(visibleItemRows(r.rows), [], '整张表被撤空也不该报错（生成器那边有 length 判断）');
  });

  await t.test('删除一个表里没有的名字：不能凭空多出一件（记进 unmatched）', () => {
    const r = mergeItems([{ name: 'Heal', cd: 100, maxuses: 0 }], [{ action: 'remove', name: 'Heal 打错字了', by: '某人' }]);
    assert.deepEqual(r.unmatched, ['Heal 打错字了']);
    assert.deepEqual(
      r.rows.map((x) => x.name),
      ['Heal'],
      '以前这里会追加一行空白的「Heal 打错字了」，页面上就多出一件不存在的道具'
    );
    assert.deepEqual(r.removed, []);
  });

  await t.test('更正 / 新增不受影响：原值仍留在 original 里（备注列要写「从多少改成多少」）', () => {
    const r = mergeItems(
      [{ name: 'Heal', cd: 100, maxuses: 0 }],
      [{ action: 'update', name: 'Heal', cd: '60', uses: '5', note: '我们服是 60 秒', by: '某人' }]
    );
    assert.deepEqual(r.removed, []);
    const row = r.rows[0];
    assert.equal(row.kind, 'updated');
    assert.deepEqual(row.original, { cd: 100, uses: 0 }, 'maxuses=0 就是「不限」，原值照存');
    assert.equal(row.cd, 60);
    assert.equal(row.uses, 5);
    assert.equal(visibleItemRows(r.rows).length, 1, '更正过的行当然还在表里');
    assert.equal(ITEM_ACTIONS.remove, '删除', '审核台显示的动作名');
  });
});

