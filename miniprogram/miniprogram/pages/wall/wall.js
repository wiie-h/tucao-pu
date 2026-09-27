const api = require('../../utils/api.js')
const { MOODS, decorate } = require('../../utils/moods.js')

Page({
  data: {
    moods: [{ id: 'all', label: '全部', emoji: '🗂' }].concat(MOODS),
    mood: 'all',
    sort: 'new',
    posts: [],
    stats: { online: 0, posts: 0, shreds: 0, postsToday: 0 },
    loading: true,
    hasMore: false,
    skip: 0,
    pageSize: 20
  },

  onLoad() {
    this.refresh()
  },

  onShow() {
    const app = getApp()
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false
      this.refresh()
    }
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadMore()
  },

  refresh() {
    this.setData({ loading: true, skip: 0 })
    return this.fetch(0, true)
  },

  loadMore() {
    this.setData({ loading: true })
    return this.fetch(this.data.posts.length, false)
  },

  fetch(skip, replace) {
    return api.feed({
      mood: this.data.mood,
      sort: this.data.sort,
      limit: this.data.pageSize,
      skip
    }).then(res => {
      const list = (res.posts || []).map(decorate)
      this.setData({
        posts: replace ? list : this.data.posts.concat(list),
        stats: res.stats || this.data.stats,
        hasMore: list.length >= this.data.pageSize,
        loading: false
      })
    }).catch(err => {
      this.setData({ loading: false })
      wx.showToast({ title: err.message, icon: 'none', duration: 2500 })
    })
  },

  pickMood(e) {
    this.setData({ mood: e.currentTarget.dataset.id })
    this.refresh()
  },

  pickSort(e) {
    const sort = e.currentTarget.dataset.sort
    if (sort === this.data.sort) return
    this.setData({ sort })
    this.refresh()
  },

  tapLike(e) {
    const id = e.currentTarget.dataset.id
    const posts = this.data.posts.map(p => {
      if (p._id !== id) return p
      const liked = !p.liked
      return Object.assign({}, p, { liked, likes: Math.max(0, p.likes + (liked ? 1 : -1)) })
    })
    this.setData({ posts })
    wx.vibrateShort({ type: 'light' })
    api.like(id).then(res => {
      const fixed = this.data.posts.map(p => (p._id === id ? Object.assign({}, p, { liked: res.liked, likes: res.likes }) : p))
      this.setData({ posts: fixed })
    }).catch(() => this.refresh())
  },

  tapPost(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  },

  goWrite() {
    wx.switchTab({ url: '/pages/write/write' })
  }
})
