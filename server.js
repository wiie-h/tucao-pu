#!/usr/bin/env node
/* ============================================================
   吐槽铺 · 服务端
   零依赖：只用 Node 自带的模块 + 内置 SQLite。
   启动：node server.js   （或 npm start）
   ============================================================ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n[启动失败] 当前 Node 版本没有内置数据库模块 node:sqlite。');
  console.error('请升级到 Node 22.5 以上（推荐 Node 24）：https://nodejs.org\n');
  process.exit(1);
}

/* ---------------- 配置（全部可以用环境变量覆盖） ---------------- */

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'tucao.db');
const PORT = parseInt(process.env.PORT || '8899', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SITE_NAME = process.env.SITE_NAME || '吐槽铺';
const SITE_DESC = process.env.SITE_DESC || '一个可以随便吐槽的地方。写下你的破烂事，贴到墙上让大家一起同感，或者干脆碎掉它。';
const SITE_KEYWORDS = process.env.SITE_KEYWORDS || '吐槽,树洞,心情,发泄,情绪,匿名,倾诉,抱怨,吐槽墙';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const REQUIRE_REVIEW = process.env.REQUIRE_REVIEW === '1';
const MAX_POST_LEN = 300;
const MAX_REPLY_LEN = 120;
const ONLINE_WINDOW = 5 * 60 * 1000;
const LOG_REQUESTS = process.env.LOG === '1';
const RETENTION_DAYS = Math.max(parseInt(process.env.RETENTION_DAYS || '180', 10) || 180, 7);

let generatedPassword = null;
if (!ADMIN_PASSWORD) {
  generatedPassword = crypto.randomBytes(5).toString('hex');
}
const EFFECTIVE_ADMIN_PASSWORD = ADMIN_PASSWORD || generatedPassword;

const IP_SALT = process.env.IP_SALT || crypto.randomBytes(16).toString('hex');
const SESSION_SECRET = crypto.createHash('sha256')
  .update('tucao|' + EFFECTIVE_ADMIN_PASSWORD + '|' + IP_SALT).digest();

const BANNED_WORDS = (process.env.BANNED_WORDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/** 广告/垃圾信息的自动识别规则（不针对脏话，吐槽就该骂） */
const SPAM_PATTERNS = [
  { re: /(?:\+?86[-\s]?)?1[3-9]\d{9}/, why: '手机号' },
  { re: /(?:微信|WeChat|weixin|vx|VX|wx|QQ|qq|扣扣)\s*[:：号]?\s*[A-Za-z0-9_\-]{5,}/, why: '联系方式' },
  { re: /(?:https?:\/\/|www\.)[^\s]+/i, why: '网址' },
  { re: /(加群|代购|刷单|返利|兼职刷|日结|博彩|赌场|棋牌|色情|代开|发票|办证|贷款|加微)/, why: '广告词' }
];

const BOT_RE = /(bot|crawler|spider|slurp|baiduspider|googlebot|bingbot|yandex|sogou|360spider|bytespider|petalbot|facebookexternalhit|twitterbot|semrush|ahrefs|python-requests|curl|wget|headlesschrome|lighthouse|monitoring)/i;

/* ---------------- 数据库 ---------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  mood        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  nickname    TEXT NOT NULL,
  client_id   TEXT,
  ip_hash     TEXT,
  likes       INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  pending     INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_visible ON posts(hidden, created_at DESC);

CREATE TABLE IF NOT EXISTS replies (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  nickname    TEXT NOT NULL,
  client_id   TEXT,
  ip_hash     TEXT,
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id, created_at);

CREATE TABLE IF NOT EXISTS likes (
  post_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (post_id, client_id)
);

CREATE TABLE IF NOT EXISTS shreds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT,
  ip_hash     TEXT,
  chars       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shreds_created ON shreds(created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  path        TEXT,
  title       TEXT,
  client_id   TEXT,
  ip_hash     TEXT,
  ua          TEXT,
  referrer    TEXT,
  lang        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     TEXT NOT NULL,
  reason      TEXT,
  ip_hash     TEXT,
  handled     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_handled ON reports(handled, created_at DESC);

CREATE TABLE IF NOT EXISTS bans (
  ip_hash     TEXT PRIMARY KEY,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT
);
`);

const q = {
  insertPost: db.prepare(`INSERT INTO posts (id,text,mood,tags,nickname,client_id,ip_hash,hidden,pending,created_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`),
  getPost: db.prepare(`SELECT * FROM posts WHERE id = ?`),
  delPost: db.prepare(`DELETE FROM posts WHERE id = ?`),
  setPostFlags: db.prepare(`UPDATE posts SET hidden=?, pending=? WHERE id=?`),
  setPinned: db.prepare(`UPDATE posts SET pinned=? WHERE id=?`),
  countPosts: db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE hidden=0 AND pending=0`),
  countPostsSince: db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE hidden=0 AND pending=0 AND created_at>=?`),
  sumLikes: db.prepare(`SELECT COALESCE(SUM(likes),0) AS n FROM posts WHERE hidden=0`),

  insertReply: db.prepare(`INSERT INTO replies (id,post_id,text,nickname,client_id,ip_hash,created_at) VALUES (?,?,?,?,?,?,?)`),
  repliesOf: db.prepare(`SELECT id,text,nickname,created_at FROM replies WHERE post_id=? AND hidden=0 ORDER BY created_at ASC LIMIT 50`),
  countReplies: db.prepare(`SELECT COUNT(*) AS n FROM replies WHERE hidden=0`),
  countRepliesSince: db.prepare(`SELECT COUNT(*) AS n FROM replies WHERE hidden=0 AND created_at>=?`),

  getLike: db.prepare(`SELECT 1 AS x FROM likes WHERE post_id=? AND client_id=?`),
  addLike: db.prepare(`INSERT OR IGNORE INTO likes (post_id,client_id,created_at) VALUES (?,?,?)`),
  delLike: db.prepare(`DELETE FROM likes WHERE post_id=? AND client_id=?`),
  bumpLikes: db.prepare(`UPDATE posts SET likes = MAX(0, likes + ?) WHERE id = ?`),

  insertShred: db.prepare(`INSERT INTO shreds (client_id,ip_hash,chars,created_at) VALUES (?,?,?,?)`),
  countShreds: db.prepare(`SELECT COUNT(*) AS n FROM shreds`),
  countShredsSince: db.prepare(`SELECT COUNT(*) AS n FROM shreds WHERE created_at>=?`),

  insertEvent: db.prepare(`INSERT INTO events (type,path,title,client_id,ip_hash,ua,referrer,lang,created_at)
                           VALUES (?,?,?,?,?,?,?,?,?)`),
  insertReport: db.prepare(`INSERT INTO reports (post_id,reason,ip_hash,created_at) VALUES (?,?,?,?)`),

  isBanned: db.prepare(`SELECT 1 AS x FROM bans WHERE ip_hash = ?`),
  addBan: db.prepare(`INSERT OR IGNORE INTO bans (ip_hash,reason,created_at) VALUES (?,?,?)`),
  delBan: db.prepare(`DELETE FROM bans WHERE ip_hash = ?`),
  listBans: db.prepare(`SELECT * FROM bans ORDER BY created_at DESC LIMIT 200`)
};

/* 首次启动时放一条站长自己的欢迎帖（不是假用户，署名就是「站长」）。
   不想要的话，后台搜「欢迎」删掉即可。 */
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS n FROM posts').get().n > 0) return;
  q.insertPost.run(
    uid(),
    '欢迎来到吐槽铺。\n\n写下令你不爽的那件事，然后选一个：贴到墙上，让路过的人一起点头；或者直接碎掉它，当没发生过。\n\n这里不用注册、没有算法、没有热搜，只有一堆真实的人和一肚子没好意思说的话。',
    'warm',
    JSON.stringify(['生活']),
    '站长',
    null, null, 0, 0, Date.now()
  );
}

/* 访问记录会一直累积，定期清掉过期的，数据库才不会越跑越大。
   吐槽内容本身不会被删除。 */
function pruneOldData() {
  const cutoff = now() - RETENTION_DAYS * 24 * 3600 * 1000;
  try {
    const a = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    const b = db.prepare('DELETE FROM reports WHERE handled = 1 AND created_at < ?').run(cutoff);
    if (a.changes || b.changes) {
      console.log(`  已清理过期记录：访问 ${a.changes} 条、已处理举报 ${b.changes} 条（保留 ${RETENTION_DAYS} 天）`);
    }
  } catch (e) { console.error('  清理失败：', e.message); }
}

/* ---------------- 小工具 ---------------- */

const now = () => Date.now();
const uid = () => crypto.randomBytes(9).toString('base64url');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip) + '|' + IP_SALT).digest('hex').slice(0, 16);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, opts) {
  opts = opts || {};
  const parts = [name + '=' + encodeURIComponent(value)];
  parts.push('Path=' + (opts.path || '/'));
  if (opts.maxAge != null) parts.push('Max-Age=' + Math.floor(opts.maxAge / 1000));
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push('SameSite=' + (opts.sameSite || 'Lax'));
  if (opts.secure || BASE_URL.startsWith('https://')) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function html(res, status, body, extra) {
  const headers = Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate'
  }, extra || {});
  res.writeHead(status, headers);
  res.end(body);
}

function text(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(body);
}

/* ---- 频率限制（内存，够用且不写库） ---- */

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && t - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(t);
  return true;
}
setInterval(() => {
  const t = now();
  for (const [k, arr] of buckets) {
    while (arr.length && t - arr[0] > 10 * 60 * 1000) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

/* ---- 在线人数（内存） ---- */

const presence = new Map();
function touchPresence(cid) {
  if (!cid) return;
  presence.set(cid, now());
}
function onlineCount() {
  const t = now();
  let n = 0;
  for (const [, seen] of presence) if (t - seen <= ONLINE_WINDOW) n++;
  return n;
}
setInterval(() => {
  const t = now();
  for (const [cid, seen] of presence) if (t - seen > ONLINE_WINDOW) presence.delete(cid);
}, 60 * 1000).unref();

/* ---- 设备 / 来源识别 ---- */

function parseUA(ua) {
  ua = ua || '';
  let device = '电脑';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) device = '平板';
  else if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) device = '手机';

  let browser = '其他';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/MicroMessenger/i.test(ua)) browser = '微信';
  else if (/QQBrowser/i.test(ua)) browser = 'QQ 浏览器';
  else if (/UCBrowser/i.test(ua)) browser = 'UC';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  else if (/curl|wget|node|python/i.test(ua)) browser = '程序';
  return { device, browser };
}

function refHost(ref) {
  if (!ref) return '直接访问';
  try {
    const u = new URL(ref);
    if (u.hostname === new URL(BASE_URL).hostname) return '站内';
    return u.hostname.replace(/^www\./, '');
  } catch (e) { return '其他'; }
}

/* ---- 内容检查 ---- */

function moderate(text) {
  for (const w of BANNED_WORDS) if (w && text.includes(w)) return { bad: true, why: '命中词库' };
  for (const p of SPAM_PATTERNS) if (p.re.test(text)) return { bad: true, why: p.why };
  return { bad: false };
}

function clean(str, max) {
  return String(str == null ? '' : str)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanMultiline(str, max) {
  return String(str == null ? '' : str)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/* ---- 管理员会话 ---- */

function signToken(exp) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('base64url');
  return exp + '.' + mac;
}
function checkToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return false;
  const [exp, mac] = tok.split('.');
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('base64url');
  if (mac.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  return Number(exp) > now();
}
function isAdmin(req) {
  return checkToken(parseCookies(req).tucao_admin);
}
function passwordOk(input) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(EFFECTIVE_ADMIN_PASSWORD || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------------- 查询 ---------------- */

function publicPostRow(r) {
  return {
    id: r.id,
    text: r.text,
    mood: r.mood,
    tags: JSON.parse(r.tags || '[]'),
    nickname: r.nickname,
    likes: r.likes,
    created_at: r.created_at,
    pending: r.pending,
    pinned: r.pinned,
    mine: false,
    liked: false,
    replies: []
  };
}

/** 取一批公开吐槽（含回复和「我是否点过同感」） */
function fetchFeed(opts) {
  const { mood, sort, search, clientId, limit = 60, onlyMine } = opts || {};
  const where = ['hidden = 0'];
  const params = [];

  if (!onlyMine) where.push('pending = 0');
  if (mood && mood !== 'all') { where.push('mood = ?'); params.push(mood); }
  if (onlyMine) { where.push('client_id = ?'); params.push(clientId || '__none__'); }
  if (search) {
    where.push('(text LIKE ? OR nickname LIKE ? OR tags LIKE ?)');
    const like = '%' + search + '%';
    params.push(like, like, like);
  }

  const order = sort === 'hot'
    ? 'ORDER BY pinned DESC, (likes + 3 * (SELECT COUNT(*) FROM replies r WHERE r.post_id = posts.id AND r.hidden = 0)) DESC, created_at DESC'
    : 'ORDER BY pinned DESC, created_at DESC';

  const sql = `SELECT * FROM posts WHERE ${where.join(' AND ')} ${order} LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200));

  const rows = db.prepare(sql).all(...params);
  const posts = rows.map(publicPostRow);

  if (!posts.length) return posts;

  const ids = posts.map(p => p.id);
  const ph = ids.map(() => '?').join(',');

  const replyRows = db.prepare(
    `SELECT post_id, id, text, nickname, created_at FROM replies
     WHERE hidden = 0 AND post_id IN (${ph}) ORDER BY created_at ASC`
  ).all(...ids);
  const byPost = new Map();
  for (const r of replyRows) {
    if (!byPost.has(r.post_id)) byPost.set(r.post_id, []);
    byPost.get(r.post_id).push({ id: r.id, text: r.text, nickname: r.nickname, created_at: r.created_at });
  }

  let liked = new Set();
  const ownerById = new Map(rows.map(r => [r.id, r.client_id]));
  if (clientId) {
    const likeRows = db.prepare(
      `SELECT post_id FROM likes WHERE client_id = ? AND post_id IN (${ph})`
    ).all(clientId, ...ids);
    liked = new Set(likeRows.map(r => r.post_id));
  }

  for (const p of posts) {
    p.replies = byPost.get(p.id) || [];
    p.liked = liked.has(p.id);
    p.mine = !!(clientId && ownerById.get(p.id) === clientId);
  }
  return posts;
}

function siteStats() {
  const today = startOfToday();
  return {
    online: onlineCount(),
    posts: q.countPosts.get().n,
    postsToday: q.countPostsSince.get(today).n,
    shreds: q.countShreds.get().n,
    shredsToday: q.countShredsSince.get(today).n,
    likes: q.sumLikes.get().n,
    replies: q.countReplies.get().n
  };
}

/* ---------------- 访问统计 ---------------- */

function track(req, res, ctx, type, extra) {
  const ua = req.headers['user-agent'] || '';
  if (BOT_RE.test(ua)) return;                       // 爬虫不计入
  if (ctx.ipHash && q.isBanned.get(ctx.ipHash)) return;
  const info = parseUA(ua);
  q.insertEvent.run(
    type,
    (extra && extra.path) || ctx.pathname,
    (extra && extra.title) || null,
    ctx.clientId || null,
    ctx.ipHash,
    info.device + '/' + info.browser,
    (req.headers.referer || '').slice(0, 300) || null,
    clean(req.headers['accept-language'] || '', 32) || null,
    now()
  );
}

/* ---------------- 页面渲染 ---------------- */

const render = require('./public/render.js');
const tplCache = new Map();

/** 静态资源版本号：文件一变，URL 就变，浏览器立刻拿到新版（同时保留长缓存） */
let assetV = '';
let assetVAt = 0;
function assetVersion() {
  const t = now();
  if (assetV && t - assetVAt < 5000) return assetV;
  let v = 0;
  for (const f of ['styles.css', 'app.js', 'render.js', 'admin.css', 'admin.js', 'favicon.svg']) {
    try { v = Math.max(v, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch (e) { /* 忽略 */ }
  }
  assetV = Math.floor(v).toString(36);
  assetVAt = t;
  return assetV;
}

function versionAssets(html) {
  const v = assetVersion();
  return html.replace(
    /(href|src)="(\/(?:styles|admin)\.css|\/(?:app|admin|render)\.js|\/favicon\.svg)"/g,
    function (m, attr, url) { return attr + '="' + url + '?v=' + v + '"'; }
  );
}

function tpl(name) {
  const cached = tplCache.get(name);
  if (cached && cached.mtime === fs.statSync(path.join(PUBLIC_DIR, name)).mtimeMs) return cached.html;
  const file = path.join(PUBLIC_DIR, name);
  const html = fs.readFileSync(file, 'utf8');
  tplCache.set(name, { html, mtime: fs.statSync(file).mtimeMs });
  return html;
}

function fill(html, map) {
  return versionAssets(html.replace(/<!--\{\{(\w+)\}\}-->/g, (m, k) => (map[k] != null ? map[k] : '')));
}

function seoHead(o) {
  const title = o.title;
  const desc = o.description;
  const url = o.url;
  const image = BASE_URL + '/preview.png';
  const tags = [
    `<title>${render.esc(title)}</title>`,
    `<meta name="description" content="${render.esc(desc)}" />`,
    `<meta name="keywords" content="${render.esc(SITE_KEYWORDS)}" />`,
    `<link rel="canonical" href="${render.esc(url)}" />`,
    `<meta name="robots" content="${o.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large'}" />`,
    `<meta property="og:type" content="${o.type || 'website'}" />`,
    `<meta property="og:site_name" content="${render.esc(SITE_NAME)}" />`,
    `<meta property="og:title" content="${render.esc(title)}" />`,
    `<meta property="og:description" content="${render.esc(desc)}" />`,
    `<meta property="og:url" content="${render.esc(url)}" />`,
    `<meta property="og:image" content="${render.esc(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${render.esc(title)}" />`,
    `<meta name="twitter:description" content="${render.esc(desc)}" />`,
    `<meta name="twitter:image" content="${render.esc(image)}" />`
  ];
  if (o.jsonLd) tags.push(`<script type="application/ld+json">${JSON.stringify(o.jsonLd)}</script>`);
  if (o.published) tags.push(`<meta property="article:published_time" content="${new Date(o.published).toISOString()}" />`);
  return tags.join('\n');
}

function bootScript(boot) {
  return '<script>window.__BOOT__=' +
    JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '') +
    ';</script>';
}

function renderHome(ctx) {
  const posts = fetchFeed({ mood: 'all', sort: 'new', clientId: ctx.clientId, limit: 60 });
  const stats = siteStats();

  const wallHtml = posts.slice(0, 24).map(p => render.noteArticle(p, { mine: p.mine })).join('\n');
  const count = stats.posts;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: BASE_URL + '/',
    description: SITE_DESC,
    inLanguage: 'zh-CN',
    potentialAction: {
      '@type': 'SearchAction',
      target: BASE_URL + '/?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    }
  };

  const head = seoHead({
    title: `${SITE_NAME} · 24 小时营业，专收坏情绪`,
    description: SITE_DESC,
    url: BASE_URL + '/',
    jsonLd
  });

  const boot = {
    base: BASE_URL,
    clientId: ctx.clientId,
    nickname: null,
    posts,
    stats,
    page: 'home',
    me: { isAdmin: ctx.isAdmin }
  };

  return fill(tpl('index.html'), {
    SEO: head,
    WALL: wallHtml,
    COUNT: String(count),
    STAT_ONLINE: String(stats.online),
    STAT_POSTS: String(stats.posts),
    STAT_TODAY: String(stats.postsToday),
    STAT_SHREDS: String(stats.shreds),
    STAT_LIKES: String(stats.likes),
    BOOT: bootScript(boot)
  });
}

function renderPostPage(id, ctx) {
  const row = q.getPost.get(id);
  if (!row || (row.hidden && !ctx.isAdmin)) return null;

  const post = publicPostRow(row);
  post.replies = q.repliesOf.all(id).map(r => ({ id: r.id, text: r.text, nickname: r.nickname, created_at: r.created_at }));
  if (ctx.clientId) {
    post.liked = !!q.getLike.get(id, ctx.clientId);
    post.mine = row.client_id === ctx.clientId;
  }

  const m = render.moodOf(post.mood);
  const title = `${render.plain(post.text, 40)} · ${SITE_NAME}`;
  const desc = `${post.nickname}（${m.emoji} ${m.label}）：${render.plain(post.text, 110)}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: render.plain(post.text, 110),
    articleBody: post.text,
    datePublished: new Date(post.created_at).toISOString(),
    url: `${BASE_URL}/t/${post.id}`,
    inLanguage: 'zh-CN',
    author: { '@type': 'Person', name: post.nickname },
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: post.likes },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.replies.length }
    ],
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: BASE_URL + '/' }
  };

  const head = seoHead({
    title,
    description: desc,
    url: `${BASE_URL}/t/${post.id}`,
    type: 'article',
    published: post.created_at,
    jsonLd
  });

  const boot = {
    base: BASE_URL,
    clientId: ctx.clientId,
    nickname: null,
    posts: [post],
    stats: siteStats(),
    page: 'post',
    me: { isAdmin: ctx.isAdmin }
  };

  return fill(tpl('post.html'), {
    SEO: head,
    POST: render.noteArticle(post, { mine: post.mine, expanded: true, hideText: true }),
    NICK: render.esc(post.nickname),
    DATE: render.esc(render.fmtDate(post.created_at)),
    MOOD: m.emoji + ' ' + render.esc(m.label),
    TEXT: render.esc(post.text),
    LIKES: String(post.likes),
    REPLIES: String(post.replies.length),
    BOOT: bootScript(boot)
  });
}

function renderAboutPage(ctx) {
  const head = seoHead({
    title: `关于本站 · ${SITE_NAME}`,
    description: `${SITE_NAME}是什么、怎么用、你的数据会被怎么处理，以及内容管理规定和联系方式。`,
    url: BASE_URL + '/about',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'AboutPage',
      name: `关于本站 · ${SITE_NAME}`,
      url: BASE_URL + '/about',
      inLanguage: 'zh-CN'
    }
  });
  return fill(tpl('about.html'), {
    SEO: head,
    SITE_NAME: render.esc(SITE_NAME),
    BASE_URL: render.esc(BASE_URL),
    CONTACT: CONTACT_EMAIL
      ? `<a href="mailto:${render.esc(CONTACT_EMAIL)}">${render.esc(CONTACT_EMAIL)}</a>`
      : '<span class="muted">（站长还没有填写联系邮箱）</span>',
    BOOT: bootScript({ base: BASE_URL, page: 'about', clientId: ctx.clientId, posts: [], stats: siteStats(), me: {} })
  });
}

function renderRobots() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /admin/',
    'Disallow: /api/',
    'Disallow: /t/*?',
    '',
    'Sitemap: ' + BASE_URL + '/sitemap.xml',
    ''
  ].join('\n');
}

function renderSitemap() {
  const rows = db.prepare(
    `SELECT id, created_at FROM posts WHERE hidden = 0 AND pending = 0 ORDER BY created_at DESC LIMIT 2000`
  ).all();
  const urls = [
    `  <url><loc>${BASE_URL}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${BASE_URL}/about</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>`
  ].concat(rows.map(r =>
    `  <url><loc>${BASE_URL}/t/${r.id}</loc><lastmod>${new Date(r.created_at).toISOString().slice(0, 10)}</lastmod><priority>0.6</priority></url>`
  ));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>\n';
}

function renderRss() {
  const rows = db.prepare(
    `SELECT id, text, nickname, mood, created_at FROM posts
     WHERE hidden = 0 AND pending = 0 ORDER BY created_at DESC LIMIT 30`
  ).all();
  const items = rows.map(r => {
    const m = render.moodOf(r.mood);
    const link = `${BASE_URL}/t/${r.id}`;
    return [
      '    <item>',
      `      <title>${render.esc(render.plain(r.text, 60))}</title>`,
      `      <link>${link}</link>`,
      `      <guid isPermaLink="true">${link}</guid>`,
      `      <pubDate>${new Date(r.created_at).toUTCString()}</pubDate>`,
      `      <description>${render.esc(m.emoji + ' ' + m.label + ' · ' + r.nickname + '：' + r.text)}</description>`,
      '    </item>'
    ].join('\n');
  }).join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0"><channel>\n' +
    `  <title>${render.esc(SITE_NAME)} · 最新吐槽</title>\n` +
    `  <link>${BASE_URL}/</link>\n` +
    `  <description>${render.esc(SITE_DESC)}</description>\n` +
    '  <language>zh-CN</language>\n' +
    `  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
    items + '\n</channel></rss>\n';
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/* 只有这几个文件允许从项目根目录读取（避免把数据库和源码暴露出去） */
const ROOT_ALLOW = new Set(['preview.png', 'robots-extra.txt']);

function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/+/, '');
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('403'); return true; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (!ROOT_ALLOW.has(rel)) return false;
    file = path.join(ROOT, rel);
  }
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', ext === '.html' ? 'public, max-age=0, must-revalidate' : 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.writeHead(200);
  res.end(fs.readFileSync(file));
  return true;
}

/* ---------------- 公开 API ---------------- */

async function apiFeed(req, res, ctx, url) {
  const posts = fetchFeed({
    mood: url.searchParams.get('mood') || 'all',
    sort: url.searchParams.get('sort') || 'new',
    search: clean(url.searchParams.get('q') || '', 40),
    clientId: ctx.clientId,
    limit: url.searchParams.get('limit') || 60,
    onlyMine: url.searchParams.get('mine') === '1'
  });
  const stats = siteStats();
  json(res, 200, {
    posts, stats,
    version: stats.posts + ':' + stats.likes + ':' + stats.replies + ':' + (posts[0] ? posts[0].id : '')
  });
}

async function apiCreatePost(req, res, ctx) {
  if (ctx.ipHash && q.isBanned.get(ctx.ipHash)) return json(res, 403, { error: '你已被限制发言。' });
  if (!rateLimit('post:' + ctx.ipHash, 5, 60 * 60 * 1000)) {
    return json(res, 429, { error: '一小时最多发 5 条，缓一缓再来。' });
  }

  const body = await readBody(req);
  const text = cleanMultiline(body.text, MAX_POST_LEN);
  if (!text) return json(res, 400, { error: '写点什么吧，哪怕一个字。' });

  const moodIds = render.MOODS.map(m => m.id);
  const mood = moodIds.includes(body.mood) ? body.mood : 'angry';
  const tags = (Array.isArray(body.tags) ? body.tags : [])
    .map(t => render.TAGS.includes(t) ? t : null).filter(Boolean).slice(0, 3);
  const nickname = clean(body.nickname, 20) || '匿名';

  const check = moderate(text);
  const pending = (check.bad || REQUIRE_REVIEW) ? 1 : 0;

  const id = uid();
  q.insertPost.run(id, text, mood, JSON.stringify(tags), nickname,
    ctx.clientId || null, ctx.ipHash, 0, pending, now());

  if (pending) return json(res, 200, { pending: true, reason: check.why || '审核', id });

  const post = publicPostRow(q.getPost.get(id));
  post.mine = true;
  json(res, 200, { pending: false, post, stats: siteStats() });
}

async function apiLike(req, res, ctx, id) {
  if (!rateLimit('like:' + ctx.ipHash, 40, 60 * 1000)) return json(res, 429, { error: '慢一点。' });
  const row = q.getPost.get(id);
  if (!row || row.hidden) return json(res, 404, { error: '这条已经不在了。' });
  const cid = ctx.clientId;
  if (!cid) return json(res, 400, { error: '缺少标识。' });

  const had = !!q.getLike.get(id, cid);
  if (had) { q.delLike.run(id, cid); q.bumpLikes.run(-1, id); }
  else { q.addLike.run(id, cid, now()); q.bumpLikes.run(1, id); }

  const updated = q.getPost.get(id);
  json(res, 200, { liked: !had, likes: updated.likes });
}

async function apiReply(req, res, ctx, id) {
  if (!rateLimit('reply:' + ctx.ipHash, 20, 60 * 60 * 1000)) {
    return json(res, 429, { error: '一小时最多接 20 句。' });
  }
  const row = q.getPost.get(id);
  if (!row || row.hidden || row.pending) return json(res, 404, { error: '这条已经不在了。' });

  const body = await readBody(req);
  const text = cleanMultiline(body.text, MAX_REPLY_LEN);
  if (!text) return json(res, 400, { error: '写点什么吧。' });
  const check = moderate(text);
  if (check.bad) return json(res, 400, { error: '这句话里好像有联系方式或广告，发不出去。' });

  const nickname = clean(body.nickname, 20) || '匿名';
  const rid = uid();
  q.insertReply.run(rid, id, text, nickname, ctx.clientId || null, ctx.ipHash, now());
  json(res, 200, { reply: { id: rid, text, nickname, created_at: now() } });
}

async function apiReport(req, res, ctx, id) {
  if (!rateLimit('report:' + ctx.ipHash, 10, 60 * 60 * 1000)) return json(res, 429, { error: '举报太频繁了。' });
  const body = await readBody(req);
  const row = q.getPost.get(id);
  if (!row) return json(res, 404, { error: '这条已经不在了。' });
  q.insertReport.run(id, clean(body.reason, 100) || '未填写原因', ctx.ipHash, now());
  json(res, 200, { ok: true });
}

async function apiDeletePost(req, res, ctx, id) {
  const row = q.getPost.get(id);
  if (!row) return json(res, 404, { error: '已经删掉了。' });
  if (!ctx.isAdmin && row.client_id !== ctx.clientId) return json(res, 403, { error: '只能删自己发的。' });
  q.delPost.run(id);
  json(res, 200, { ok: true });
}

async function apiShred(req, res, ctx) {
  if (!rateLimit('shred:' + ctx.ipHash, 60, 60 * 60 * 1000)) return json(res, 429, { error: '慢一点。' });
  const body = await readBody(req);
  const chars = Math.min(Math.max(parseInt(body.chars, 10) || 0, 0), 5000);
  // 注意：只记「碎掉了几个字」，绝不保存内容本身
  q.insertShred.run(ctx.clientId || null, ctx.ipHash, chars, now());
  json(res, 200, { stats: siteStats() });
}

/* ---------------- 后台 API ---------------- */

function dayKey(ts) {
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function adminOverview() {
  const t0 = startOfToday();
  const day = 24 * 3600 * 1000;
  const pv = t => db.prepare(`SELECT COUNT(*) n FROM events WHERE type='pageview' AND created_at>=?`).get(t).n;
  const uv = t => db.prepare(`SELECT COUNT(DISTINCT client_id) n FROM events WHERE type='pageview' AND client_id IS NOT NULL AND created_at>=?`).get(t).n;

  return {
    now: now(),
    live: {
      online: onlineCount(),
      pv5: db.prepare(`SELECT COUNT(*) n FROM events WHERE type='pageview' AND created_at>=?`).get(now() - 5 * 60 * 1000).n,
      pv60: db.prepare(`SELECT COUNT(*) n FROM events WHERE type='pageview' AND created_at>=?`).get(now() - 3600 * 1000).n
    },
    today: {
      pv: pv(t0), uv: uv(t0),
      posts: q.countPostsSince.get(t0).n,
      replies: q.countRepliesSince.get(t0).n,
      shreds: q.countShredsSince.get(t0).n,
      likes: db.prepare(`SELECT COUNT(*) n FROM likes WHERE created_at>=?`).get(t0).n
    },
    total: {
      pv: db.prepare(`SELECT COUNT(*) n FROM events WHERE type='pageview'`).get().n,
      uv: db.prepare(`SELECT COUNT(DISTINCT client_id) n FROM events WHERE type='pageview' AND client_id IS NOT NULL`).get().n,
      posts: q.countPosts.get().n,
      allPosts: db.prepare(`SELECT COUNT(*) n FROM posts`).get().n,
      replies: q.countReplies.get().n,
      shreds: q.countShreds.get().n,
      likes: db.prepare(`SELECT COALESCE(SUM(likes),0) n FROM posts`).get().n
    },
    moderation: {
      pending: db.prepare(`SELECT COUNT(*) n FROM posts WHERE pending=1 AND hidden=0`).get().n,
      hidden: db.prepare(`SELECT COUNT(*) n FROM posts WHERE hidden=1`).get().n,
      reports: db.prepare(`SELECT COUNT(*) n FROM reports WHERE handled=0`).get().n,
      bans: db.prepare(`SELECT COUNT(*) n FROM bans`).get().n
    },
    moods: render.MOODS.map(m => ({
      id: m.id, label: m.label, emoji: m.emoji, color: m.line,
      count: db.prepare(`SELECT COUNT(*) n FROM posts WHERE mood=? AND hidden=0 AND pending=0`).get(m.id).n
    })),
    devices: db.prepare(`SELECT ua AS name, COUNT(*) AS count FROM events WHERE type='pageview' AND created_at>=? AND ua IS NOT NULL GROUP BY ua ORDER BY count DESC LIMIT 8`).all(now() - 30 * day)
      .map(r => ({ name: r.name, count: r.count })),
    referrers: db.prepare(`SELECT referrer AS name, COUNT(*) AS count FROM events WHERE type='pageview' AND created_at>=? GROUP BY referrer ORDER BY count DESC LIMIT 8`).all(now() - 30 * day)
      .map(r => ({ name: refHost(r.name), count: r.count })),
    topPosts: db.prepare(
      `SELECT id, text, mood, likes, nickname,
              (SELECT COUNT(*) FROM replies r WHERE r.post_id=p.id AND r.hidden=0) AS replies
       FROM posts p WHERE hidden=0 AND pending=0
       ORDER BY likes DESC, replies DESC LIMIT 6`
    ).all(),
    recent: db.prepare(`SELECT id, text, nickname, mood, likes, created_at FROM posts ORDER BY created_at DESC LIMIT 8`).all()
  };
}

function adminTimeline(days) {
  days = Math.min(Math.max(days || 14, 1), 90);
  const t0 = startOfToday() - (days - 1) * 24 * 3600 * 1000;
  const pvRows = db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS n
     FROM events WHERE type='pageview' AND created_at>=? GROUP BY d`
  ).all(t0);
  const uvRows = db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS d, COUNT(DISTINCT client_id) AS n
     FROM events WHERE type='pageview' AND created_at>=? AND client_id IS NOT NULL GROUP BY d`
  ).all(t0);
  const postRows = db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS n
     FROM posts WHERE created_at>=? GROUP BY d`
  ).all(t0);

  const map = (rows) => { const m = {}; rows.forEach(r => { m[r.d] = r.n; }); return m; };
  const pv = map(pvRows), uv = map(uvRows), po = map(postRows);

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(t0 + i * 24 * 3600 * 1000);
    const k = dayKey(d.getTime());
    out.push({ date: k, pv: pv[k] || 0, uv: uv[k] || 0, posts: po[k] || 0 });
  }
  return out;
}

function adminHourly() {
  const t0 = now() - 24 * 3600 * 1000;
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d %H', created_at/1000, 'unixepoch', 'localtime') AS h, COUNT(*) AS n
     FROM events WHERE type='pageview' AND created_at>=? GROUP BY h`
  ).all(t0);
  const m = {};
  rows.forEach(r => { m[r.h] = r.n; });
  const out = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now() - i * 3600 * 1000);
    const p = n => (n < 10 ? '0' + n : '' + n);
    const k = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours());
    out.push({ hour: k.slice(11) + ':00', pv: m[k] || 0 });
  }
  return out;
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const pathname = decodeURIComponent(url.pathname);

  if (LOG_REQUESTS) {
    const t0 = Date.now();
    res.on('finish', function () {
      console.log(`  ${req.method} ${pathname} → ${res.statusCode} (${Date.now() - t0}ms)`);
    });
  }

  const cookies = parseCookies(req);
  let clientId = cookies.tucao_cid;
  if (!clientId || !/^[A-Za-z0-9_-]{8,40}$/.test(clientId)) {
    clientId = crypto.randomBytes(12).toString('base64url');
    setCookie(res, 'tucao_cid', clientId, { maxAge: 400 * 24 * 3600 * 1000, httpOnly: false, sameSite: 'Lax' });
  }

  const ctx = {
    clientId,
    ip: clientIp(req),
    ipHash: hashIp(clientIp(req)),
    isAdmin: isAdmin(req),
    pathname
  };
  touchPresence(clientId);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const isGet = req.method === 'GET' || req.method === 'HEAD';

  try {
    /* ---- 后台 ---- */
    if (pathname === '/admin/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!rateLimit('login:' + ctx.ipHash, 10, 15 * 60 * 1000)) {
        return json(res, 429, { error: '尝试次数太多，请 15 分钟后再试。' });
      }
      if (!passwordOk(body.password)) return json(res, 401, { error: '密码不对。' });
      setCookie(res, 'tucao_admin', signToken(now() + 7 * 24 * 3600 * 1000), {
        maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'Strict', path: '/admin'
      });
      return json(res, 200, { ok: true });
    }
    if (pathname === '/admin/logout' && req.method === 'POST') {
      setCookie(res, 'tucao_admin', '', { maxAge: 0, httpOnly: true, sameSite: 'Strict', path: '/admin' });
      return json(res, 200, { ok: true });
    }

    if (pathname.startsWith('/admin/api/')) {
      if (!ctx.isAdmin) return json(res, 401, { error: '未登录' });
      const sub = pathname.slice('/admin/api/'.length);

      if (sub === 'overview') return json(res, 200, adminOverview());
      if (sub === 'timeline') return json(res, 200, { days: adminTimeline(parseInt(url.searchParams.get('days') || '14', 10)), hourly: adminHourly() });
      if (sub === 'reports') {
        const rows = db.prepare(
          `SELECT r.id, r.post_id, r.reason, r.handled, r.created_at,
                  p.text, p.nickname, p.hidden
           FROM reports r LEFT JOIN posts p ON p.id = r.post_id
           ORDER BY r.handled ASC, r.created_at DESC LIMIT 100`
        ).all();
        return json(res, 200, { reports: rows });
      }
      if (sub === 'bans') {
        if (req.method === 'GET') return json(res, 200, { bans: q.listBans.all() });
        const body = await readBody(req);
        if (body.action === 'add') { q.addBan.run(clean(body.ipHash, 64), clean(body.reason, 100), now()); return json(res, 200, { ok: true }); }
        if (body.action === 'remove') { q.delBan.run(clean(body.ipHash, 64)); return json(res, 200, { ok: true }); }
        return json(res, 400, { error: '未知操作' });
      }
      if (sub === 'export') {
        const rows = db.prepare(`SELECT id,nickname,mood,tags,likes,hidden,pending,created_at,text FROM posts ORDER BY created_at DESC LIMIT 5000`).all();
        const esc2 = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const csv = ['id,昵称,心情,标签,同感,隐藏,待审,时间,内容']
          .concat(rows.map(r => [r.id, r.nickname, r.mood, r.tags, r.likes, r.hidden, r.pending,
            new Date(r.created_at).toISOString(), r.text].map(esc2).join(',')))
          .join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="tucao-posts.csv"'
        });
        res.end('\uFEFF' + csv);
        return;
      }
      if (sub === 'events') {
        const rows = db.prepare(
          `SELECT path, ua, referrer, lang, created_at FROM events
           WHERE type='pageview' ORDER BY created_at DESC LIMIT 60`
        ).all();
        return json(res, 200, { events: rows.map(r => ({ ...r, ref: refHost(r.referrer) })) });
      }
      if (sub === 'posts') {
        const filter = url.searchParams.get('filter') || 'all';
        const term = clean(url.searchParams.get('q') || '', 40);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
        const where = [];
        const params = [];
        if (filter === 'hidden') where.push('hidden = 1');
        if (filter === 'pending') { where.push('pending = 1'); where.push('hidden = 0'); }
        if (filter === 'reported') where.push('id IN (SELECT post_id FROM reports WHERE handled=0)');
        if (term) { where.push('(text LIKE ? OR nickname LIKE ?)'); params.push('%' + term + '%', '%' + term + '%'); }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const rows = db.prepare(
          `SELECT id,text,nickname,mood,tags,likes,hidden,pending,pinned,created_at,
                  (SELECT COUNT(*) FROM replies r WHERE r.post_id=posts.id) AS replies,
                  (SELECT COUNT(*) FROM reports rp WHERE rp.post_id=posts.id AND rp.handled=0) AS reports
           FROM posts ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(...params, limit, offset);
        const total = db.prepare(`SELECT COUNT(*) n FROM posts ${clause}`).get(...params).n;
        return json(res, 200, { posts: rows, total, limit, offset });
      }

      const mPost = sub.match(/^posts\/([\w-]+)$/);
      if (mPost && req.method === 'POST') {
        const body = await readBody(req);
        const id = mPost[1];
        if (!q.getPost.get(id)) return json(res, 404, { error: '找不到这条' });
        if (body.action === 'hide') q.setPostFlags.run(1, 0, id);
        else if (body.action === 'show') q.setPostFlags.run(0, 0, id);
        else if (body.action === 'pin') q.setPinned.run(1, id);
        else if (body.action === 'unpin') q.setPinned.run(0, id);
        else if (body.action === 'delete') q.delPost.run(id);
        else if (body.action === 'ban') {
          const row = q.getPost.get(id);
          if (row && row.ip_hash) q.addBan.run(row.ip_hash, '来自后台：' + render.plain(row.text, 40), now());
          q.setPostFlags.run(1, 0, id);
        } else return json(res, 400, { error: '未知操作' });
        return json(res, 200, { ok: true });
      }

      const mRep = sub.match(/^reports\/(\d+)$/);
      if (mRep && req.method === 'POST') {
        db.prepare(`UPDATE reports SET handled=1 WHERE id=?`).run(parseInt(mRep[1], 10));
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'not found' });
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      const bootJson = JSON.stringify({ authed: ctx.isAdmin, base: BASE_URL, site: SITE_NAME })
        .replace(/</g, '\\u003c');
      const body = fill(tpl('admin.html'), {
        BOOT: '<script>window.__ADMIN__=' + bootJson + ';</script>'
      });
      return html(res, 200, body, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    }

    /* ---- 公开接口 ---- */
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/feed' && isGet) return await apiFeed(req, res, ctx, url);
      if (pathname === '/api/posts' && req.method === 'POST') return await apiCreatePost(req, res, ctx);
      if (pathname === '/api/shred' && req.method === 'POST') return await apiShred(req, res, ctx);
      if (pathname === '/api/ping' && req.method === 'POST') return json(res, 200, { online: onlineCount(), stats: siteStats() });
      if (pathname === '/api/stats' && isGet) return json(res, 200, siteStats());

      let m = pathname.match(/^\/api\/posts\/([\w-]+)\/(like|report|reply)$/);
      if (m) {
        if (m[2] === 'like' && req.method === 'POST') return await apiLike(req, res, ctx, m[1]);
        if (m[2] === 'report' && req.method === 'POST') return await apiReport(req, res, ctx, m[1]);
        if (m[2] === 'reply' && req.method === 'POST') return await apiReply(req, res, ctx, m[1]);
      }
      m = pathname.match(/^\/api\/posts\/([\w-]+)$/);
      if (m && req.method === 'DELETE') return await apiDeletePost(req, res, ctx, m[1]);

      return json(res, 404, { error: 'not found' });
    }

    /* ---- SEO 文件 ---- */
    if (pathname === '/robots.txt') return text(res, 200, renderRobots());
    if (pathname === '/sitemap.xml') return text(res, 200, renderSitemap(), 'application/xml');
    if (pathname === '/rss.xml') return text(res, 200, renderRss(), 'application/rss+xml');
    if (pathname === '/favicon.ico') {
      const ico = path.join(PUBLIC_DIR, 'favicon.svg');
      if (fs.existsSync(ico)) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(ico));
      }
    }
    if (pathname === '/preview.png') return serveStatic(req, res, pathname);

    /* ---- 页面 ---- */
    if (isGet) {
      const mPostPage = pathname.match(/^\/t\/([\w-]+)\/?$/);

      if (pathname === '/' || pathname === '/wall') {
        const body = renderHome(ctx);
        track(req, res, ctx, 'pageview', { path: pathname, title: '首页' });
        return html(res, 200, body);
      }

      if (mPostPage) {
        const body = renderPostPage(mPostPage[1], ctx);
        if (!body) {
          track(req, res, ctx, 'pageview', { path: pathname, title: '404' });
          return html(res, 404, notFound(ctx));
        }
        track(req, res, ctx, 'pageview', { path: pathname, title: '吐槽详情' });
        return html(res, 200, body);
      }

      if (pathname === '/about' || pathname === '/about/') {
        track(req, res, ctx, 'pageview', { path: '/about', title: '关于' });
        return html(res, 200, renderAboutPage(ctx));
      }

      // 静态资源
      if (serveStatic(req, res, pathname)) return;

      track(req, res, ctx, 'pageview', { path: pathname, title: '404' });
      return html(res, 404, notFound(ctx));
    }

    res.writeHead(405, { Allow: 'GET, POST, DELETE' });
    res.end('405');
  } catch (err) {
    if (err && err.message === 'body too large') return json(res, 413, { error: '内容太长了。' });
    if (err && err.message === 'bad json') return json(res, 400, { error: '请求格式不对。' });
    console.error('[请求出错]', req.method, req.url, err);
    try { json(res, 500, { error: '服务器出了点问题。' }); } catch (e) { /* ignore */ }
  }
});

function notFound(ctx) {
  return fill(tpl('404.html'), {
    SEO: seoHead({ title: `页面不见了 · ${SITE_NAME}`, description: '这个页面不存在。', url: BASE_URL + '/', noindex: true }),
    BOOT: bootScript({ base: BASE_URL, page: '404', clientId: ctx.clientId, posts: [], stats: siteStats(), me: {} })
  });
}

/* ---------------- 启动 ---------------- */

seedIfEmpty();
pruneOldData();
setInterval(pruneOldData, 24 * 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log(`  ${SITE_NAME} 已经跑起来了`);
  console.log(line);
  console.log(`  前台：${BASE_URL}/`);
  console.log(`  后台：${BASE_URL}/admin`);
  if (generatedPassword) {
    console.log('');
    console.log('  后台密码（本次随机生成，请记下来）：');
    console.log('    ' + generatedPassword);
    console.log('  正式上线请设置环境变量 ADMIN_PASSWORD 固定它。');
  } else {
    console.log('  后台密码：已通过 ADMIN_PASSWORD 设置');
  }
  if (process.env.IP_SALT) {
    console.log('  访客统计：IP_SALT 已固定');
  } else {
    console.log('  提示：未设置 IP_SALT，重启后统计口径会重算（正式上线请设置）。');
  }
  if (REQUIRE_REVIEW) console.log('  内容模式：先审后发');
  console.log(`  数据库：${DB_PATH}`);
  console.log(line + '\n');
});

process.on('SIGTERM', () => { try { db.close(); } catch (e) {} process.exit(0); });
process.on('SIGINT', () => { try { db.close(); } catch (e) {} process.exit(0); });
