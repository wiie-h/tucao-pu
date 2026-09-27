App({
  globalData: {
    nickname: ''
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请把微信开发者工具的基础库调到 2.2.3 以上再运行。',
        showCancel: false
      })
      return
    }
    wx.cloud.init({
      // 用当前环境，不用手填环境 ID
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: true
    })

    // 匿名昵称只存在本机
    let nick = wx.getStorageSync('tucao.nickname')
    if (!nick) {
      nick = this.randomNickname()
      wx.setStorageSync('tucao.nickname', nick)
    }
    this.globalData.nickname = nick
  },

  randomNickname() {
    const adj = ['暴躁', '委屈', '无语', '摆烂', '熬夜', '内耗', '社恐', '摸鱼', '佛系', '干饭',
      '清醒', '沉默', '秃头', '起不来床', 'emo', '硬撑', '嘴硬', '打工', 'emo到', '快要离职']
    const noun = ['锅包肉', '小笼包', '咸鱼', '柠檬精', '卷心菜', '打工人', '土豆', '奶茶',
      '火鸡面', '煎饼', '猕猴桃', '柚子', '椰子', '蛋挞', '榴莲', '猪大肠', '小面包', '云吞', '西柚', '咖啡']
    return adj[Math.floor(Math.random() * adj.length)] + '的' + noun[Math.floor(Math.random() * noun.length)]
  }
})
