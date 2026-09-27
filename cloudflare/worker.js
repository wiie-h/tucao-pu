/* ============================================================
   吐槽铺 · Cloudflare Workers 版
   和 server.js 功能一致，差别只在运行环境：
     - 常驻 Node 服务  →  Worker 的 fetch 处理器
     - node:sqlite     →  Cloudflare D1
     - 读写本地文件     →  构建时把静态资源内联进来
   下面这段会被构建脚本包在 render.js 和资源清单之后。
   ============================================================ */

var R = globalThis.TucaoRender;
var ASSETS = globalThis.ASSETS || {};
var BUILD = globalThis.BUILD_ID || 'dev';

var MAX_POST_LEN = 300;
var MAX_REPLY_LEN = 120;
var ONLINE_WINDOW = 5 * 60 * 1000;
var SESSION_TTL = 7 * 24 * 3600 * 1000;

var BOT_RE = /(bot|crawler|spider|slurp|baiduspider|googlebot|bingbot|yandex|sogou|360spider|bytespider|petalbot|facebookexternalhit|twitterbot|semrush|ahrefs|python-requests|curl|wget|headlesschrome|lighthouse|monitoring|render|uptime)/i;

var SPAM_PATTERNS = [
  { re: /(?:\+?86[-\s]?)?1[3-9]\d{9}/, why: '手机号' },
  { re: /(?:微信|WeChat|weixin|vx|VX|wx|QQ|qq|扣扣)\s*[:：号]?\s*[A-Za-z0-9_\-]{5,}/, why: '联系方式' },
  { re: /(?:https?:\/\/|www\.)[^\s]+/i, why: '网址' },
  { re: /(加群|代购|刷单|返利|兼职刷|日结|博彩|赌场|棋牌|色情|代开|发票|办证|贷款|加微)/, why: '广告词' }
];

/* ---------------- 基础工具 ---------------- */

function now() { return Date.now(); }

function uid() {
  var b = new Uint8Array(9);
  crypto.getRandomValues(b);
  var s = '';
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function startOfToday() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function sha256Hex(input) {
  var data = new TextEncoder().encode(input);
  var buf = await crypto.subtle.digest('SHA-256', data);
  var arr = new Uint8Array(buf);
  var out = '';
  for (var i = 0; i < arr.length; i++) out += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
  return out;
}

async function hashIp(ip, salt) {
  return (await sha256Hex(String(ip) + '|' + salt)).slice(0, 16);
}

function clientIp(request) {
  var fwd = request.headers.get('x-forwarded-for');
  if (fwd) return String(fwd).split(',')[0].trim();
  var cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  return '0.0.0.0';
}

function parseCookies(request) {
  var out = {};
  var raw = request.headers.get('cookie');
  if (!raw) return out;
  raw.split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i < 0) return;
    var k = part.slice(0, i).trim();
    var v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
  });
  return out;
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

function parseUA(ua) {
  ua = ua || '';
  var device = '电脑';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) device = '平板';
  else if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) device = '手机';

  var browser = '其他';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/MicroMessenger/i.test(ua)) browser = '微信';
  else if (/QQBrowser/i.test(ua)) browser = 'QQ 浏览器';
  else if (/UCBrowser/i.test(ua)) browser = 'UC';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  else if (/curl|wget|node|python/i.test(ua)) browser = '程序';
  return { device: device, browser: browser };
}

function refHost(ref, base) {
  if (!ref) return '直接访问';
  try {
    var u = new URL(ref);
    if (u.hostname === new URL(base).hostname) return '站内';
    return u.hostname.replace(/^www\./, '');
  } catch (e) { return '其他'; }
}

function requestBase(request, env) {
  if (env.BASE_URL) return String(env.BASE_URL).replace(/\/+$/, '');
  var u = new URL(request.url);
  return u.protocol + '//' + u.host;
}

function moderate(text, banned) {
  for (var i = 0; i < banned.length; i++) if (banned[i] && text.indexOf(banned[i]) > -1) return { bad: true, why: '命中词库' };
  for (var j = 0; j < SPAM_PATTERNS.length; j++) {
    if (SPAM_PATTERNS[j].re.test(text)) return { bad: true, why: SPAM_PATTERNS[j].why };
  }
  return { bad: false };
}

/* ---------------- 响应助手 ---------------- */

var SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

function jsonOut(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS)
  });
}

function htmlOut(body, status, extra) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate'
    }, SECURITY_HEADERS, extra || {})
  });
}

function textOut(body, type, status) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, SECURITY_HEADERS)
  });
}

function withCookies(res, cookies) {
  if (!cookies || !cookies.length) return res;
  var h = new Headers(res.headers);
  cookies.forEach(function (c) { h.append('Set-Cookie', c); });
  return new Response(res.body, { status: res.status, headers: h });
}

function cookie(name, value, opts) {
  opts = opts || {};
  var parts = [name + '=' + encodeURIComponent(value), 'Path=' + (opts.path || '/')];
  if (opts.maxAge != null) parts.push('Max-Age=' + Math.floor(opts.maxAge / 1000));
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push('SameSite=' + (opts.sameSite || 'Lax'));
  if (opts.secure) parts.push('Secure');
  if (opts.domain) parts.push('Domain=' + opts.domain);
  return parts.join('; ');
}

/* ---------------- 管理员会话（WebCrypto HMAC） ---------------- */

async function signToken(exp, secret) {
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp)));
  return exp + '.' + b64url(new Uint8Array(sig));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function checkToken(tok, secret) {
  if (!tok || tok.indexOf('.') < 0) return false;
  var parts = tok.split('.');
  var want = await signToken(parts[0], secret);
  if (!safeEqual(tok, want)) return false;
  return Number(parts[0]) > now();
}

function passwordOk(input, expected) {
  return safeEqual(String(input || ''), String(expected || ''));
}

/* ---------------- 数据库 ---------------- */

/* 注意：D1 的 exec() 会按行拆分 SQL，所以这里把每条语句写成单独一行，逐条执行 */
var SCHEMA = [
  "CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, text TEXT NOT NULL, mood TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', nickname TEXT NOT NULL, client_id TEXT, ip_hash TEXT, likes INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_posts_visible ON posts(hidden, pending, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, text TEXT NOT NULL, nickname TEXT NOT NULL, client_id TEXT, ip_hash TEXT, hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id, created_at)",
  "CREATE TABLE IF NOT EXISTS likes (post_id TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (post_id, client_id))",
  "CREATE INDEX IF NOT EXISTS idx_likes_client ON likes(client_id, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS shreds (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, ip_hash TEXT, chars INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_shreds_created ON shreds(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_shreds_ip ON shreds(ip_hash, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, path TEXT, title TEXT, client_id TEXT, ip_hash TEXT, ua TEXT, referrer TEXT, lang TEXT, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_events_ip ON events(ip_hash, type, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, reason TEXT, ip_hash TEXT, handled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_reports_handled ON reports(handled, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS bans (ip_hash TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS presence (client_id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
];

var schemaDone = null;

function ensureSchema(env) {
  if (!schemaDone) {
    schemaDone = (async function () {
      for (var i = 0; i < SCHEMA.length; i++) {
        await env.DB.prepare(SCHEMA[i]).run();
      }
      // 首次运行放一条站长自己的欢迎帖（不是假用户，署名就是「站长」）
      await env.DB.prepare(
        'INSERT INTO posts (id,text,mood,tags,nickname,client_id,ip_hash,likes,hidden,pending,pinned,created_at) ' +
        'SELECT ?,?,?,?,?,NULL,NULL,0,0,0,0,? WHERE NOT EXISTS (SELECT 1 FROM posts)'
      ).bind(
        uid(),
        '欢迎来到吐槽铺。\n\n写下令你不爽的那件事，然后选一个：贴到墙上，让路过的人一起点头；或者直接碎掉它，当没发生过。\n\n这里不用注册、没有算法、没有热搜，只有一堆真实的人和一肚子没好意思说的话。',
        'warm', JSON.stringify(['生活']), '站长', now()
      ).run();
    })().catch(function (e) {
      schemaDone = null;
      throw e;
    });
  }
  return schemaDone;
}

/** 偶尔清理过期数据（Workers 里没有常驻定时器，改成按访问触发） */
var lastPrune = 0;
async function maybePrune(env) {
  if (now() - lastPrune < 3600 * 1000) return;
  lastPrune = now();
  var days = Math.max(parseInt(env.RETENTION_DAYS || '180', 10) || 180, 7);
  var cutoff = now() - days * 24 * 3600 * 1000;
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM events WHERE created_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM reports WHERE handled = 1 AND created_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now() - 3600 * 1000)
    ]);
  } catch (e) { /* 清理失败不影响正常访问 */ }
}

/* ---------------- 查询 ---------------- */

function publicPostRow(r) {
  return {
    id: r.id, text: r.text, mood: r.mood,
    tags: JSON.parse(r.tags || '[]'),
    nickname: r.nickname, likes: r.likes,
    created_at: r.created_at, pending: r.pending, pinned: r.pinned,
    mine: false, liked: false, replies: []
  };
}

async function fetchFeed(env, opts) {
  var mood = opts.mood, sort = opts.sort, search = opts.search;
  var clientId = opts.clientId, onlyMine = opts.onlyMine;
  var limit = Math.min(Math.max(parseInt(opts.limit, 10) || 60, 1), 200);

  var where = ['hidden = 0'];
  var params = [];

  if (!onlyMine) where.push('pending = 0');
  if (mood && mood !== 'all') { where.push('mood = ?'); params.push(mood); }
  if (onlyMine) { where.push('client_id = ?'); params.push(clientId || '__none__'); }
  if (search) {
    where.push('(text LIKE ? OR nickname LIKE ? OR tags LIKE ?)');
    var like = '%' + search + '%';
    params.push(like, like, like);
  }

  var order = sort === 'hot'
    ? 'ORDER BY pinned DESC, (likes + 3 * (SELECT COUNT(*) FROM replies r WHERE r.post_id = posts.id AND r.hidden = 0)) DESC, created_at DESC'
    : 'ORDER BY pinned DESC, created_at DESC';

  var sql = 'SELECT * FROM posts WHERE ' + where.join(' AND ') + ' ' + order + ' LIMIT ?';
  params.push(limit);

  var res = await env.DB.prepare(sql).bind(...params).all();
  var rows = (res && res.results) || [];
  var posts = rows.map(publicPostRow);
  if (!posts.length) return posts;

  var ids = posts.map(function (p) { return p.id; });
  var ph = ids.map(function () { return '?'; }).join(',');

  var replyRes = await env.DB.prepare(
    'SELECT post_id, id, text, nickname, created_at FROM replies WHERE hidden = 0 AND post_id IN (' + ph + ') ORDER BY created_at ASC'
  ).bind(...ids).all();

  var byPost = {};
  ((replyRes && replyRes.results) || []).forEach(function (r) {
    (byPost[r.post_id] = byPost[r.post_id] || []).push({
      id: r.id, text: r.text, nickname: r.nickname, created_at: r.created_at
    });
  });

  var liked = {};
  if (clientId) {
    var likeRes = await env.DB.prepare(
      'SELECT post_id FROM likes WHERE client_id = ? AND post_id IN (' + ph + ')'
    ).bind(...[clientId].concat(ids)).all();
    ((likeRes && likeRes.results) || []).forEach(function (r) { liked[r.post_id] = true; });
  }

  var owner = {};
  rows.forEach(function (r) { owner[r.id] = r.client_id; });

  posts.forEach(function (p) {
    p.replies = byPost[p.id] || [];
    p.liked = !!liked[p.id];
    p.mine = !!(clientId && owner[p.id] === clientId);
  });
  return posts;
}

async function onlineCount(env) {
  var r = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen >= ?')
    .bind(now() - ONLINE_WINDOW).first();
  return (r && r.n) || 0;
}

async function siteStats(env) {
  var today = startOfToday();
  var rows = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE hidden=0 AND pending=0'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE hidden=0 AND pending=0 AND created_at>=?').bind(today),
    env.DB.prepare('SELECT COALESCE(SUM(likes),0) AS n FROM posts WHERE hidden=0'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM replies WHERE hidden=0'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM shreds'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM shreds WHERE created_at>=?').bind(today),
    env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen >= ?').bind(now() - ONLINE_WINDOW)
  ]);
  var v = function (i) { return (rows[i] && rows[i].results && rows[i].results[0] && rows[i].results[0].n) || 0; };
  return {
    online: v(6),
    posts: v(0),
    postsToday: v(1),
    likes: v(2),
    replies: v(3),
    shreds: v(4),
    shredsToday: v(5)
  };
}

/** 频率限制：用数据库计数，多台边缘节点同时跑也准 */
async function overLimit(env, sql, params, max) {
  var r = await env.DB.prepare(sql).bind(...params).first();
  return ((r && r.n) || 0) >= max;
}

async function touchPresence(env, cid) {
  if (!cid) return;
  try {
    await env.DB.prepare(
      'INSERT INTO presence (client_id,last_seen) VALUES (?,?) ' +
      'ON CONFLICT(client_id) DO UPDATE SET last_seen=excluded.last_seen'
    ).bind(cid, now()).run();
  } catch (e) { /* 在线统计失败不影响访问 */ }
}

async function track(env, request, ctx, type, extra) {
  var ua = request.headers.get('user-agent') || '';
  if (BOT_RE.test(ua)) return;
  var info = parseUA(ua);
  try {
    await env.DB.prepare(
      'INSERT INTO events (type,path,title,client_id,ip_hash,ua,referrer,lang,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(
      type,
      (extra && extra.path) || ctx.pathname,
      (extra && extra.title) || null,
      ctx.clientId || null,
      ctx.ipHash,
      info.device + '/' + info.browser,
      (request.headers.get('referer') || '').slice(0, 300) || null,
      clean(request.headers.get('accept-language') || '', 32) || null,
      now()
    ).run();
  } catch (e) { /* 统计失败不影响访问 */ }
}

/* ---------------- 页面渲染 ---------------- */

function tpl(name) {
  var a = ASSETS[name];
  return a ? a.text : '';
}

function versionAssets(html) {
  return html.replace(
    /(href|src)="(\/(?:styles|admin)\.css|\/(?:app|admin|render)\.js|\/favicon\.svg)"/g,
    function (m, attr, url) { return attr + '="' + url + '?v=' + BUILD + '"'; }
  );
}

function fill(html, map) {
  return versionAssets(html.replace(/<!--\{\{(\w+)\}\}-->/g, function (m, k) {
    return map[k] != null ? map[k] : '';
  }));
}

function seoHead(S, o) {
  var image = S.base + '/preview.png';
  var tags = [
    '<title>' + R.esc(o.title) + '</title>',
    '<meta name="description" content="' + R.esc(o.description) + '" />',
    '<meta name="keywords" content="' + R.esc(S.keywords) + '" />',
    '<link rel="canonical" href="' + R.esc(o.url) + '" />',
    '<meta name="robots" content="' + (o.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large') + '" />',
    '<meta property="og:type" content="' + (o.type || 'website') + '" />',
    '<meta property="og:site_name" content="' + R.esc(S.site) + '" />',
    '<meta property="og:title" content="' + R.esc(o.title) + '" />',
    '<meta property="og:description" content="' + R.esc(o.description) + '" />',
    '<meta property="og:url" content="' + R.esc(o.url) + '" />',
    '<meta property="og:image" content="' + R.esc(image) + '" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="twitter:title" content="' + R.esc(o.title) + '" />',
    '<meta name="twitter:description" content="' + R.esc(o.description) + '" />',
    '<meta name="twitter:image" content="' + R.esc(image) + '" />'
  ];
  if (o.jsonLd) tags.push('<script type="application/ld+json">' + JSON.stringify(o.jsonLd) + '</script>');
  if (o.published) tags.push('<meta property="article:published_time" content="' + new Date(o.published).toISOString() + '" />');
  return tags.join('\n');
}

function bootScript(boot) {
  return '<script>window.__BOOT__=' +
    JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '') +
    ';</script>';
}

async function renderHome(env, ctx, S) {
  var posts = await fetchFeed(env, { mood: 'all', sort: 'new', clientId: ctx.clientId, limit: 60 });
  var stats = await siteStats(env);

  var wallHtml = posts.slice(0, 24).map(function (p) {
    return R.noteArticle(p, { mine: p.mine });
  }).join('\n');

  var head = seoHead(S, {
    title: S.site + ' · 24 小时营业，专收坏情绪',
    description: S.desc,
    url: S.base + '/',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: S.site,
      url: S.base + '/',
      description: S.desc,
      inLanguage: 'zh-CN',
      potentialAction: {
        '@type': 'SearchAction',
        target: S.base + '/?q={search_term_string}',
        'query-input': 'required name=search_term_string'
      }
    }
  });

  var boot = {
    base: S.base, clientId: ctx.clientId, nickname: null, posts: posts, stats: stats,
    page: 'home', me: { isAdmin: ctx.isAdmin }
  };

  return fill(tpl('index.html'), {
    SEO: head,
    WALL: wallHtml,
    COUNT: String(stats.posts),
    STAT_ONLINE: String(stats.online),
    STAT_POSTS: String(stats.posts),
    STAT_TODAY: String(stats.postsToday),
    STAT_SHREDS: String(stats.shreds),
    STAT_LIKES: String(stats.likes),
    BOOT: bootScript(boot)
  });
}

async function renderPostPage(env, ctx, S, id) {
  var row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!row || (row.hidden && !ctx.isAdmin)) return null;

  var post = publicPostRow(row);
  var repRes = await env.DB.prepare(
    'SELECT id,text,nickname,created_at FROM replies WHERE post_id=? AND hidden=0 ORDER BY created_at ASC LIMIT 50'
  ).bind(id).all();
  post.replies = (repRes && repRes.results) || [];

  if (ctx.clientId) {
    var lk = await env.DB.prepare('SELECT 1 AS x FROM likes WHERE post_id=? AND client_id=?')
      .bind(id, ctx.clientId).first();
    post.liked = !!lk;
    post.mine = row.client_id === ctx.clientId;
  }

  var m = R.moodOf(post.mood);
  var title = R.plain(post.text, 40) + ' · ' + S.site;
  var desc = post.nickname + '（' + m.emoji + ' ' + m.label + '）：' + R.plain(post.text, 110);

  var head = seoHead(S, {
    title: title,
    description: desc,
    url: S.base + '/t/' + post.id,
    type: 'article',
    published: post.created_at,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'DiscussionForumPosting',
      headline: R.plain(post.text, 110),
      articleBody: post.text,
      datePublished: new Date(post.created_at).toISOString(),
      url: S.base + '/t/' + post.id,
      inLanguage: 'zh-CN',
      author: { '@type': 'Person', name: post.nickname },
      interactionStatistic: [
        { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: post.likes },
        { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.replies.length }
      ],
      isPartOf: { '@type': 'WebSite', name: S.site, url: S.base + '/' }
    }
  });

  var boot = {
    base: S.base, clientId: ctx.clientId, nickname: null, posts: [post],
    stats: await siteStats(env), page: 'post', me: { isAdmin: ctx.isAdmin }
  };

  return fill(tpl('post.html'), {
    SEO: head,
    POST: R.noteArticle(post, { mine: post.mine, expanded: true, hideText: true }),
    NICK: R.esc(post.nickname),
    DATE: R.esc(R.fmtDate(post.created_at)),
    MOOD: m.emoji + ' ' + R.esc(m.label),
    TEXT: R.esc(post.text),
    LIKES: String(post.likes),
    REPLIES: String(post.replies.length),
    BOOT: bootScript(boot)
  });
}

async function renderAboutPage(env, ctx, S) {
  var head = seoHead(S, {
    title: '关于本站 · ' + S.site,
    description: S.site + '是什么、怎么用、你的数据会被怎么处理，以及内容管理规定和联系方式。',
    url: S.base + '/about',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'AboutPage',
      name: '关于本站 · ' + S.site,
      url: S.base + '/about',
      inLanguage: 'zh-CN'
    }
  });
  return fill(tpl('about.html'), {
    SEO: head,
    SITE_NAME: R.esc(S.site),
    BASE_URL: R.esc(S.base),
    CONTACT: S.contact
      ? '<a href="mailto:' + R.esc(S.contact) + '">' + R.esc(S.contact) + '</a>'
      : '<span class="muted">（站长还没有填写联系邮箱）</span>',
    BOOT: bootScript({ base: S.base, page: 'about', clientId: ctx.clientId, posts: [], stats: {}, me: {} })
  });
}

async function notFoundPage(ctx, S) {
  return fill(tpl('404.html'), {
    SEO: seoHead(S, {
      title: '页面不见了 · ' + S.site,
      description: '这个页面不存在。',
      url: S.base + '/',
      noindex: true
    }),
    BOOT: bootScript({ base: S.base, page: '404', clientId: ctx.clientId, posts: [], stats: {}, me: {} })
  });
}

async function sitemapXml(env, S) {
  var res = await env.DB.prepare(
    'SELECT id, created_at FROM posts WHERE hidden = 0 AND pending = 0 ORDER BY created_at DESC LIMIT 2000'
  ).all();
  var urls = [
    '  <url><loc>' + S.base + '/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>',
    '  <url><loc>' + S.base + '/about</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>'
  ].concat(((res && res.results) || []).map(function (r) {
    return '  <url><loc>' + S.base + '/t/' + r.id + '</loc><lastmod>' +
      new Date(r.created_at).toISOString().slice(0, 10) + '</lastmod><priority>0.6</priority></url>';
  }));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>\n';
}

async function rssXml(env, S) {
  var res = await env.DB.prepare(
    'SELECT id, text, nickname, mood, created_at FROM posts WHERE hidden = 0 AND pending = 0 ORDER BY created_at DESC LIMIT 30'
  ).all();
  var items = ((res && res.results) || []).map(function (r) {
    var m = R.moodOf(r.mood);
    var link = S.base + '/t/' + r.id;
    return [
      '    <item>',
      '      <title>' + R.esc(R.plain(r.text, 60)) + '</title>',
      '      <link>' + link + '</link>',
      '      <guid isPermaLink="true">' + link + '</guid>',
      '      <pubDate>' + new Date(r.created_at).toUTCString() + '</pubDate>',
      '      <description>' + R.esc(m.emoji + ' ' + m.label + ' · ' + r.nickname + '：' + r.text) + '</description>',
      '    </item>'
    ].join('\n');
  }).join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n' +
    '  <title>' + R.esc(S.site) + ' · 最新吐槽</title>\n' +
    '  <link>' + S.base + '/</link>\n' +
    '  <description>' + R.esc(S.desc) + '</description>\n' +
    '  <language>zh-CN</language>\n' +
    '  <lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
    items + '\n</channel></rss>\n';
}

/* ---------------- 静态资源（构建时内联） ---------------- */

var assetCache = {};

function decodeB64(b64) {
  var bin = atob(b64);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function assetResponse(pathname, search) {
  var key = pathname.replace(/^\/+/, '') || 'index.html';
  if (/\.html$/.test(key)) return null;          // 模板不直接对外
  var a = ASSETS[key];
  if (!a) return null;
  var etag = '"' + BUILD + '-' + key + '"';
  var longCache = /[?&]v=/.test(search);
  var headers = {
    'Content-Type': a.type,
    'Cache-Control': longCache ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff'
  };
  var body;
  if (a.b64) {
    if (!assetCache[key]) assetCache[key] = decodeB64(a.b64);
    body = assetCache[key];
  } else {
    body = a.text;
  }
  return new Response(body, { headers: headers });
}

/* ---------------- 公开 API ---------------- */

async function readJson(request) {
  var len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len > 16384) throw new Error('too large');
  if (!request.body) return {};
  var text = await request.text();
  if (!text) return {};
  if (text.length > 16384) throw new Error('too large');
  try { return JSON.parse(text); } catch (e) { throw new Error('bad json'); }
}

async function apiFeed(env, ctx, S, url) {
  var posts = await fetchFeed(env, {
    mood: url.searchParams.get('mood') || 'all',
    sort: url.searchParams.get('sort') || 'new',
    search: clean(url.searchParams.get('q') || '', 40),
    clientId: ctx.clientId,
    limit: url.searchParams.get('limit') || 60,
    onlyMine: url.searchParams.get('mine') === '1'
  });
  var stats = await siteStats(env);
  return jsonOut({
    posts: posts, stats: stats,
    version: stats.posts + ':' + stats.likes + ':' + stats.replies + ':' + (posts[0] ? posts[0].id : '')
  });
}

async function apiCreatePost(env, request, ctx, S) {
  var banned = await env.DB.prepare('SELECT 1 AS x FROM bans WHERE ip_hash = ?').bind(ctx.ipHash).first();
  if (banned) return jsonOut({ error: '你已被限制发言。' }, 403);

  if (await overLimit(env,
    'SELECT COUNT(*) AS n FROM posts WHERE ip_hash=? AND created_at>=?',
    [ctx.ipHash, now() - 3600 * 1000], 5)) {
    return jsonOut({ error: '一小时最多发 5 条，缓一缓再来。' }, 429);
  }

  var body = await readJson(request);
  var text = cleanMultiline(body.text, MAX_POST_LEN);
  if (!text) return jsonOut({ error: '写点什么吧，哪怕一个字。' }, 400);

  var moodIds = R.MOODS.map(function (m) { return m.id; });
  var mood = moodIds.indexOf(body.mood) > -1 ? body.mood : 'angry';
  var tags = (Array.isArray(body.tags) ? body.tags : [])
    .filter(function (t) { return R.TAGS.indexOf(t) > -1; }).slice(0, 3);
  var nickname = clean(body.nickname, 20) || '匿名';

  var check = moderate(text, S.banned);
  var pending = (check.bad || S.review) ? 1 : 0;

  var id = uid();
  await env.DB.prepare(
    'INSERT INTO posts (id,text,mood,tags,nickname,client_id,ip_hash,likes,hidden,pending,pinned,created_at) ' +
    'VALUES (?,?,?,?,?,?,?,0,0,?,0,?)'
  ).bind(id, text, mood, JSON.stringify(tags), nickname, ctx.clientId || null, ctx.ipHash, pending, now()).run();

  if (pending) return jsonOut({ pending: true, reason: check.why || '审核', id: id });

  var row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  var post = publicPostRow(row);
  post.mine = true;
  return jsonOut({ pending: false, post: post, stats: await siteStats(env) });
}

async function apiLike(env, request, ctx, id) {
  if (await overLimit(env,
    'SELECT COUNT(*) AS n FROM likes WHERE client_id=? AND created_at>=?',
    [ctx.clientId || '__none__', now() - 60 * 1000], 40)) {
    return jsonOut({ error: '慢一点。' }, 429);
  }

  var row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!row || row.hidden) return jsonOut({ error: '这条已经不在了。' }, 404);

  var cid = ctx.clientId;
  if (!cid) return jsonOut({ error: '缺少标识。' }, 400);

  var had = await env.DB.prepare('SELECT 1 AS x FROM likes WHERE post_id=? AND client_id=?').bind(id, cid).first();
  if (had) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM likes WHERE post_id=? AND client_id=?').bind(id, cid),
      env.DB.prepare('UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?').bind(id)
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO likes (post_id,client_id,created_at) VALUES (?,?,?)').bind(id, cid, now()),
      env.DB.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').bind(id)
    ]);
  }

  var updated = await env.DB.prepare('SELECT likes FROM posts WHERE id = ?').bind(id).first();
  return jsonOut({ liked: !had, likes: (updated && updated.likes) || 0 });
}

async function apiReply(env, request, ctx, id) {
  if (await overLimit(env,
    'SELECT COUNT(*) AS n FROM replies WHERE ip_hash=? AND created_at>=?',
    [ctx.ipHash, now() - 3600 * 1000], 20)) {
    return jsonOut({ error: '一小时最多接 20 句。' }, 429);
  }

  var row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!row || row.hidden || row.pending) return jsonOut({ error: '这条已经不在了。' }, 404);

  var body = await readJson(request);
  var text = cleanMultiline(body.text, MAX_REPLY_LEN);
  if (!text) return jsonOut({ error: '写点什么吧。' }, 400);

  var check = moderate(text, []);
  if (check.bad) return jsonOut({ error: '这句话里好像有联系方式或广告，发不出去。' }, 400);

  var nickname = clean(body.nickname, 20) || '匿名';
  var rid = uid();
  await env.DB.prepare(
    'INSERT INTO replies (id,post_id,text,nickname,client_id,ip_hash,hidden,created_at) VALUES (?,?,?,?,?,?,0,?)'
  ).bind(rid, id, text, nickname, ctx.clientId || null, ctx.ipHash, now()).run();

  return jsonOut({ reply: { id: rid, text: text, nickname: nickname, created_at: now() } });
}

async function apiReport(env, request, ctx, id) {
  if (await overLimit(env,
    'SELECT COUNT(*) AS n FROM reports WHERE ip_hash=? AND created_at>=?',
    [ctx.ipHash, now() - 3600 * 1000], 10)) {
    return jsonOut({ error: '举报太频繁了。' }, 429);
  }
  var body = await readJson(request);
  var row = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first();
  if (!row) return jsonOut({ error: '这条已经不在了。' }, 404);
  await env.DB.prepare('INSERT INTO reports (post_id,reason,ip_hash,handled,created_at) VALUES (?,?,?,0,?)')
    .bind(id, clean(body.reason, 100) || '未填写原因', ctx.ipHash, now()).run();
  return jsonOut({ ok: true });
}

async function apiDeletePost(env, ctx, id) {
  var row = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
  if (!row) return jsonOut({ error: '已经删掉了。' }, 404);
  if (!ctx.isAdmin && row.client_id !== ctx.clientId) return jsonOut({ error: '只能删自己发的。' }, 403);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM replies WHERE post_id = ?').bind(id),
    env.DB.prepare('DELETE FROM likes WHERE post_id = ?').bind(id),
    env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id)
  ]);
  return jsonOut({ ok: true });
}

async function apiShred(env, request, ctx) {
  if (await overLimit(env,
    'SELECT COUNT(*) AS n FROM shreds WHERE ip_hash=? AND created_at>=?',
    [ctx.ipHash, now() - 3600 * 1000], 60)) {
    return jsonOut({ error: '慢一点。' }, 429);
  }
  var body = await readJson(request);
  var chars = Math.min(Math.max(parseInt(body.chars, 10) || 0, 0), 5000);
  // 注意：只记「碎掉了几个字」，绝不保存内容本身
  await env.DB.prepare('INSERT INTO shreds (client_id,ip_hash,chars,created_at) VALUES (?,?,?,?)')
    .bind(ctx.clientId || null, ctx.ipHash, chars, now()).run();
  return jsonOut({ stats: await siteStats(env) });
}

/* ---------------- 后台 API ---------------- */

async function qmany(env, defs) {
  var stmts = defs.map(function (d) { return env.DB.prepare(d[1]).bind(...(d[2] || [])); });
  var res = await env.DB.batch(stmts);
  var out = {};
  defs.forEach(function (d, i) {
    var r = res[i];
    out[d[0]] = (r && r.results && r.results[0]) || {};
  });
  return out;
}

function n1(row) { return (row && row.n) || 0; }

async function adminOverview(env, S) {
  var t0 = startOfToday();
  var t24 = now() - 24 * 3600 * 1000;
  var t30 = now() - 30 * 24 * 3600 * 1000;

  var m = await qmany(env, [
    ['online', 'SELECT COUNT(*) AS n FROM presence WHERE last_seen >= ?', [now() - ONLINE_WINDOW]],
    ['pv5', "SELECT COUNT(*) AS n FROM events WHERE type='pageview' AND created_at>=?", [now() - 5 * 60 * 1000]],
    ['pv1h', "SELECT COUNT(*) AS n FROM events WHERE type='pageview' AND created_at>=?", [now() - 3600 * 1000]],
    ['todayPv', "SELECT COUNT(*) AS n FROM events WHERE type='pageview' AND created_at>=?", [t0]],
    ['todayUv', "SELECT COUNT(DISTINCT client_id) AS n FROM events WHERE type='pageview' AND client_id IS NOT NULL AND created_at>=?", [t0]],
    ['todayPosts', 'SELECT COUNT(*) AS n FROM posts WHERE hidden=0 AND pending=0 AND created_at>=?', [t0]],
    ['todayReplies', 'SELECT COUNT(*) AS n FROM replies WHERE hidden=0 AND created_at>=?', [t0]],
    ['todayShreds', 'SELECT COUNT(*) AS n FROM shreds WHERE created_at>=?', [t0]],
    ['todayLikes', 'SELECT COUNT(*) AS n FROM likes WHERE created_at>=?', [t0]],
    ['pv', "SELECT COUNT(*) AS n FROM events WHERE type='pageview'"],
    ['uv', "SELECT COUNT(DISTINCT client_id) AS n FROM events WHERE type='pageview' AND client_id IS NOT NULL"],
    ['posts', 'SELECT COUNT(*) AS n FROM posts WHERE hidden=0 AND pending=0'],
    ['allPosts', 'SELECT COUNT(*) AS n FROM posts'],
    ['replies', 'SELECT COUNT(*) AS n FROM replies WHERE hidden=0'],
    ['shreds', 'SELECT COUNT(*) AS n FROM shreds'],
    ['likes', 'SELECT COALESCE(SUM(likes),0) AS n FROM posts'],
    ['pending', 'SELECT COUNT(*) AS n FROM posts WHERE pending=1 AND hidden=0'],
    ['hidden', 'SELECT COUNT(*) AS n FROM posts WHERE hidden=1'],
    ['reports', 'SELECT COUNT(*) AS n FROM reports WHERE handled=0'],
    ['bans', 'SELECT COUNT(*) AS n FROM bans']
  ]);

  var moodDefs = R.MOODS.map(function (mo) {
    return ['mood_' + mo.id, 'SELECT COUNT(*) AS n FROM posts WHERE mood=? AND hidden=0 AND pending=0', [mo.id]];
  });
  var moods = await qmany(env, moodDefs);

  var devRes = await env.DB.prepare(
    "SELECT ua AS name, COUNT(*) AS count FROM events WHERE type='pageview' AND created_at>=? AND ua IS NOT NULL GROUP BY ua ORDER BY count DESC LIMIT 8"
  ).bind(t30).all();
  var refRes = await env.DB.prepare(
    "SELECT referrer AS name, COUNT(*) AS count FROM events WHERE type='pageview' AND created_at>=? GROUP BY referrer ORDER BY count DESC LIMIT 8"
  ).bind(t30).all();
  var topRes = await env.DB.prepare(
    'SELECT id, text, mood, likes, nickname, ' +
    '(SELECT COUNT(*) FROM replies r WHERE r.post_id=p.id AND r.hidden=0) AS replies ' +
    'FROM posts p WHERE hidden=0 AND pending=0 ORDER BY likes DESC, replies DESC LIMIT 6'
  ).all();

  return {
    now: now(),
    live: { online: n1(m.online), pv5: n1(m.pv5), pv60: n1(m.pv1h) },
    today: {
      pv: n1(m.todayPv), uv: n1(m.todayUv), posts: n1(m.todayPosts),
      replies: n1(m.todayReplies), shreds: n1(m.todayShreds), likes: n1(m.todayLikes)
    },
    total: {
      pv: n1(m.pv), uv: n1(m.uv), posts: n1(m.posts), allPosts: n1(m.allPosts),
      replies: n1(m.replies), shreds: n1(m.shreds), likes: n1(m.likes)
    },
    moderation: {
      pending: n1(m.pending), hidden: n1(m.hidden), reports: n1(m.reports), bans: n1(m.bans)
    },
    moods: R.MOODS.map(function (mo) {
      return { id: mo.id, label: mo.label, emoji: mo.emoji, color: mo.line, count: n1(moods['mood_' + mo.id]) };
    }),
    devices: ((devRes && devRes.results) || []).map(function (r) { return { name: r.name, count: r.count }; }),
    referrers: ((refRes && refRes.results) || []).map(function (r) {
      return { name: refHost(r.name, S.base), count: r.count };
    }),
    topPosts: (topRes && topRes.results) || [],
    recent: []
  };
}

function dayKey(ts) {
  var d = new Date(ts);
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function adminTimeline(env, days) {
  days = Math.min(Math.max(days || 14, 1), 90);
  var t0 = startOfToday() - (days - 1) * 24 * 3600 * 1000;
  var res = await env.DB.batch([
    env.DB.prepare("SELECT substr(datetime(created_at/1000,'unixepoch','localtime'),1,10) AS d, COUNT(*) AS n FROM events WHERE type='pageview' AND created_at>=? GROUP BY d").bind(t0),
    env.DB.prepare("SELECT substr(datetime(created_at/1000,'unixepoch','localtime'),1,10) AS d, COUNT(DISTINCT client_id) AS n FROM events WHERE type='pageview' AND client_id IS NOT NULL AND created_at>=? GROUP BY d").bind(t0),
    env.DB.prepare("SELECT substr(datetime(created_at/1000,'unixepoch','localtime'),1,10) AS d, COUNT(*) AS n FROM posts WHERE created_at>=? GROUP BY d").bind(t0)
  ]);
  var toMap = function (i) {
    var o = {};
    (((res[i] && res[i].results) || [])).forEach(function (r) { o[r.d] = r.n; });
    return o;
  };
  var pv = toMap(0), uv = toMap(1), po = toMap(2);
  var out = [];
  for (var i = 0; i < days; i++) {
    var k = dayKey(t0 + i * 24 * 3600 * 1000);
    out.push({ date: k, pv: pv[k] || 0, uv: uv[k] || 0, posts: po[k] || 0 });
  }
  return out;
}

async function adminHourly(env) {
  var t0 = now() - 24 * 3600 * 1000;
  var res = await env.DB.prepare(
    "SELECT substr(datetime(created_at/1000,'unixepoch','localtime'),1,13) AS h, COUNT(*) AS n FROM events WHERE type='pageview' AND created_at>=? GROUP BY h"
  ).bind(t0).all();
  var map = {};
  (((res && res.results) || [])).forEach(function (r) { map[r.h] = r.n; });

  var out = [];
  for (var i = 23; i >= 0; i--) {
    var d = new Date(now() - i * 3600 * 1000);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var k = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours());
    out.push({ hour: k.slice(11) + ':00', pv: map[k] || 0 });
  }
  return out;
}

/* ---------------- 路由 ---------------- */

async function handle(request, env) {
  var url = new URL(request.url);
  var pathname = decodeURIComponent(url.pathname);
  var isSecure = url.protocol === 'https:';

  var cookies = parseCookies(request);
  var clientId = cookies.tucao_cid;
  var setCookies = [];

  if (!clientId || !/^[A-Za-z0-9_-]{8,40}$/.test(clientId)) {
    clientId = uid() + uid();
    setCookies.push(cookie('tucao_cid', clientId, {
      maxAge: 400 * 24 * 3600 * 1000, httpOnly: false, sameSite: 'Lax', secure: isSecure
    }));
  }

  var S = {
    base: requestBase(request, env),
    site: env.SITE_NAME || '吐槽铺',
    desc: env.SITE_DESC || '一个可以随便吐槽的地方。写下你的破烂事，贴到墙上让大家一起同感，或者干脆碎掉它。',
    keywords: env.SITE_KEYWORDS || '吐槽,树洞,心情,发泄,情绪,匿名,倾诉,抱怨,吐槽墙',
    contact: env.CONTACT_EMAIL || '',
    banned: String(env.BANNED_WORDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    review: env.REQUIRE_REVIEW === '1'
  };

  var secret = env.ADMIN_PASSWORD || 'tucao-not-configured';
  var ctx = {
    clientId: clientId,
    ipHash: await hashIp(clientIp(request), env.IP_SALT || 'tucao-default-salt'),
    isAdmin: await checkToken(cookies.tucao_admin, secret),
    pathname: pathname
  };

  await ensureSchema(env);
  maybePrune(env);

  var isGet = request.method === 'GET' || request.method === 'HEAD';
  var isPage = pathname === '/' || pathname === '/wall' || pathname === '/about' ||
    /^\/t\/[\w-]+\/?$/.test(pathname);

  if (isPage || pathname === '/api/ping') await touchPresence(env, clientId);

  try {
    /* ---- 健康检查（不计入统计） ---- */
    if (pathname === '/healthz') return jsonOut({ ok: true, ts: now() });

    /* ---- 后台登录 / 退出 ---- */
    if (pathname === '/admin/login' && request.method === 'POST') {
      if (!env.ADMIN_PASSWORD) return jsonOut({ error: '服务端还没有配置 ADMIN_PASSWORD。' }, 500);
      if (await overLimit(env,
        "SELECT COUNT(*) AS n FROM events WHERE type='login' AND ip_hash=? AND created_at>=?",
        [ctx.ipHash, now() - 15 * 60 * 1000], 10)) {
        return withCookies(jsonOut({ error: '尝试次数太多，请 15 分钟后再试。' }, 429), setCookies);
      }
      var loginBody = await readJson(request);
      if (!passwordOk(loginBody.password, env.ADMIN_PASSWORD)) {
        await env.DB.prepare("INSERT INTO events (type,path,client_id,ip_hash,created_at) VALUES ('login',?,?,?,?)")
          .bind(pathname, clientId, ctx.ipHash, now()).run();
        return withCookies(jsonOut({ error: '密码不对。' }, 401), setCookies);
      }
      setCookies.push(cookie('tucao_admin', await signToken(now() + SESSION_TTL, secret), {
        maxAge: SESSION_TTL, httpOnly: true, sameSite: 'Strict', path: '/admin', secure: isSecure
      }));
      return withCookies(jsonOut({ ok: true }), setCookies);
    }

    if (pathname === '/admin/logout' && request.method === 'POST') {
      setCookies.push(cookie('tucao_admin', '', { maxAge: 0, httpOnly: true, sameSite: 'Strict', path: '/admin', secure: isSecure }));
      return withCookies(jsonOut({ ok: true }), setCookies);
    }

    /* ---- 后台接口 ---- */
    if (pathname.indexOf('/admin/api/') === 0) {
      if (!ctx.isAdmin) return withCookies(jsonOut({ error: '未登录' }, 401), setCookies);
      var sub = pathname.slice('/admin/api/'.length);

      if (sub === 'overview') return withCookies(jsonOut(await adminOverview(env, S)), setCookies);

      if (sub === 'timeline') {
        var days = parseInt(url.searchParams.get('days') || '14', 10);
        return withCookies(jsonOut({
          days: await adminTimeline(env, days),
          hourly: await adminHourly(env)
        }), setCookies);
      }

      if (sub === 'reports') {
        var rp = await env.DB.prepare(
          'SELECT r.id, r.post_id, r.reason, r.handled, r.created_at, p.text, p.nickname, p.hidden ' +
          'FROM reports r LEFT JOIN posts p ON p.id = r.post_id ORDER BY r.handled ASC, r.created_at DESC LIMIT 100'
        ).all();
        return withCookies(jsonOut({ reports: (rp && rp.results) || [] }), setCookies);
      }

      if (sub === 'bans') {
        if (request.method === 'GET') {
          var bn = await env.DB.prepare('SELECT * FROM bans ORDER BY created_at DESC LIMIT 200').all();
          return withCookies(jsonOut({ bans: (bn && bn.results) || [] }), setCookies);
        }
        var bBody = await readJson(request);
        if (bBody.action === 'add') {
          await env.DB.prepare('INSERT OR IGNORE INTO bans (ip_hash,reason,created_at) VALUES (?,?,?)')
            .bind(clean(bBody.ipHash, 64), clean(bBody.reason, 100), now()).run();
          return withCookies(jsonOut({ ok: true }), setCookies);
        }
        if (bBody.action === 'remove') {
          await env.DB.prepare('DELETE FROM bans WHERE ip_hash = ?').bind(clean(bBody.ipHash, 64)).run();
          return withCookies(jsonOut({ ok: true }), setCookies);
        }
        return withCookies(jsonOut({ error: '未知操作' }, 400), setCookies);
      }

      if (sub === 'export') {
        var ex = await env.DB.prepare(
          'SELECT id,nickname,mood,tags,likes,hidden,pending,created_at,text FROM posts ORDER BY created_at DESC LIMIT 5000'
        ).all();
        var quote = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
        var csv = ['id,昵称,心情,标签,同感,隐藏,待审,时间,内容']
          .concat(((ex && ex.results) || []).map(function (r) {
            return [r.id, r.nickname, r.mood, r.tags, r.likes, r.hidden, r.pending,
              new Date(r.created_at).toISOString(), r.text].map(quote).join(',');
          })).join('\n');
        return withCookies(new Response('\uFEFF' + csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="tucao-posts.csv"',
            'Cache-Control': 'no-store'
          }
        }), setCookies);
      }

      if (sub === 'events') {
        var ev = await env.DB.prepare(
          "SELECT path, ua, referrer, lang, created_at FROM events WHERE type='pageview' ORDER BY created_at DESC LIMIT 60"
        ).all();
        return withCookies(jsonOut({
          events: ((ev && ev.results) || []).map(function (r) {
            return {
              path: r.path, ua: r.ua, referrer: r.referrer, lang: r.lang,
              created_at: r.created_at, ref: refHost(r.referrer, S.base)
            };
          })
        }), setCookies);
      }

      if (sub === 'posts') {
        var filter = url.searchParams.get('filter') || 'all';
        var term = clean(url.searchParams.get('q') || '', 40);
        var limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
        var offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
        var where = [];
        var params = [];
        if (filter === 'hidden') where.push('hidden = 1');
        if (filter === 'pending') { where.push('pending = 1'); where.push('hidden = 0'); }
        if (filter === 'reported') where.push('id IN (SELECT post_id FROM reports WHERE handled=0)');
        if (term) { where.push('(text LIKE ? OR nickname LIKE ?)'); params.push('%' + term + '%', '%' + term + '%'); }
        var clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        var listRes = await env.DB.prepare(
          'SELECT id,text,nickname,mood,tags,likes,hidden,pending,pinned,created_at, ' +
          '(SELECT COUNT(*) FROM replies r WHERE r.post_id=posts.id) AS replies, ' +
          '(SELECT COUNT(*) FROM reports rp WHERE rp.post_id=posts.id AND rp.handled=0) AS reports ' +
          'FROM posts ' + clause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
        ).bind(...params.concat([limit, offset])).all();

        var totalRes = await env.DB.prepare('SELECT COUNT(*) AS n FROM posts ' + clause)
          .bind(...params).first();

        return withCookies(jsonOut({
          posts: (listRes && listRes.results) || [],
          total: (totalRes && totalRes.n) || 0,
          limit: limit, offset: offset
        }), setCookies);
      }

      var mp = sub.match(/^posts\/([\w-]+)$/);
      if (mp && request.method === 'POST') {
        var id = mp[1];
        var exists = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
        if (!exists) return withCookies(jsonOut({ error: '找不到这条' }, 404), setCookies);
        var act = (await readJson(request)).action;
        var stmts = [];
        if (act === 'hide') stmts.push(env.DB.prepare('UPDATE posts SET hidden=1, pending=0 WHERE id=?').bind(id));
        else if (act === 'show') stmts.push(env.DB.prepare('UPDATE posts SET hidden=0, pending=0 WHERE id=?').bind(id));
        else if (act === 'pin') stmts.push(env.DB.prepare('UPDATE posts SET pinned=1 WHERE id=?').bind(id));
        else if (act === 'unpin') stmts.push(env.DB.prepare('UPDATE posts SET pinned=0 WHERE id=?').bind(id));
        else if (act === 'delete') stmts.push(
          env.DB.prepare('DELETE FROM replies WHERE post_id=?').bind(id),
          env.DB.prepare('DELETE FROM likes WHERE post_id=?').bind(id),
          env.DB.prepare('DELETE FROM posts WHERE id=?').bind(id)
        );
        else if (act === 'ban') {
          if (exists.ip_hash) stmts.push(
            env.DB.prepare('INSERT OR IGNORE INTO bans (ip_hash,reason,created_at) VALUES (?,?,?)')
              .bind(exists.ip_hash, '来自后台：' + R.plain(exists.text, 40), now())
          );
          stmts.push(env.DB.prepare('UPDATE posts SET hidden=1, pending=0 WHERE id=?').bind(id));
        } else return withCookies(jsonOut({ error: '未知操作' }, 400), setCookies);
        await env.DB.batch(stmts);
        return withCookies(jsonOut({ ok: true }), setCookies);
      }

      var mr = sub.match(/^reports\/(\d+)$/);
      if (mr && request.method === 'POST') {
        await env.DB.prepare('UPDATE reports SET handled=1 WHERE id=?').bind(parseInt(mr[1], 10)).run();
        return withCookies(jsonOut({ ok: true }), setCookies);
      }

      return withCookies(jsonOut({ error: 'not found' }, 404), setCookies);
    }

    /* ---- 后台页面 ---- */
    if (pathname === '/admin' || pathname === '/admin/') {
      var adminBoot = JSON.stringify({ authed: ctx.isAdmin, base: S.base, site: S.site }).replace(/</g, '\\u003c');
      var adminBody = fill(tpl('admin.html'), {
        BOOT: '<script>window.__ADMIN__=' + adminBoot + ';</script>'
      });
      return withCookies(htmlOut(adminBody, 200, {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow'
      }), setCookies);
    }

    /* ---- 公开接口 ---- */
    if (pathname.indexOf('/api/') === 0) {
      if (pathname === '/api/feed' && isGet) return withCookies(await apiFeed(env, ctx, S, url), setCookies);
      if (pathname === '/api/posts' && request.method === 'POST') return withCookies(await apiCreatePost(env, request, ctx, S), setCookies);
      if (pathname === '/api/shred' && request.method === 'POST') return withCookies(await apiShred(env, request, ctx), setCookies);
      if (pathname === '/api/ping' && request.method === 'POST') {
        return withCookies(jsonOut({ online: await onlineCount(env), stats: await siteStats(env) }), setCookies);
      }
      if (pathname === '/api/stats' && isGet) return withCookies(jsonOut(await siteStats(env)), setCookies);

      var ma = pathname.match(/^\/api\/posts\/([\w-]+)\/(like|report|reply)$/);
      if (ma) {
        if (ma[2] === 'like' && request.method === 'POST') return withCookies(await apiLike(env, request, ctx, ma[1]), setCookies);
        if (ma[2] === 'report' && request.method === 'POST') return withCookies(await apiReport(env, request, ctx, ma[1]), setCookies);
        if (ma[2] === 'reply' && request.method === 'POST') return withCookies(await apiReply(env, request, ctx, ma[1]), setCookies);
      }

      var md = pathname.match(/^\/api\/posts\/([\w-]+)$/);
      if (md && request.method === 'DELETE') return withCookies(await apiDeletePost(env, ctx, md[1]), setCookies);

      return withCookies(jsonOut({ error: 'not found' }, 404), setCookies);
    }

    /* ---- SEO 文件 ---- */
    if (pathname === '/robots.txt') {
      return withCookies(textOut([
        'User-agent: *',
        'Allow: /',
        'Disallow: /admin',
        'Disallow: /admin/',
        'Disallow: /api/',
        '',
        'Sitemap: ' + S.base + '/sitemap.xml',
        ''
      ].join('\n'), 'text/plain'), setCookies);
    }
    if (pathname === '/sitemap.xml') return withCookies(textOut(await sitemapXml(env, S), 'application/xml'), setCookies);
    if (pathname === '/rss.xml') return withCookies(textOut(await rssXml(env, S), 'application/rss+xml'), setCookies);

    /* ---- 页面 ---- */
    if (isGet) {
      var mpost = pathname.match(/^\/t\/([\w-]+)\/?$/);

      if (pathname === '/' || pathname === '/wall') {
        var homeBody = await renderHome(env, ctx, S);
        await track(env, request, ctx, 'pageview', { path: pathname, title: '首页' });
        return withCookies(htmlOut(homeBody), setCookies);
      }

      if (mpost) {
        var postBody = await renderPostPage(env, ctx, S, mpost[1]);
        if (!postBody) {
          await track(env, request, ctx, 'pageview', { path: pathname, title: '404' });
          return withCookies(htmlOut(await notFoundPage(ctx, S), 404), setCookies);
        }
        await track(env, request, ctx, 'pageview', { path: pathname, title: '吐槽详情' });
        return withCookies(htmlOut(postBody), setCookies);
      }

      if (pathname === '/about' || pathname === '/about/') {
        var aboutBody = await renderAboutPage(env, ctx, S);
        await track(env, request, ctx, 'pageview', { path: '/about', title: '关于' });
        return withCookies(htmlOut(aboutBody), setCookies);
      }

      var asset = assetResponse(pathname, url.search);
      if (asset) {
        if (request.headers.get('if-none-match') === asset.headers.get('ETag')) {
          return withCookies(new Response(null, { status: 304, headers: asset.headers }), setCookies);
        }
        return withCookies(asset, setCookies);
      }

      await track(env, request, ctx, 'pageview', { path: pathname, title: '404' });
      return withCookies(htmlOut(await notFoundPage(ctx, S), 404), setCookies);
    }

    return withCookies(jsonOut({ error: 'method not allowed' }, 405), setCookies);
  } catch (err) {
    if (err && err.message === 'too large') return withCookies(jsonOut({ error: '内容太长了。' }, 413), setCookies);
    if (err && err.message === 'bad json') return withCookies(jsonOut({ error: '请求格式不对。' }, 400), setCookies);
    console.error('[请求出错]', request.method, url.pathname, err && err.stack);
    return withCookies(jsonOut({ error: '服务器出了点问题。' }, 500), setCookies);
  }
}

export default {
  async fetch(request, env, executionCtx) {
    try {
      var res = await handle(request, env);
      if (request.method === 'HEAD' && res.body) {
        return new Response(null, { status: res.status, headers: res.headers });
      }
      return res;
    } catch (e) {
      var msg = (e && e.stack) || (e && e.message) || String(e);
      console.error('[Worker 未捕获错误]', msg);
      return new Response(JSON.stringify({ error: '服务器出了点问题。' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  }
};
