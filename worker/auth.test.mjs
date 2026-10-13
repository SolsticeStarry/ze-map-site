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

  const call = async (pathname, { method = 'GET', body, cookie, ip, headers = {} } = {}) => {
    const useCookie = cookie !== undefined ? cookie : jar.cookie;
    const res = await worker.fetch(
      new Request(HOST + pathname, {
        method,
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
