// 所有请求都走同一个云函数，按 action 分发
function call(action, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'api',
      data: Object.assign({ action }, data || {}),
      success(res) {
        const r = res.result || {}
        if (r.ok) resolve(r.data)
        else reject(new Error(r.error || '出了点问题'))
      },
      fail(err) {
        console.error('[cloud call fail]', err)
        reject(new Error('连不上服务器，检查一下云函数是否已部署'))
      }
    })
  })
}

function nickname() {
  return wx.getStorageSync('tucao.nickname') || '匿名'
}

module.exports = {
  feed(opts) {
    return call('feed', {
      mood: (opts && opts.mood) || 'all',
      sort: (opts && opts.sort) || 'new',
      onlyMine: !!(opts && opts.onlyMine),
      limit: (opts && opts.limit) || 30,
      skip: (opts && opts.skip) || 0
    })
  },
  create(text, mood, tags) {
    return call('create', { text, mood, tags, nickname: nickname() })
  },
  like(postId) {
    return call('like', { postId })
  },
  reply(postId, text) {
    return call('reply', { postId, text, nickname: nickname() })
  },
  report(postId, reason) {
    return call('report', { postId, reason })
  },
  shred(chars) {
    return call('shred', { chars })
  },
  remove(postId) {
    return call('remove', { postId })
  },
  stats() {
    return call('stats')
  },
  detail(postId) {
    return call('detail', { postId })
  },
  nickname
}
