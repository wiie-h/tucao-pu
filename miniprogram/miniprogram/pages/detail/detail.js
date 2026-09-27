const api = require('../../utils/api.js')
const { decorate } = require('../../utils/moods.js')

const REASONS = ['骂人 / 攻击别人', '泄露了我的隐私', '广告或垃圾信息', '内容看不下去', '其他问题']

Page({
  data: {
    id: '',
    post: null,
    loading: true,
    replyText: '',
    sending: false
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },

  load() {
    this.setData({ loading: true })
    api.detail(this.data.id).then(res => {
      this.setData({ post: res.post ? decorate(res.post) : null, loading: false })
    }).catch(err => {
      this.setData({ loading: false })
      wx.showToast({ title: err.message, icon: 'none' })
    })
  },

  tapLike() {
    const p = this.data.post
    if (!p) return
    api.like(p._id).then(res => {
      this.setData({ 'post.liked': res.liked, 'post.likes': res.likes })
      wx.vibrateShort({ type: 'light' })
    }).catch(err => wx.showToast({ title: err.message, icon: 'none' }))
  },

  onReplyInput(e) {
    this.setData({ replyText: e.detail.value })
  },

  sendReply() {
    const text = (this.data.replyText || '').trim()
    if (!text) return wx.showToast({ title: '写点什么吧', icon: 'none' })
    if (this.data.sending) return
    this.setData({ sending: true })
    api.reply(this.data.id, text).then(() => {
      this.setData({ sending: false, replyText: '' })
      wx.showToast({ title: '接上了', icon: 'success' })
      this.load()
    }).catch(err => {
      this.setData({ sending: false })
      wx.showModal({ title: '没发出去', content: err.message, showCancel: false })
    })
  },

  report() {
    wx.showActionSheet({
      itemList: REASONS,
      success: res => {
        api.report(this.data.id, REASONS[res.tapIndex]).then(() => {
          wx.showToast({ title: '收到，站长会处理', icon: 'none' })
        }).catch(err => wx.showToast({ title: err.message, icon: 'none' }))
      }
    })
  },

  remove() {
    wx.showModal({
      title: '删掉这条？',
      content: '删了就找不回来了。',
      success: res => {
        if (!res.confirm) return
        api.remove(this.data.id).then(() => {
          const app = getApp()
          app.globalData.needRefresh = true
          wx.showToast({ title: '删掉了', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 700)
        }).catch(err => wx.showToast({ title: err.message, icon: 'none' }))
      }
    })
  },

  previewImage() {}
})
