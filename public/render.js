/* ============================================================
   吐槽铺 · 共用的渲染逻辑
   服务端（Node 渲染给搜索引擎看）和浏览器（互动）用的是同一份代码，
   所以两边永远一致。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TucaoRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MOODS = [
    { id: 'angry',   label: '暴躁',   emoji: '😤', line: '#E8452F', note: '#FFE0D6', ink: '#7A2416' },
    { id: 'wronged', label: '委屈',   emoji: '🥺', line: '#3F7BE0', note: '#DDE9FF', ink: '#17356B' },
    { id: 'meh',     label: '无语',   emoji: '😐', line: '#6B7280', note: '#E9ECF0', ink: '#31373F' },
    { id: 'melt',    label: '崩溃',   emoji: '🤯', line: '#9B57E0', note: '#EDE0FF', ink: '#46216E' },
    { id: 'numb',    label: '麻木',   emoji: '😪', line: '#2F9C77', note: '#D9F2E7', ink: '#14513B' },
    { id: 'warm',    label: '小确幸', emoji: '🥰', line: '#E0A000', note: '#FFF1C2', ink: '#6B4A00' }
  ];

  var TAGS = ['工作', '学习', '家人', '恋爱', '朋友', '生活', '网上冲浪', '自己'];

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; }); }

  function moodOf(id) {
    for (var i = 0; i < MOODS.length; i++) if (MOODS[i].id === id) return MOODS[i];
    return MOODS[0];
  }

  function hash(str) {
    var h = 2166136261;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  function relTime(ts, now) {
    now = now || Date.now();
    var diff = now - ts;
    if (diff < 0) diff = 0;
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    var mo = Math.floor(d / 30);
    if (mo < 12) return mo + ' 个月前';
    return Math.floor(mo / 12) + ' 年前';
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function num(n) {
    n = Number(n) || 0;
    if (n < 10000) return String(n);
    return (n / 10000).toFixed(n < 100000 ? 1 : 0).replace(/\.0$/, '') + ' 万';
  }

  /**
   * 渲染一张便利贴的内容（不含外层 <article>）。
   * opts: { expanded:Boolean, replyOpen:Boolean, mine:Boolean }
   */
  function noteHTML(p, opts) {
    opts = opts || {};
    var m = moodOf(p.mood);
    var mine = !!opts.mine;
    var replies = p.replies || [];

    var tagsHtml = (p.tags && p.tags.length)
      ? '<div class="note__tags">' + p.tags.map(function (t) {
          return '<button class="note__tag" type="button" data-tag="' + esc(t) + '">#' + esc(t) + '</button>';
        }).join('') + '</div>'
      : '';

    var shown = opts.expanded ? replies : replies.slice(0, 2);
    var repliesHtml = '';
    if (replies.length) {
      repliesHtml += '<div class="note__replies">' + shown.map(function (r) {
        return '<div class="reply"><div class="reply__meta"><span>' + esc(r.nickname) + '</span><span>' +
          esc(relTime(r.created_at != null ? r.created_at : r.createdAt)) + '</span></div>' + esc(r.text) + '</div>';
      }).join('');
      if (!opts.expanded && replies.length > 2) {
        repliesHtml += '<button class="more-replies" type="button" data-more="' + esc(p.id) + '">查看另外 ' +
          (replies.length - 2) + ' 条 👀</button>';
      }
      repliesHtml += '</div>';
    }

    var formHtml = opts.replyOpen
      ? '<form class="reply-form" data-reply="' + esc(p.id) + '">' +
        '<input type="text" maxlength="120" placeholder="接一句……" aria-label="回复这条吐槽">' +
        '<button type="submit">发</button></form>'
      : '';

    var toolsHtml =
      '<span class="note__tools">' +
        '<button class="note__tool" type="button" data-share="' + esc(p.id) + '" title="复制这条的链接" aria-label="复制这条的链接">🔗</button>' +
        (mine
          ? '<button class="note__tool" type="button" data-del="' + esc(p.id) + '" title="删掉这条" aria-label="删掉这条">✕</button>'
          : '<button class="note__tool" type="button" data-report="' + esc(p.id) + '" title="举报这条" aria-label="举报这条">🚩</button>') +
      '</span>';

    return toolsHtml +
      '<span class="note__pin" aria-hidden="true"></span>' +
      (p.pinned ? '<span class="note__pinned">置顶</span>' : '') +
      '<div class="note__head">' +
        '<span class="note__mood">' + m.emoji + ' ' + esc(m.label) + '</span>' +
        '<span class="note__time">' + esc(relTime(p.created_at != null ? p.created_at : p.createdAt)) + '</span>' +
      '</div>' +
      (opts.hideText ? '' : '<p class="note__text">' + esc(p.text) + '</p>') +
      tagsHtml +
      '<div class="note__foot">' +
        '<span class="note__nick"><b>' + esc(p.nickname) + '</b>' +
          (mine ? '<span class="note__mine">我的</span>' : '') + '</span>' +
        '<span class="note__acts">' +
          '<button class="act act--like' + (p.liked ? ' is-on' : '') + '" type="button" data-like="' + esc(p.id) + '"' +
            ' aria-pressed="' + (p.liked ? 'true' : 'false') + '">🙋 同感 <b>' + (p.likes || 0) + '</b></button>' +
          '<button class="act" type="button" data-replybtn="' + esc(p.id) + '">💬 接一句</button>' +
        '</span>' +
      '</div>' +
      repliesHtml + formHtml;
  }

  /** 便利贴外层 <article> */
  function noteArticle(p, opts) {
    opts = opts || {};
    var m = moodOf(p.mood);
    var taped = hash(p.id) % 2 === 0;
    var rot = ((hash(p.id) % 45) / 10 - 2.2).toFixed(2);
    return '<article class="note' + (taped ? ' note--taped' : '') +
      (opts.fresh ? ' note--fresh' : '') + (opts.hideText ? ' note--bare' : '') + '"' +
      ' id="p-' + esc(p.id) + '"' +
      ' style="--m-line:' + m.line + ';--m-note:' + m.note + ';--m-ink:' + m.ink + ';--rot:' + rot + 'deg">' +
      noteHTML(p, opts) + '</article>';
  }

  /** 给搜索引擎看的纯文本摘要 */
  function plain(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    max = max || 80;
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  return {
    MOODS: MOODS,
    TAGS: TAGS,
    esc: esc,
    moodOf: moodOf,
    hash: hash,
    relTime: relTime,
    fmtDate: fmtDate,
    num: num,
    noteHTML: noteHTML,
    noteArticle: noteArticle,
    plain: plain
  };
});
