/* ============================================================
   吐槽铺 · 中控台
   数据来自 /admin/api/*，每 10 秒自动刷新一次。
   ============================================================ */
(function () {
  'use strict';

  var BOOT = window.__ADMIN__ || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var ui = {
    filter: 'all',
    q: '',
    days: 14,
    timer: null,
    busy: false
  };

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(n) {
    n = Number(n) || 0;
    return n.toLocaleString('zh-CN');
  }

  function ago(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return Math.max(1, Math.floor(d / 1000)) + ' 秒前';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function clock(ts) {
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var el = $('#atoast');
    el.textContent = msg;
    el.style.background = bad ? '#8C2B1E' : '';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        if (r.status === 401) { showLogin(); throw new Error('未登录'); }
        return r.json().catch(function () { return {}; });
      });
  }

  /* ---------------- 图表（手写 SVG） ---------------- */

  function chartWidth(el) { return Math.max(el.clientWidth || 520, 260); }

  /** 面积折线图：单序列 */
  function areaChart(el, rows, color) {
    var W = chartWidth(el), H = 190;
    var padL = 34, padR = 10, padT = 12, padB = 24;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max(1, rows.reduce(function (m, r) { return Math.max(m, r.v); }, 0));
    max = niceMax(max);

    var n = rows.length;
    var x = function (i) { return padL + (n <= 1 ? iw / 2 : (iw * i) / (n - 1)); };
    var y = function (v) { return padT + ih - (v / max) * ih; };

    var pts = rows.map(function (r, i) { return [x(i), y(r.v)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (padT + ih) +
      ' L' + pts[0][0].toFixed(1) + ' ' + (padT + ih) + ' Z';

    var gid = 'g' + Math.random().toString(36).slice(2, 8);
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (ih * g) / 4;
      var gv = Math.round(max - (max * g) / 4);
      grid += '<line class="grid-line" x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '"/>' +
        '<text class="axis" x="' + (padL - 7) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end">' + gv + '</text>';
    }

    var labels = '';
    rows.forEach(function (r, i) {
      if (i % 6 !== 0 && i !== n - 1) return;
      labels += '<text class="axis" x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(r.label) + '</text>';
    });

    var dots = rows.map(function (r, i) {
      if (!r.v) return '';
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(r.v).toFixed(1) + '" r="2.6" fill="' + color + '"/>' +
        '<title>' + esc(r.label) + '：' + r.v + '</title>';
    }).join('');
    var hit = rows.map(function (r, i) {
      var w = iw / Math.max(n - 1, 1);
      return '<rect x="' + (x(i) - w / 2).toFixed(1) + '" y="' + padT + '" width="' + w.toFixed(1) + '" height="' + ih + '" fill="transparent"><title>' +
        esc(r.label) + '：' + r.v + ' 次浏览</title></rect>';
    }).join('');

    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="近 24 小时访问量">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity=".34"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path class="line" d="' + line + '" stroke="' + color + '"/>' +
      dots + hit + labels +
      '</svg>';
  }

  /** 分组柱状图：多序列 */
  function groupChart(el, rows, series) {
    var W = chartWidth(el), H = 210;
    var padL = 34, padR = 10, padT = 12, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = 1;
    rows.forEach(function (r) { series.forEach(function (s) { max = Math.max(max, r[s.key] || 0); }); });
    max = niceMax(max);

    var n = rows.length;
    var step = iw / n;
    var barGap = 2;
    var barW = Math.max(2, (step * 0.68 - barGap * (series.length - 1)) / series.length);

    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (ih * g) / 4;
      var gv = Math.round(max - (max * g) / 4);
      grid += '<line class="grid-line" x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '"/>' +
        '<text class="axis" x="' + (padL - 7) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end">' + gv + '</text>';
    }

    var bars = '';
    rows.forEach(function (r, i) {
      var gx = padL + step * i + (step - (barW * series.length + barGap * (series.length - 1))) / 2;
      series.forEach(function (s, si) {
        var v = r[s.key] || 0;
        var h = Math.max(v > 0 ? 2 : 0, (v / max) * ih);
        var bx = gx + si * (barW + barGap);
        bars += '<rect x="' + bx.toFixed(1) + '" y="' + (padT + ih - h).toFixed(1) + '" width="' + barW.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="' + Math.min(3, barW / 2).toFixed(1) + '" fill="' + s.color + '">' +
          '<title>' + esc(r.date.slice(5)) + ' · ' + esc(s.label) + '：' + v + '</title></rect>';
      });
    });

    var labels = '';
    var every = n > 20 ? 5 : (n > 10 ? 2 : 1);
    rows.forEach(function (r, i) {
      if (i % every !== 0 && i !== n - 1) return;
      labels += '<text class="axis" x="' + (padL + step * i + step / 2).toFixed(1) + '" y="' + (H - 8) +
        '" text-anchor="middle">' + esc(r.date.slice(5)) + '</text>';
    });

    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="访问趋势">' +
      grid + bars + labels + '</svg>';
  }

  function niceMax(v) {
    if (v <= 5) return 5;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var norm = v / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  /* ---------------- 列表渲染 ---------------- */

  function renderBars(el, rows, color, total) {
    if (!rows || !rows.length) { el.innerHTML = '<p class="bars__empty">还没有数据</p>'; return; }
    var max = rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0) || 1;
    el.innerHTML = rows.map(function (r) {
      var pct = Math.max(2, (r.count / max) * 100);
      return '<div class="barRow">' +
        '<div class="barRow__top">' +
          '<span class="barRow__name">' + esc(r.name) + '</span>' +
          '<span class="barRow__n">' + num(r.count) +
            (total ? '<small>' + Math.round((r.count / total) * 100) + '%</small>' : '') + '</span>' +
        '</div>' +
        '<div class="barRow__track"><div class="barRow__fill" style="width:' + pct.toFixed(1) + '%;background:' + (r.color || color) + '"></div></div>' +
      '</div>';
    }).join('');
  }

  function renderKpis(o) {
    var kpis = [
      { k: '当前在线', v: o.live.online, d: '近 5 分钟 ' + o.live.pv5 + ' 次浏览', c: '#35A17C' },
      { k: '今日浏览量 PV', v: o.today.pv, d: '累计 ' + num(o.total.pv), c: '#FF4D3D' },
      { k: '今日独立访客 UV', v: o.today.uv, d: '累计 ' + num(o.total.uv), c: '#FFC93C' },
      { k: '今日新增吐槽', v: o.today.posts, d: '公开累计 ' + num(o.total.posts) + ' 条', c: '#A97BF0' },
      { k: '今日碎掉', v: o.today.shreds, d: '累计 ' + num(o.total.shreds) + ' 条', c: '#5B9BF8' },
      { k: '待处理', v: o.moderation.reports + o.moderation.pending,
        d: '举报 ' + o.moderation.reports + ' · 待审 ' + o.moderation.pending + ' · 已隐藏 ' + o.moderation.hidden, c: '#FF8B7E' }
    ];
    $('#kpiRow').innerHTML = kpis.map(function (x) {
      return '<div class="kpi" style="--c:' + x.c + '">' +
        '<span class="kpi__k">' + esc(x.k) + '</span>' +
        '<span class="kpi__v">' + num(x.v) + '</span>' +
        '<span class="kpi__d">' + esc(x.d) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderTops(rows) {
    var el = $('#topPosts');
    if (!rows.length) { el.innerHTML = '<p class="bars__empty">还没有吐槽</p>'; return; }
    el.innerHTML = rows.map(function (p) {
      return '<div class="row">' +
        '<div class="row__main">' +
          '<div class="row__text">' + esc(p.text) + '</div>' +
          '<div class="row__meta">' +
            '<span class="tagx">' + esc(p.nickname) + '</span>' +
            '<span>🙋 ' + p.likes + '</span>' +
            '<span>💬 ' + p.replies + '</span>' +
            '<a class="tagx" href="/t/' + esc(p.id) + '" target="_blank" rel="noopener">打开 ↗</a>' +
          '</div>' +
        '</div>' +
        '<div class="row__acts"><span class="stars">' + p.likes + '</span></div>' +
      '</div>';
    }).join('');
  }

  function renderEvents(rows) {
    var el = $('#eventList');
    if (!rows.length) { el.innerHTML = '<p class="bars__empty">还没有访问记录。把前台链接发给朋友试试？</p>'; return; }
    el.innerHTML = rows.map(function (e) {
      return '<div class="row">' +
        '<div class="row__main">' +
          '<div class="row__text ev__path">' + esc(e.path || '/') + '</div>' +
          '<div class="row__meta">' +
            '<span class="ev__ua">' + esc(e.ua || '未知设备') + '</span>' +
            '<span>' + esc(e.ref) + '</span>' +
            '<span>' + esc(e.lang || '') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="row__acts"><span class="ev__time">' + ago(e.created_at) + '</span></div>' +
      '</div>';
    }).join('');
  }

  function renderPosts(data) {
    var el = $('#postList');
    if (!data.posts.length) {
      el.innerHTML = '<p class="bars__empty">这个条件下没有内容。</p>';
      $('#postFoot').textContent = '';
      return;
    }
    el.innerHTML = data.posts.map(function (p) {
      var badges = '';
      if (p.pinned) badges += '<span class="badge badge--pin">置顶</span>';
      if (p.pending) badges += '<span class="badge badge--pending">待审</span>';
      if (p.hidden) badges += '<span class="badge badge--hidden">已隐藏</span>';
      if (p.reports) badges += '<span class="badge badge--report">被举报 ' + p.reports + '</span>';

      return '<div class="row" data-post="' + esc(p.id) + '">' +
        '<div class="row__main">' +
          '<div class="row__text">' + esc(p.text) + '</div>' +
          '<div class="row__meta">' +
            badges +
            '<span class="tagx">' + esc(p.nickname) + '</span>' +
            '<span>🙋 ' + p.likes + '</span>' +
            '<span>💬 ' + p.replies + '</span>' +
            '<span>' + clock(p.created_at) + '（' + ago(p.created_at) + '）</span>' +
          '</div>' +
        '</div>' +
        '<div class="row__acts">' +
          (p.hidden
            ? '<button class="abtn abtn--ok abtn--sm" data-act="show" data-id="' + esc(p.id) + '">恢复</button>'
            : '<button class="abtn abtn--ghost abtn--sm" data-act="hide" data-id="' + esc(p.id) + '">隐藏</button>') +
          (p.pinned
            ? '<button class="abtn abtn--ghost abtn--sm" data-act="unpin" data-id="' + esc(p.id) + '">取消置顶</button>'
            : '<button class="abtn abtn--gold abtn--sm" data-act="pin" data-id="' + esc(p.id) + '">置顶</button>') +
          '<a class="abtn abtn--ghost abtn--sm" href="/t/' + esc(p.id) + '" target="_blank" rel="noopener">查看</a>' +
          '<button class="abtn abtn--danger abtn--sm" data-act="ban" data-id="' + esc(p.id) + '" title="隐藏这条并禁止该来源继续发帖">封禁来源</button>' +
          '<button class="abtn abtn--danger abtn--sm" data-act="delete" data-id="' + esc(p.id) + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
    $('#postFoot').textContent = '共 ' + data.total + ' 条，当前显示 ' + data.posts.length + ' 条';
  }

  function renderReports(rows) {
    var el = $('#reportList');
    var open = rows.filter(function (r) { return !r.handled; });
    if (!rows.length) { el.innerHTML = '<p class="bars__empty">还没有人举报，说明大家都在好好说话。</p>'; return; }
    el.innerHTML = rows.map(function (r) {
      return '<div class="row">' +
        '<div class="row__main">' +
          '<div class="row__text">' + esc(r.text || '（这条已被删除）') + '</div>' +
          '<div class="row__meta">' +
            (r.handled ? '<span class="badge badge--hidden">已处理</span>' : '<span class="badge badge--report">待处理</span>') +
            '<span class="tagx">' + esc(r.reason || '未填写') + '</span>' +
            (r.nickname ? '<span>' + esc(r.nickname) + '</span>' : '') +
            '<span>' + clock(r.created_at) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="row__acts">' +
          (r.post_id ? '<a class="abtn abtn--ghost abtn--sm" href="/t/' + esc(r.post_id) + '" target="_blank" rel="noopener">查看</a>' : '') +
          (r.post_id && !r.hidden ? '<button class="abtn abtn--danger abtn--sm" data-rpost="' + esc(r.post_id) + '">隐藏原帖</button>' : '') +
          (r.handled ? '' : '<button class="abtn abtn--ok abtn--sm" data-resolve="' + r.id + '">标记已处理</button>') +
        '</div>' +
      '</div>';
    }).join('');
    return open.length;
  }

  /* ---------------- 拉取数据 ---------------- */

  function refresh(silent) {
    if (ui.busy) return Promise.resolve();
    ui.busy = true;
    if (!silent) {
      ['#hourly', '#trend'].forEach(function (s) { var e = $(s); if (e && !e.innerHTML.trim()) e.innerHTML = '<p class="loading">加载中…</p>'; });
    }

    var postsUrl = '/admin/api/posts?filter=' + encodeURIComponent(ui.filter) +
      '&q=' + encodeURIComponent(ui.q) + '&limit=60';

    return Promise.all([
      api('/admin/api/overview'),
      api('/admin/api/timeline?days=' + ui.days),
      api(postsUrl),
      api('/admin/api/reports'),
      api('/admin/api/events')
    ]).then(function (r) {
      ui.busy = false;
      var o = r[0], tl = r[1], posts = r[2], reports = r[3], events = r[4];

      $('#hOnline').textContent = o.live.online;
      $('#lastUpdate').textContent = '最后更新 ' + clock(o.now) + ' · 每 10 秒自动刷新';

      renderKpis(o);
      areaChart($('#hourly'), tl.hourly.map(function (h) { return { label: h.hour.slice(0, 2), v: h.pv }; }), '#FF4D3D');
      groupChart($('#trend'), tl.days, [
        { key: 'pv', label: '浏览量 PV', color: '#FF4D3D' },
        { key: 'uv', label: '独立访客 UV', color: '#FFC93C' },
        { key: 'posts', label: '新增吐槽', color: '#35A17C' }
      ]);

      var moodTotal = o.moods.reduce(function (s, m) { return s + m.count; }, 0);
      renderBars($('#moods'), o.moods.filter(function (m) { return m.count > 0; })
        .map(function (m) { return { name: m.emoji + ' ' + m.label, count: m.count, color: m.color }; }),
        '#FF4D3D', moodTotal);

      var refTotal = o.referrers.reduce(function (s, x) { return s + x.count; }, 0);
      renderBars($('#refs'), o.referrers.map(function (x) { return { name: x.name, count: x.count }; }), '#5B9BF8', refTotal);

      var devTotal = o.devices.reduce(function (s, x) { return s + x.count; }, 0);
      var devColor = { '手机': '#35A17C', '电脑': '#5B9BF8', '平板': '#A97BF0', '未知': '#7E7268' };
      renderBars($('#devices'), o.devices.map(function (x) {
        var parts = String(x.name).split('/');
        return { name: parts[0], count: x.count, color: devColor[parts[0]] || '#7E7268' };
      }).reduce(function (acc, cur) {
        var hit = acc.filter(function (a) { return a.name === cur.name; })[0];
        if (hit) { hit.count += cur.count; return acc; }
        acc.push(cur); return acc;
      }, []).sort(function (a, b) { return b.count - a.count; }), '#35A17C', devTotal);

      var brTotal = o.devices.reduce(function (s, x) { return s + x.count; }, 0);
      var brCount = {};
      o.devices.forEach(function (x) {
        var b = String(x.name).split('/')[1] || '其他';
        brCount[b] = (brCount[b] || 0) + x.count;
      });
      renderBars($('#browsers'), Object.keys(brCount).map(function (k) { return { name: k, count: brCount[k] }; })
        .sort(function (a, b) { return b.count - a.count; }), '#FFC93C', brTotal);

      renderTops(o.topPosts);
      renderEvents(events.events);
      renderPosts(posts);
      renderReports(reports.reports);

      $('#cPending').textContent = o.moderation.pending;
      $('#cReports').textContent = o.moderation.reports;
      $('#cHidden').textContent = o.moderation.hidden;
    }).catch(function (e) {
      ui.busy = false;
      if (e.message !== '未登录') toast('加载失败：' + e.message, true);
    });
  }

  /* ---------------- 动作 ---------------- */

  function postAction(id, action) {
    if (action === 'delete' && !confirm('确定要永久删除这条吐槽吗？删了就找不回来了。')) return;
    if (action === 'ban' && !confirm('将隐藏这条内容，并禁止这个来源继续发帖。确定吗？')) return;

    api('/admin/api/posts/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action })
    }).then(function (r) {
      if (r.error) return toast(r.error, true);
      var words = { hide: '已隐藏', show: '已恢复', pin: '已置顶', unpin: '已取消置顶', delete: '已删除', ban: '已封禁并隐藏' };
      toast(words[action] || '操作完成');
      refresh(true);
    }).catch(function () { toast('操作失败', true); });
  }

  /* ---------------- 登录 ---------------- */

  function showLogin() {
    $('#loginView').hidden = false;
    $('#dashView').hidden = true;
    if (ui.timer) { clearInterval(ui.timer); ui.timer = null; }
  }

  function showDash() {
    $('#loginView').hidden = true;
    $('#dashView').hidden = false;
    refresh();
    if (ui.timer) clearInterval(ui.timer);
    ui.timer = setInterval(function () {
      if ($('#autoRefresh').checked && !document.hidden) refresh(true);
    }, 10000);
  }

  /* ---------------- 绑定 ---------------- */

  function bindOnce() {
    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#loginBtn');
      btn.disabled = true;
      $('#loginErr').hidden = true;

      fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#pwd').value }),
        credentials: 'same-origin'
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          btn.disabled = false;
          if (d.ok) { $('#pwd').value = ''; showDash(); }
          else { $('#loginErr').textContent = d.error || '密码不对。'; $('#loginErr').hidden = false; }
        })
        .catch(function () {
          btn.disabled = false;
          $('#loginErr').textContent = '连不上服务器。';
          $('#loginErr').hidden = false;
        });
    });

    $('#logoutBtn').addEventListener('click', function () {
      fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function () { showLogin(); });
    });

    $('#refreshBtn').addEventListener('click', function () { refresh(); toast('已刷新'); });

    $$('#daysSeg .aseg__i').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.days = parseInt(b.dataset.days, 10);
        $$('#daysSeg .aseg__i').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        refresh(true);
      });
    });

    $$('#filterSeg .aseg__i').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.filter = b.dataset.filter;
        $$('#filterSeg .aseg__i').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        refresh(true);
      });
    });

    var t = null;
    $('#postSearch').addEventListener('input', function (e) {
      var v = e.target.value.trim();
      clearTimeout(t);
      t = setTimeout(function () { ui.q = v; refresh(true); }, 300);
    });

    $('#postList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (b) postAction(b.dataset.id, b.dataset.act);
    });

    $('#reportList').addEventListener('click', function (e) {
      var res = e.target.closest('[data-resolve]');
      if (res) {
        api('/admin/api/reports/' + res.dataset.resolve, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function () { toast('已标记处理'); refresh(true); });
        return;
      }
      var hide = e.target.closest('[data-rpost]');
      if (hide) postAction(hide.dataset.rpost, 'hide');
    });

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (!$('#dashView').hidden) refresh(true); }, 300);
    });
  }

  function init() {
    bindOnce();
    if (BOOT.authed) showDash();
    else showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
