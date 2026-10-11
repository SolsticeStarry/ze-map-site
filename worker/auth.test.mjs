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

function makeD1({ migrated = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_0001);
  db.exec(SCHEMA_0002);
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
  const jar = { cookie: '' };

  const call = async (pathname, { method = 'GET', body, cookie } = {}) => {
    const useCookie = cookie !== undefined ? cookie : jar.cookie;
    const res = await worker.fetch(
      new Request(HOST + pathname, {
        method,
        headers: {
          origin: HOST,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(useCookie ? { cookie: useCookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env
    );
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const session = setCookies.find((c) => c.startsWith('zc_sess='));
    if (session) jar.cookie = session.split(';')[0];
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
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '测试员', password: 'pass12345' } })).status, 409);
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '测', password: 'pass12345' } })).status, 400);
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '<img src=x>', password: 'pass12345' } })).status, 400);
    assert.equal((await call('/api/register', { method: 'POST', body: { name: '短口令', password: '123' } })).status, 400);
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

  await t.test('统计口径：待写回不算通过数；同图同字段只算一次', async () => {
    /* 上一条免审直发的还停在 approved（待写回），所以通过数没变 */
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

  await t.test('注册 / 登录共用一个限流桶（同一 IP 每小时 30 次）', async () => {
    for (let i = 0; i < 30; i++) await call('/api/login', { method: 'POST', body: { name: 'x', password: 'bad' } });
    const blocked = await call('/api/login', { method: 'POST', body: { name: 'x', password: 'bad' } });
    assert.equal(blocked.status, 429);
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
