/* ============================================================
   吐槽铺 · 云函数
   一个函数搞定全部接口，用 action 分发。
   数据存在云开发数据库里，不需要服务器、不需要备案域名。
   ============================================================ */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MOOD_IDS = ['angry', 'wronged', 'meh', 'melt', 'numb', 'warm']
const TAGS = ['工作', '学习', '家人', '恋爱', '朋友', '生活', '网上冲浪', '自己']
const MAX_POST_LEN = 300
const MAX_REPLY_LEN = 120

// 广告 / 垃圾信息识别（不针对脏话，吐槽就该骂）
const SPAM = [
  { re: /(?:\+?86[-\s]?)?1[3-9]\d{9}/, why: '手机号' },
  { re: /(?:微信|WeChat|weixin|vx|VX|wx|QQ|qq|扣扣)\s*[:：号]?\s*[A-Za-z0-9_\-]{5,}/, why: '联系方式' },
  { re: /(?:https?:\/\/|www\.)[^\s]+/i, why: '网址' },
  { re: /(加群|代购|刷单|返利|兼职刷|日结|博彩|赌场|棋牌|色情|代开|发票|办证|贷款|加微)/, why: '广告词' }
]

const COLLECTIONS = ['posts', 'shreds', 'reports']

function clean(str, max) {
  return String(str == null ? '' : str)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function moderate(text) {
  for (const p of SPAM) if (p.re.test(text)) return { bad: true, why: p.why }
  return { bad: false }
}

/** 微信官方内容安全检测（拿不到结果时按通过处理，不阻断用户） */
async function secCheck(content, openid) {
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content,
      version: 2,
      scene: 2,
      openid: openid
    })
    if (res && res.result && res.result.suggest && res.result.suggest !== 'pass') {
      return { bad: true, why: '内容安全检测：' + res.result.suggest }
    }
  } catch (e) {
    console.log('[secCheck skipped]', e.errCode || e.message)
  }
  return { bad: false }
}

/** 集合不存在时自动建（首次部署不用手动建表） */
async function ensureCollections() {
  for (const name of COLLECTIONS) {
    try { await db.createCollection(name) } catch (e) { /* 已存在会报错，忽略 */ }
  }
}

async function seedWelcome() {
  const c = await db.collection('posts').count()
  if (c.total > 0) return
  await db.collection('posts').add({
    data: {
      text: '欢迎来到吐槽铺。\n\n写下令你不爽的那件事，然后选一个：贴到墙上，让路过的人一起点头；或者直接碎掉它，当没发生过。\n\n这里不用注册、没有算法、没有热搜，只有一堆真实的人和一肚子没好意思说的话。',
      mood: 'warm',
      tags: ['生活'],
      nickname: '站长',
      openid: 'system',
      likes: 0,
      likedBy: [],
      replies: [],
      hidden: false,
      pending: false,
      createdAt: Date.now()
    }
  })
}

function publicPost(doc, openid) {
  return {
    _id: doc._id,
    text: doc.text,
    mood: doc.mood,
    tags: doc.tags || [],
    nickname: doc.nickname,
    likes: doc.likes || 0,
    liked: (doc.likedBy || []).indexOf(openid) > -1,
    mine: doc.openid === openid,
    replies: (doc.replies || []).map(r => ({ _id: r.id, text: r.text, nickname: r.nickname, createdAt: r.createdAt })),
    createdAt: doc.createdAt
  }
}

async function stats() {
  const [posts, shreds] = await Promise.all([
    db.collection('posts').where({ hidden: false, pending: false }).count(),
    db.collection('shreds').count()
  ])
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [todayPosts, likesAgg] = await Promise.all([
    db.collection('posts').where({ hidden: false, pending: false, createdAt: _.gte(today.getTime()) }).count(),
    db.collection('posts').aggregate().group({ _id: null, total: { $sum: '$likes' } }).end().catch(() => ({ list: [] }))
  ])
  const likes = (likesAgg.list && likesAgg.list[0] && likesAgg.list[0].total) || 0
  return {
    posts: posts.total,
    postsToday: todayPosts.total,
    shreds: shreds.total,
    likes: likes
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action

  try {
    await ensureCollections()
    await seedWelcome()

    switch (action) {
      /* ---------- 吐槽墙 ---------- */
      case 'feed': {
        const mood = event.mood || 'all'
        const limit = Math.min(Math.max(parseInt(event.limit, 10) || 20, 1), 50)
        const skip = Math.max(parseInt(event.skip, 10) || 0, 0)

        const where = { hidden: false }
        if (mood !== 'all') where.mood = mood
        if (event.onlyMine) where.openid = OPENID
        else where.pending = false

        if (event.sort === 'hot') {
          // 云数据库不能按「同感+回复」排序，取最近的若干条在内存里排
          const res = await db.collection('posts').where(where)
            .orderBy('createdAt', 'desc').limit(200).get()
          const list = res.data
            .map(d => publicPost(d, OPENID))
            .sort((a, b) => (b.likes + b.replies.length * 3) - (a.likes + a.replies.length * 3))
            .slice(skip, skip + limit)
          return { ok: true, data: { posts: list, stats: await stats() } }
        }

        const res = await db.collection('posts').where(where)
          .orderBy('createdAt', 'desc').skip(skip).limit(limit).get()
        return { ok: true, data: { posts: res.data.map(d => publicPost(d, OPENID)), stats: await stats() } }
      }

      /* ---------- 单条详情 ---------- */
      case 'detail': {
        const res = await db.collection('posts').doc(event.postId).get()
        const doc = res.data
        if (!doc || doc.hidden) throw new Error('这条已经不在了')
        return { ok: true, data: { post: publicPost(doc, OPENID) } }
      }

      /* ---------- 发一条 ---------- */
      case 'create': {
        const text = clean(event.text, MAX_POST_LEN)
        if (!text) throw new Error('写点什么吧，哪怕一个字')

        // 一人一小时最多 5 条
        const hourAgo = Date.now() - 3600 * 1000
        const recent = await db.collection('posts')
          .where({ openid: OPENID, createdAt: _.gte(hourAgo) }).count()
        if (recent.total >= 5) throw new Error('一小时最多发 5 条，缓一缓再来')

        const mine = moderate(text)
        const wxCheck = mine.bad ? { bad: true } : await secCheck(text, OPENID)
        const bad = mine.bad || wxCheck.bad

        const data = {
          text,
          mood: MOOD_IDS.indexOf(event.mood) > -1 ? event.mood : 'angry',
          tags: (event.tags || []).filter(t => TAGS.indexOf(t) > -1).slice(0, 3),
          nickname: clean(event.nickname, 20) || '匿名',
          openid: OPENID,
          likes: 0,
          likedBy: [],
          replies: [],
          hidden: false,
          pending: bad,
          createdAt: Date.now()
        }
        const added = await db.collection('posts').add({ data })

        if (bad) {
          return { ok: true, data: { pending: true, reason: mine.why || '内容安全检测', _id: added._id } }
        }
        return { ok: true, data: { pending: false, post: publicPost(Object.assign({ _id: added._id }, data), OPENID) } }
      }

      /* ---------- 同感 ---------- */
      case 'like': {
        const res = await db.collection('posts').doc(event.postId).get()
        const doc = res.data
        if (!doc || doc.hidden) throw new Error('这条已经不在了')
        const liked = (doc.likedBy || []).indexOf(OPENID) > -1
        await db.collection('posts').doc(event.postId).update({
          data: liked
            ? { likedBy: _.pull(OPENID), likes: _.inc(-1) }
            : { likedBy: _.addToSet(OPENID), likes: _.inc(1) }
        })
        return { ok: true, data: { liked: !liked, likes: Math.max(0, (doc.likes || 0) + (liked ? -1 : 1)) } }
      }

      /* ---------- 接一句 ---------- */
      case 'reply': {
        const text = clean(event.text, MAX_REPLY_LEN)
        if (!text) throw new Error('写点什么吧')
        if (moderate(text).bad) throw new Error('这句话里好像有联系方式或广告，发不出去')

        const hourAgo = Date.now() - 3600 * 1000
        const res = await db.collection('posts').doc(event.postId).get()
        if (!res.data || res.data.hidden) throw new Error('这条已经不在了')
        const mineReplies = await db.collection('posts').where({
          openid: OPENID,
          'replies.createdAt': _.gte(hourAgo)
        }).count().catch(() => ({ total: 0 }))
        if (mineReplies.total >= 20) throw new Error('一小时最多接 20 句')

        const reply = {
          id: uid(),
          text,
          nickname: clean(event.nickname, 20) || '匿名',
          openid: OPENID,
          createdAt: Date.now()
        }
        await db.collection('posts').doc(event.postId).update({ data: { replies: _.push([reply]) } })
        return { ok: true, data: { reply } }
      }

      /* ---------- 举报 ---------- */
      case 'report': {
        await db.collection('reports').add({
          data: {
            postId: event.postId,
            reason: clean(event.reason, 100) || '未填写原因',
            openid: OPENID,
            handled: false,
            createdAt: Date.now()
          }
        })
        return { ok: true, data: { reported: true } }
      }

      /* ---------- 碎掉它（只记字数，不存内容） ---------- */
      case 'shred': {
        const chars = Math.min(Math.max(parseInt(event.chars, 10) || 0, 0), 5000)
        await db.collection('shreds').add({
          data: { openid: OPENID, chars, createdAt: Date.now() }
        })
        return { ok: true, data: { stats: await stats() } }
      }

      /* ---------- 删掉自己的 ---------- */
      case 'remove': {
        const res = await db.collection('posts').doc(event.postId).get()
        if (!res.data) throw new Error('已经删掉了')
        if (res.data.openid !== OPENID) throw new Error('只能删自己发的')
        await db.collection('posts').doc(event.postId).remove()
        return { ok: true, data: { removed: true } }
      }

      /* ---------- 全站数据 ---------- */
      case 'stats':
        return { ok: true, data: await stats() }

      default:
        return { ok: false, error: '未知操作：' + action }
    }
  } catch (err) {
    console.error('[api error]', action, err)
    return { ok: false, error: (err && err.message) || '服务器出了点问题' }
  }
}
