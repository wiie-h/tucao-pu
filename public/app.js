/* ============================================================
   吐槽铺 · 前台互动
   数据全部来自服务端接口，浏览器只负责展示和交互。
   ============================================================ */
(function () {
  'use strict';

  var R = window.TucaoRender;
  var BOOT = window.__BOOT__ || {};
  var API = (BOOT.base || '') + '/api';
  var PAGE = BOOT.page || 'home';
  var BARE = PAGE === 'post';   // 分享页：正文已经在大标题里了，卡片只放互动和回复

  var MAX_LEN = 300;
  var MAX_TAGS = 3;
  var REPORT_REASONS = ['骂人 / 攻击别人', '泄露了我的隐私', '广告或垃圾信息', '内容看不下去', '其他问题'];

  var ADJ = ['暴躁', '委屈', '无语', '摆烂', '熬夜', '内耗', '社恐', '摸鱼', '佛系', '干饭',
             '清醒', '沉默', '秃头', '起不来床', 'emo', '硬撑', '嘴硬', '打工', 'emo到', '快要离职'];
  var NOUN = ['锅包肉', '小笼包', '咸鱼', '柠檬精', '卷心菜', '打工人', '土豆', '奶茶',
              '火鸡面', '煎饼', '猕猴桃', '柚子', '椰子', '蛋挞', '榴莲', '猪大肠',
              '小面包', '云吞', '西柚', '咖啡'];
  var INSPIRATION = [
    '同事在群里发了一句「收到」，然后什么也没做。',
    '外卖迟到四十分钟，汤洒了半碗。',
    '我妈第 108 次问我什么时候结婚。',
    '熬夜到两点，为了一个其实不重要的东西。',
    '微信里 800 个人，找不到一个现在能打电话的。',
    '计划写了三页，执行了十分钟。',
    '开完会，想不起来会上说了什么。',
    '朋友圈里所有人都在旅游，只有我在改 PPT。',
    '地铁上被挤成了纸片。',
    '明明什么都没干，但就是很累。',
    '又给自己买了用不上的东西。',
    '群里 @ 全体成员，结果是通知周末加班。',
    '复习到凌晨，考的全是没看的。',
    '楼上装修第三天了。',
    '想说的话打了一半，又删掉了。',
    '刷了两小时手机，现在头很晕，什么也没记住。',
    '我提的方案没人理，三天后别人复述了一遍，全场鼓掌。',
    '排队二十分钟，轮到我时刚好卖完。'
  ];

  /* ---------------- 工具 ---------------- */

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  /** 绑定事件；元素不存在就安静跳过（分享页只用到其中一部分组件） */
  function on(sel, ev, fn) { var el = $(sel); if (el) el.addEventListener(ev, fn); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function randomNickname() { return pick(ADJ) + '的' + pick(NOUN); }

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* 隐私模式下忽略 */ }
    return null;
  }

  /* ---------------- 音效（现场合成，无音频文件） ---------------- */

  var audio = null, soundOn = true;
  function ac() {
    if (!soundOn) return null;
    if (!audio) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audio = new Ctx();
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  function tone(f1, dur, vol, type, f2) {
    var c = ac(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f1, c.currentTime);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, c.currentTime + dur);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, c.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur + 0.03);
  }
  function noise(dur, vol, freq) {
    var c = ac(); if (!c) return;
    var len = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    var src = c.createBufferSource(); src.buffer = buf;
    var f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 2400; f.Q.value = 0.8;
    var g = c.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(c.destination);
    src.start();
  }
  var sfx = {
    pop:   function () { tone(520, 0.14, 0.07, 'sine', 880); },
    drop:  function () { tone(340, 0.12, 0.06, 'triangle', 260); setTimeout(function () { tone(260, 0.16, 0.05, 'triangle', 200); }, 70); },
    rip:   function () { noise(0.5, 0.16, 1900); },
    shred: function () { noise(0.65, 0.2, 1500); setTimeout(function () { noise(0.4, 0.13, 2600); }, 130); },
    ding:  function () { tone(1180, 0.5, 0.06, 'sine'); tone(1760, 0.6, 0.035, 'sine'); },
    nope:  function () { tone(200, 0.16, 0.06, 'square', 130); },
    roll:  function () { tone(700 + Math.random() * 400, 0.07, 0.05, 'square'); }
  };

  /* ---------------- 局内状态 ---------------- */

  var state = {
    posts: (BOOT.posts || []).slice(),
    stats: BOOT.stats || {},
    total: (BOOT.stats && BOOT.stats.posts) || 0
  };
  var ui = {
    mood: 'angry', tags: [], sort: 'new', q: '', onlyMine: false,
    moodFilter: 'all', expanded: {}, replyFor: null, freshId: null,
    limit: 60, loading: false
  };
  var nickname = store('tucao.nickname') || randomNickname();
  store('tucao.nickname', nickname);

  /* ---------------- 提示条 ---------------- */

  function toast(msg, actionLabel, onAction, ms) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    var s = document.createElement('span');
    s.textContent = msg;
    el.appendChild(s);
    if (actionLabel) {
      var b = document.createElement('button');
      b.className = 'toast__act';
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', function () { onAction && onAction(); kill(); });
      el.appendChild(b);
    }
    box.appendChild(el);
    var dead = false;
    var timer = setTimeout(kill, ms || (actionLabel ? 5200 : 2600));
    function kill() {
      if (dead) return;
      dead = true;
      clearTimeout(timer);
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 280);
    }
  }

  function burst(x, y, colors, count) {
    for (var i = 0; i < (count || 14); i++) {
      var c = document.createElement('i');
      c.className = 'confetti';
      var ang = Math.random() * Math.PI * 2;
      var dist = 40 + Math.random() * 110;
      c.style.left = x + 'px';
      c.style.top = y + 'px';
      c.style.background = colors[Math.floor(Math.random() * colors.length)];
      c.style.setProperty('--tx', (Math.cos(ang) * dist).toFixed(1) + 'px');
      c.style.setProperty('--ty', (Math.sin(ang) * dist - 30).toFixed(1) + 'px');
      c.style.setProperty('--tr', (Math.random() * 720 - 360).toFixed(0) + 'deg');
      c.style.animationDelay = (Math.random() * 90).toFixed(0) + 'ms';
      if (Math.random() > 0.6) c.style.borderRadius = '50%';
      document.body.appendChild(c);
      (function (n) { setTimeout(function () { n.remove(); }, 1350); })(c);
    }
  }
  function burstFrom(el, colors, count) {
    var r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, colors, count);
  }

  /* ---------------- 接口 ---------------- */

  function req(method, url, body) {
    return fetch(API + url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw Object.assign(new Error(data.error || '出错了'), { status: r.status, data: data });
        return data;
      });
    });
  }

  function loadFeed(silent) {
    if (ui.loading) return Promise.resolve();
    ui.loading = true;
    var qs = '?mood=' + encodeURIComponent(ui.moodFilter) +
      '&sort=' + encodeURIComponent(ui.sort) +
      '&q=' + encodeURIComponent(ui.q) +
      '&mine=' + (ui.onlyMine ? '1' : '0') +
      '&limit=' + ui.limit;

    return req('GET', '/feed' + qs).then(function (data) {
      if (!silent || data.version !== ui.version) {
        state.posts = data.posts;
        state.stats = data.stats;
        ui.version = data.version;
        renderWall();
      }
      ui.loading = false;
    }).catch(function (e) {
      ui.loading = false;
      if (!silent) toast('加载失败：' + e.message);
    });
  }

  /* ---------------- 渲染 ---------------- */

  function moodVars(m) {
    return '--m-line:' + m.line + ';--m-note:' + m.note + ';--m-ink:' + m.ink + ';';
  }

  function renderMoods() {
    var box = $('#moods');
    if (!box) return;
    box.innerHTML = '';
    R.MOODS.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mood' + (ui.mood === m.id ? ' is-on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(ui.mood === m.id));
      b.style.cssText = moodVars(m);
      b.innerHTML = '<span>' + m.emoji + '</span>' + R.esc(m.label);
      b.addEventListener('click', function () { ui.mood = m.id; sfx.pop(); renderMoods(); });
      box.appendChild(b);
    });
  }

  function renderTags() {
    var box = $('#tags');
    if (!box) return;
    box.innerHTML = '';
    R.TAGS.forEach(function (t) {
      var on = ui.tags.indexOf(t) > -1;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tag' + (on ? ' is-on' : '');
      b.textContent = t;
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', function () {
        var i = ui.tags.indexOf(t);
        if (i > -1) ui.tags.splice(i, 1);
        else {
          if (ui.tags.length >= MAX_TAGS) { sfx.nope(); toast('最多贴 ' + MAX_TAGS + ' 个标签，够用啦。'); return; }
          ui.tags.push(t);
        }
        sfx.pop();
        renderTags();
      });
      box.appendChild(b);
    });
  }

  function renderFilters() {
    var box = $('#moodFilter');
    if (!box) return;
    box.innerHTML = '';
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'filter' + (ui.moodFilter === 'all' ? ' is-on' : '');
    all.textContent = '全部';
    all.addEventListener('click', function () { ui.moodFilter = 'all'; renderFilters(); loadFeed(); });
    box.appendChild(all);

    R.MOODS.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'filter' + (ui.moodFilter === m.id ? ' is-on' : '');
      b.style.cssText = moodVars(m);
      b.textContent = m.emoji + ' ' + m.label;
      b.addEventListener('click', function () { ui.moodFilter = m.id; renderFilters(); loadFeed(); });
      box.appendChild(b);
    });
  }

  function renderWall() {
    var box = $('#wallList');
    if (!box) return;
    var empty = $('#empty');
    var list = state.posts;

    var count = $('#wallCount');
    if (count) {
      count.textContent = (ui.onlyMine || ui.q || ui.moodFilter !== 'all'
        ? list.length + ' 条'
        : (state.stats.posts || list.length) + ' 条');
    }

    if (!list.length) {
      box.innerHTML = '';
      if (empty) empty.hidden = false;
      var lm0 = $('#loadMoreBtn'); if (lm0) lm0.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;

    box.innerHTML = list.map(function (p) {
      return R.noteArticle(p, {
        mine: p.mine,
        fresh: ui.freshId === p.id,
        expanded: !!ui.expanded[p.id],
        replyOpen: ui.replyFor === p.id,
        hideText: BARE
      });
    }).join('\n');

    var lm = $('#loadMoreBtn');
    if (lm) lm.hidden = !(list.length >= ui.limit && ui.limit < 200);

    if (ui.replyFor) {
      var input = box.querySelector('.reply-form input');
      if (input) input.focus();
    }
  }

  function renderStats() {
    var s = state.stats || {};
    var set = function (sel, v) { var el = $(sel); if (el && v != null) el.textContent = v; };
    set('#stOnline', s.online);
    set('#stPosts', s.posts);
    set('#stToday', s.postsToday);
    set('#stShred', s.shreds);
    var ol = $('#onlineLabel');
    if (ol) ol.textContent = s.online ? (s.online + ' 人在店里') : '营业中';
  }

  /* ---------------- 发布 ---------------- */

  function currentText() { return $('#ta').value.trim(); }

  function nudge() {
    var c = $('#composerCard');
    c.classList.remove('is-nudge');
    void c.offsetWidth;
    c.classList.add('is-nudge');
    $('#ta').focus();
  }

  function publish() {
    var text = currentText();
    if (!text) { sfx.nope(); nudge(); toast('写点什么吧，哪怕一个字。'); return; }

    var btn = $('#postBtn');
    btn.disabled = true;

    req('POST', '/posts', { text: text, mood: ui.mood, tags: ui.tags, nickname: nickname })
      .then(function (data) {
        btn.disabled = false;

        if (data.pending) {
          sfx.nope();
          $('#ta').value = '';
          updateCounter();
          toast('这条被系统拦下来等站长看看（' + (data.reason || '可能不合规') + '）。');
          return;
        }

        state.posts.unshift(data.post);
        if (data.stats) state.stats = data.stats;
        ui.freshId = data.post.id;
        setTimeout(function () { ui.freshId = null; }, 900);

        $('#ta').value = '';
        updateCounter();
        var card = $('#composerCard');
        card.classList.remove('is-posting');
        void card.offsetWidth;
        card.classList.add('is-posting');

        sfx.drop();
        burstFrom(btn, [R.moodOf(data.post.mood).line, '#FFC93C', '#FF4D3D'], 16);

        if (ui.moodFilter !== 'all') { ui.moodFilter = 'all'; renderFilters(); }
        if (ui.onlyMine) { ui.onlyMine = false; $('#onlyMine').checked = false; }
        if (ui.q) { ui.q = ''; $('#search').value = ''; }
        ui.sort = 'new';
        $$('#sortSeg .seg__i').forEach(function (b) { b.classList.toggle('is-on', b.dataset.sort === 'new'); });

        renderWall();
        renderStats();
        toast('已经贴到墙上了 📌', '去看看', function () {
          $('#wall').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      })
      .catch(function (e) {
        btn.disabled = false;
        sfx.nope();
        toast(e.message || '发布失败');
      });
  }

  /* ---------------- 碎纸 ---------------- */

  var modal = $('#modal');
  var shredPaper = $('#shredPaper');
  var shredConfirm = $('#shredConfirm');
  var shredDone = $('#shredDone');
  var lastFocus = null;

  function buildShredPaper(text) {
    shredPaper.style.visibility = '';
    shredPaper.classList.remove('is-quaking');
    shredPaper.innerHTML = '';
    var frag = document.createDocumentFragment();
    text.split('').forEach(function (ch) {
      if (ch === '\n') { frag.appendChild(document.createElement('br')); return; }
      var s = document.createElement('span');
      s.textContent = ch;
      frag.appendChild(s);
    });
    shredPaper.appendChild(frag);
  }

  function openShred() {
    var text = currentText();
    if (!text) { sfx.nope(); nudge(); toast('还没写呢，先写一句再碎。'); return; }
    lastFocus = document.activeElement;
    buildShredPaper(text);
    shredConfirm.hidden = false;
    shredConfirm.style.visibility = '';
    shredDone.hidden = true;
    $('.modal__panel').classList.remove('is-shredding');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { $('#doShred').focus(); }, 60);
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    shredPaper.classList.remove('is-quaking');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function doShred() {
    var spans = $$('span', shredPaper);
    var chars = spans.length;

    shredConfirm.style.visibility = 'hidden';
    $('.modal__panel').classList.add('is-shredding');
    sfx.shred();
    shredPaper.classList.add('is-quaking');

    // 只把「碎掉了几个字」发给服务器，内容一个字都不上传
    req('POST', '/shred', { chars: chars }).then(function (d) {
      if (d.stats) { state.stats = d.stats; }
    }).catch(function () {});

    setTimeout(function () {
      spans.forEach(function (s, i) {
        var ang = Math.random() * Math.PI * 2;
        var dist = 90 + Math.random() * 220;
        s.style.transitionDelay = (i * 2.2) + 'ms';
        s.style.transform = 'translate(' + (Math.cos(ang) * dist).toFixed(0) + 'px,' +
          (Math.sin(ang) * dist - 40).toFixed(0) + 'px) rotate(' +
          (Math.random() * 900 - 450).toFixed(0) + 'deg) scale(.6)';
        s.classList.add('is-gone');
      });
      shredPaper.classList.remove('is-quaking');
    }, 380);

    var panel = $('.modal__panel').getBoundingClientRect();
    burst(panel.left + panel.width / 2, panel.top + 130,
      ['#C9BFB2', '#A79C8E', '#E7DECD', '#8C8178', '#FFFCF6'], 26);

    setTimeout(function () {
      shredPaper.innerHTML = '';
      shredPaper.style.visibility = 'hidden';
      shredConfirm.hidden = true;
      shredConfirm.style.visibility = '';
      $('.modal__panel').classList.remove('is-shredding');
      shredDone.hidden = false;
      sfx.ding();
      $('#shredDoneSub').textContent =
        '就当没发生过 —— 那口气我们替你回收了。全站到现在一共碎掉了 ' +
        ((state.stats.shreds != null ? state.stats.shreds : 0)) + ' 条。';
      renderStats();
      $('#ta').value = '';
      updateCounter();
    }, 1450);
  }

  /* ---------------- 举报 ---------------- */

  var reportPostId = null;
  function openReport(id) {
    reportPostId = id;
    var box = $('#reportReasons');
    box.innerHTML = '';
    REPORT_REASONS.forEach(function (r, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'report__reason' + (i === 0 ? ' is-on' : '');
      b.textContent = r;
      b.addEventListener('click', function () {
        $$('.report__reason', box).forEach(function (x) { x.classList.toggle('is-on', x === b); });
      });
      box.appendChild(b);
    });
    $('#reportBox').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeReport() {
    $('#reportBox').hidden = true;
    document.body.style.overflow = '';
  }
  function submitReport() {
    var reason = ($('.report__reason.is-on') || {}).textContent || '其他问题';
    req('POST', '/posts/' + reportPostId + '/report', { reason: reason })
      .then(function () { closeReport(); sfx.ding(); toast('收到，站长会尽快处理 🙏'); })
      .catch(function (e) { closeReport(); toast(e.message || '举报失败'); });
  }

  /* ---------------- 输入框 ---------------- */

  var lastPh = -1;
  function rotatePlaceholder(force) {
    var ta = $('#ta');
    if (!ta || ta.value || document.activeElement === ta) return;
    var i = Math.floor(Math.random() * INSPIRATION.length);
    if (INSPIRATION.length > 1 && i === lastPh) i = (i + 1) % INSPIRATION.length;
    lastPh = i;
    ta.setAttribute('placeholder', INSPIRATION[i]);
    if (force) sfx.roll();
  }

  function updateCounter() {
    var n = $('#ta').value.length;
    var el = $('#counter');
    if (!el) return;
    el.textContent = n + ' / ' + MAX_LEN;
    el.classList.toggle('is-warn', n > MAX_LEN - 40);
  }

  function rollNickname() {
    var next = randomNickname(), guard = 0;
    while (next === nickname && guard++ < 10) next = randomNickname();
    nickname = next;
    store('tucao.nickname', next);
    var el = $('#nickName');
    el.style.transition = 'transform .12s, opacity .12s';
    el.style.transform = 'scale(.7) rotate(-6deg)';
    el.style.opacity = '0';
    setTimeout(function () {
      el.textContent = next;
      el.style.transform = '';
      el.style.opacity = '';
    }, 120);
    sfx.roll();
  }

  function copyLink(id) {
    var url = location.origin + '/t/' + id;
    var done = function () { sfx.ding(); toast('链接复制好了，去分享吧 🔗'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('复制这个链接：', url); });
    } else {
      window.prompt('复制这个链接：', url);
    }
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    on('#ta', 'input', updateCounter);
    on('#ta', 'keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); publish(); }
    });
    on('#postBtn', 'click', publish);
    on('#shredBtn', 'click', openShred);
    on('#doShred', 'click', doShred);
    on('#inspireBtn', 'click', function () { rotatePlaceholder(true); });
    on('#rollBtn', 'click', rollNickname);
    on('#doReport', 'click', submitReport);
    on('#reportBox', 'click', function (e) {
      if (e.target.closest('[data-close]') || e.target.id === 'reportBox') closeReport();
    });

    on('#topWriteBtn', 'click', function () {
      var c = $('#composer');
      if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { var t = $('#ta'); if (t) t.focus(); }, 420);
    });

    $$('[data-scroll]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = $(b.dataset.scroll);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: t.id === 'wall' ? 'start' : 'center' });
      });
    });

    on('#loadMoreBtn', 'click', function () {
      ui.limit = Math.min(ui.limit + 60, 200);
      loadFeed();
    });

    $$('#sortSeg .seg__i').forEach(function (b) {
      b.addEventListener('click', function () {
        if (ui.sort === b.dataset.sort) return;
        ui.sort = b.dataset.sort;
        $$('#sortSeg .seg__i').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        loadFeed();
      });
    });

    on('#onlyMine', 'change', function (e) {
      ui.onlyMine = e.target.checked;
      loadFeed();
    });

    var searchTimer = null;
    on('#search', 'input', function (e) {
      var v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { ui.q = v.trim(); loadFeed(); }, 260);
    });

    on('#modal', 'click', function (e) {
      if (e.target.closest('[data-close]')) closeModal();
    });

    on('#againBtn', 'click', function () {
      closeModal();
      var c = $('#composer');
      if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { var t = $('#ta'); if (t) t.focus(); rotatePlaceholder(true); }, 420);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!modal.hidden) closeModal();
      if (!$('#reportBox').hidden) closeReport();
    });

    var sb = $('#soundBtn');
    if (sb) sb.addEventListener('click', function () {
      soundOn = !soundOn;
      sb.textContent = soundOn ? '🔊' : '🔇';
      sb.classList.toggle('is-off', !soundOn);
      if (soundOn) sfx.pop();
    });

    $('#wallList').addEventListener('click', function (e) {
      var t = e.target;
      var el;
      if ((el = t.closest('[data-like]'))) return toggleLike(el.dataset.like, el);
      if ((el = t.closest('[data-replybtn]'))) {
        var id = el.dataset.replybtn;
        ui.replyFor = ui.replyFor === id ? null : id;
        renderWall();
        return;
      }
      if ((el = t.closest('[data-more]'))) { ui.expanded[el.dataset.more] = true; renderWall(); return; }
      if ((el = t.closest('[data-del]'))) return removePost(el.dataset.del);
      if ((el = t.closest('[data-report]'))) return openReport(el.dataset.report);
      if ((el = t.closest('[data-share]'))) return copyLink(el.dataset.share);
      if ((el = t.closest('[data-tag]'))) {
        $('#search').value = el.dataset.tag;
        ui.q = el.dataset.tag;
        loadFeed();
        window.scrollTo({ top: $('#wall').offsetTop - 70, behavior: 'smooth' });
        return;
      }
    });

    $('#wallList').addEventListener('submit', function (e) {
      var form = e.target.closest('[data-reply]');
      if (!form) return;
      e.preventDefault();
      var input = form.querySelector('input');
      var text = input.value.trim();
      if (!text) { sfx.nope(); input.focus(); return; }
      var id = form.dataset.reply;
      input.disabled = true;
      req('POST', '/posts/' + id + '/reply', { text: text, nickname: nickname })
        .then(function (d) {
          var p = state.posts.filter(function (x) { return x.id === id; })[0];
          if (p) { p.replies.push(d.reply); }
          ui.replyFor = null;
          ui.expanded[id] = true;
          sfx.pop();
          renderWall();
          toast('接上了 💬');
        })
        .catch(function (err) { input.disabled = false; sfx.nope(); toast(err.message || '发送失败'); });
    });
  }

  function toggleLike(id, btn) {
    var p = state.posts.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var wasLiked = p.liked;
    p.liked = !wasLiked;
    p.likes += p.liked ? 1 : -1;
    if (p.likes < 0) p.likes = 0;

    btn.classList.toggle('is-on', p.liked);
    btn.setAttribute('aria-pressed', String(p.liked));
    btn.querySelector('b').textContent = p.likes;
    btn.classList.remove('act--pop');
    void btn.offsetWidth;
    btn.classList.add('act--pop');

    if (p.liked) {
      sfx.pop();
      burstFrom(btn, [R.moodOf(p.mood).line, '#FFC93C', '#FF4D3D', '#35A17C'], 10);
    }

    req('POST', '/posts/' + id + '/like', {}).then(function (d) {
      p.liked = d.liked;
      p.likes = d.likes;
      btn.classList.toggle('is-on', d.liked);
      btn.querySelector('b').textContent = d.likes;
    }).catch(function (e) {
      p.liked = wasLiked;
      p.likes += wasLiked ? 1 : -1;
      btn.classList.toggle('is-on', wasLiked);
      btn.querySelector('b').textContent = p.likes;
      toast(e.message || '操作失败');
    });
  }

  function removePost(id) {
    var idx = state.posts.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return;
    req('DELETE', '/posts/' + id).then(function () {
      state.posts.splice(idx, 1);
      renderWall();
      sfx.rip();
      toast('删掉了');
    }).catch(function (e) { toast(e.message || '删不掉'); });
  }

  /* ---------------- 启动 ---------------- */

  function refreshTimes() {
    var nodes = $$('.note__time');
    nodes.forEach(function (el, i) {
      if (state.posts[i]) el.textContent = R.relTime(state.posts[i].created_at);
    });
  }

  function init() {
    var nn = $('#nickName'); if (nn) nn.textContent = nickname;
    var yr = $('#year'); if (yr) yr.textContent = new Date().getFullYear();
    renderMoods();
    renderTags();
    renderFilters();
    rotatePlaceholder();
    updateCounter();
    renderWall();
    renderStats();
    bind();

    setInterval(rotatePlaceholder, 7000);
    setInterval(refreshTimes, 60000);
    setInterval(function () {
      if (document.hidden) return;
      req('POST', '/ping', {}).then(function (d) {
        state.stats = d.stats;
        renderStats();
      }).catch(function () {});
    }, 45000);

    // 有新内容时自动更新（有筛选条件时不打扰）
    setInterval(function () {
      if (PAGE !== 'home') return;
      if (document.hidden || ui.q || ui.onlyMine || ui.moodFilter !== 'all') return;
      loadFeed(true);
    }, 30000);

    if (PAGE === 'home') {
      setTimeout(function () { toast('欢迎光临 🙌 本店不收钱，只收坏情绪。'); }, 900);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
