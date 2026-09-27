const api = require('../../utils/api.js')
const { MOODS, TAGS } = require('../../utils/moods.js')

const INSPIRATION = [
  '开会两小时，结论是「下次再议」。',
  '外卖迟到四十分钟，汤洒了半碗。',
  '我妈第 108 次问我什么时候结婚。',
  '熬夜到两点，为了一个其实不重要的东西。',
  '微信里 800 个人，找不到一个现在能打电话的。',
  '计划写了三页，执行了十分钟。',
  '开完会，想不起来会上说了什么。',
  '朋友圈里所有人都在旅游，只有我在改 PPT。',
  '明明什么都没干，但就是很累。',
  '群里 @ 全体成员，结果是通知周末加班。',
  '想说的话打了一半，又删掉了。',
  '排队二十分钟，轮到我时刚好卖完。'
]

const MAX_LEN = 300
const MAX_TAGS = 3

Page({
  data: {
    moods: MOODS,
    tags: TAGS,
    mood: 'angry',
    picked: [],
    text: '',
    nickname: '',
    placeholder: INSPIRATION[0],
    len: 0,
    maxLen: MAX_LEN,
    showShred: false,
    shredDone: false,
    shredChars: 0,
    shredText: '',
    submitting: false,
    history: []
  },

  onLoad() {
    const app = getApp()
    this.setData({ nickname: app.globalData.nickname })
    this.rollPlaceholder()
  },

  onShow() {
    this.timer = setInterval(() => {
      if (!this.data.text) this.rollPlaceholder()
    }, 7000)
  },

  onHide() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  onUnload() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  rollPlaceholder() {
    let i = Math.floor(Math.random() * INSPIRATION.length)
    if (INSPIRATION[i] === this.data.placeholder) i = (i + 1) % INSPIRATION.length
    this.setData({ placeholder: INSPIRATION[i] })
  },

  pickMood(e) {
    this.setData({ mood: e.currentTarget.dataset.id })
    wx.vibrateShort({ type: 'light' })
  },

  toggleTag(e) {
    const t = e.currentTarget.dataset.tag
    const picked = this.data.picked.slice()
    const i = picked.indexOf(t)
    if (i > -1) picked.splice(i, 1)
    else {
      if (picked.length >= MAX_TAGS) {
        wx.showToast({ title: '最多贴 3 个标签', icon: 'none' })
        return
      }
      picked.push(t)
    }
    this.setData({ picked })
  },

  onInput(e) {
    this.setData({ text: e.detail.value, len: e.detail.value.length })
  },

  rollNickname() {
    const app = getApp()
    let next = app.randomNickname()
    let guard = 0
    while (next === this.data.nickname && guard++ < 10) next = app.randomNickname()
    app.globalData.nickname = next
    wx.setStorageSync('tucao.nickname', next)
    this.setData({ nickname: next })
    wx.vibrateShort({ type: 'light' })
  },

  publish() {
    const text = (this.data.text || '').trim()
    if (!text) return this.nudge('写点什么吧，哪怕一个字')
    if (this.data.submitting) return
    this.setData({ submitting: true })
    wx.showLoading({ title: '贴上墙…', mask: true })
    api.create(text, this.data.mood, this.data.picked).then(() => {
      wx.hideLoading()
      this.setData({ submitting: false, text: '', len: 0, picked: [] })
      const app = getApp()
      app.globalData.needRefresh = true
      wx.showToast({ title: '已经贴到墙上了', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/wall/wall' }), 900)
    }).catch(err => {
      wx.hideLoading()
      this.setData({ submitting: false })
      wx.showModal({ title: '没发出去', content: err.message, showCancel: false })
    })
  },

  nudge(msg) {
    wx.showToast({ title: msg, icon: 'none' })
    wx.vibrateShort({ type: 'heavy' })
  },

  // ---- 碎掉它 ----
  openShred() {
    const text = (this.data.text || '').trim()
    if (!text) return this.nudge('还没写呢，先写一句再碎')
    this.setData({ showShred: true, shredDone: false, shredChars: text.length, shredText: text })
  },

  cancelShred() {
    this.setData({ showShred: false, shredDone: false })
  },

  doShred() {
    const chars = this.data.shredChars
    this.setData({ shredDone: true })
    wx.vibrateShort({ type: 'heavy' })
    // 只把「碎掉了几个字」发出去，内容一个字都不上传
    api.shred(chars).catch(() => {})
    setTimeout(() => {
      this.setData({ text: '', len: 0 })
    }, 300)
  },

  closeShred() {
    this.setData({ showShred: false, shredDone: false })
  },

  goWall() {
    this.setData({ showShred: false, shredDone: false })
    const app = getApp()
    app.globalData.needRefresh = true
    wx.switchTab({ url: '/pages/wall/wall' })
  }
})
