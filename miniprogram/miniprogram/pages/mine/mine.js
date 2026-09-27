const api = require('../../utils/api.js')
const { decorate } = require('../../utils/moods.js')

Page({
  data: {
    nickname: '',
    posts: [],
    stats: { posts: 0, postsToday: 0, shreds: 0, likes: 0, replies: 0 },
    myLikes: 0,
    loading: true
  },

  onShow() {
    const app = getApp()
    this.setData({ nickname: app.globalData.nickname })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return Promise.all([api.feed({ onlyMine: true, limit: 50 }), api.stats()])
      .then(([mine, stats]) => {
        const posts = (mine.posts || []).map(decorate)
        this.setData({
          posts,
          stats: stats || this.data.stats,
          myLikes: posts.reduce((s, p) => s + (p.likes || 0), 0),
          loading: false
        })
      })
      .catch(err => {
        this.setData({ loading: false })
        wx.showToast({ title: err.message, icon: 'none' })
      })
  },

  rollNickname() {
    const app = getApp()
    const next = app.randomNickname()
    app.globalData.nickname = next
    wx.setStorageSync('tucao.nickname', next)
    this.setData({ nickname: next })
    wx.showToast({ title: '换了新身份', icon: 'none' })
  },

  tapPost(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  },

  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这条？',
      content: '删了就找不回来了。',
      success: res => {
        if (!res.confirm) return
        api.remove(id).then(() => {
          const app = getApp()
          app.globalData.needRefresh = true
          this.load()
          wx.showToast({ title: '删掉了', icon: 'success' })
        }).catch(err => wx.showToast({ title: err.message, icon: 'none' }))
      }
    })
  },

  goWrite() {
    wx.switchTab({ url: '/pages/write/write' })
  }
})
