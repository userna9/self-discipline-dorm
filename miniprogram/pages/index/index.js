// pages/index/index.js
const app = getApp()
const db = wx.cloud.database()
const { isTempFile, uploadAvatar } = require('../../utils/upload.js')
const { toDisplayUrl, checkUrls, isPermanentUrl } = require('../../utils/oss.js')
const { isConfigured, isAlwaysAllowed, requestMealSubscribe } = require('../../utils/subscribe.js')
const { dormToday, formatDate, nightMinutes } = require('../../utils/dorm.js')

const MEAL_OPTIONS = ['不知道', '泡面', '已经点了外卖', '南门', '食堂']

Page({
  data: {
    greeting: '',
    todayDate: '',
    checkedInCount: 0, // 今晚登记了预计回寝时间的人数
    arrivedCount: 0, // 其中已经点了「我到宿舍了」的人数
    totalMembers: 6,
    lotteryCount: 0,
    isCheckedInToday: false,
    hasLotteryToday: false,
    userInfo: null,
    avatarUrl: '',
    nickname: '',
    showProfileModal: false,
    keyboardUp: false, // 键盘是否弹起（弹起时把弹窗上移，避免被顶出屏幕）
    nicknameInitial: '', // 打开弹窗时的昵称，只用于初始化输入框
    latestLottery: null,
    latestCheckin: null,
    // 吃饭询问
    showMealModal: false,
    mealTab: '中午', // 中午 | 下午
    mealCardDesc: '发起「中午/下午吃什么」全宿舍询问',
    mealAskLunch: null, // 中午询问展示数据
    mealAskDinner: null, // 下午询问展示数据
    // 订阅消息
    subReady: isConfigured(), // 是否已配置模板
    subQuota: 0, // 我还剩几次可被提醒
  },

  onLoad(query) {
    // 从分享卡片进来时，自动打开吃饭询问
    this.autoOpenMeal = !!(query && query.openMeal === '1')
    // 数据在 onShow 里加载（onLoad 之后一定会触发 onShow，这里再加载会重复请求）
  },

  onShow() {
    // 每次显示都重算日期：小程序可能从昨晚一直挂到今天
    this.refreshGreeting()
    // loadUserInfo 内部会加载今日统计
    this.loadUserInfo()
    // 刷新"是否勾了总是保持"的缓存，供静默补额度使用
    this.refreshSubSetting()
  },

  // 静默补额度：用户勾了「总是保持以上选择」后，每次点击都能不弹窗地 +1 次
  async refreshSubSetting() {
    this.subAlwaysAllow = await isAlwaysAllowed()
  },

  /**
   * 在用户点击事件里顺手补一次额度（不弹窗、不打扰）
   * 必须在 tap 回调里同步调用 wx.requestSubscribeMessage，所以这里不加 await
   */
  silentTopUpSubscribe() {
    if (!isConfigured() || !this.subAlwaysAllow) return
    const now = Date.now()
    if (this._lastTopUpAt && now - this._lastTopUpAt < 5000) return
    this._lastTopUpAt = now
    requestMealSubscribe()
      .then((r) => {
        if (r.ok) this.setData({ subQuota: r.quota })
      })
      .catch(() => {})
  },

  onPullDownRefresh() {
    this.loadTodayStats().then(() => wx.stopPullDownRefresh())
  },

  refreshGreeting() {
    const hour = new Date().getHours()
    let greeting = '晚上好'
    if (hour < 6) greeting = '夜深了'
    else if (hour < 11) greeting = '早上好'
    else if (hour < 14) greeting = '中午好'
    else if (hour < 18) greeting = '下午好'
    else if (hour < 22) greeting = '晚上好'
    else greeting = '夜深了'

    // 按「宿舍日」算：凌晨 5 点前仍是前一天的晚上
    const today = dormToday()
    const dateStr = `${today.getMonth() + 1}月${today.getDate()}日`
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()]
    const todayDate = formatDate(today)

    this.setData({
      greeting,
      dateStr: `${dateStr} ${weekday}`,
      todayDate,
    })
  },

  async loadUserInfo() {
    try {
      let openid = app.globalData.openid
      if (!openid) {
        const openidRes = await wx.cloud.callFunction({ name: 'getOpenId' })
        openid = openidRes.result.openid
        app.globalData.openid = openid
      }

      const userRes = await db.collection('users').where({ _openid: openid }).get()

      if (userRes.data && userRes.data.length > 0) {
        const u = userRes.data[0]
        // 排查用：如果这里不是 https://xxx.aliyuncs.com/... 说明库里存的是临时路径或旧的 cloud://
        console.log('[首页] 数据库里的头像地址：', u.avatarUrl)
        if (this.data.showProfileModal) {
          // 正在编辑资料：只更新 userInfo，不能覆盖用户刚选的本地头像和正在输入的昵称。
          // 相册选择器在部分机型上会让小程序短暂 onHide/onShow，这里不挡就会被旧值冲掉。
          this.setData({ userInfo: u, subQuota: u.subQuota || 0 })
        } else {
          this.setData({
            userInfo: u,
            nickname: u.nickname,
            // 旧 cloud:// / 临时路径显示占位图（重新保存头像即可修复）
            avatarUrl: toDisplayUrl(u.avatarUrl),
            showProfileModal: false,
            subQuota: u.subQuota || 0,
          })
        }
      } else {
        // 首次使用，引导设置昵称
        this.setData({
          showProfileModal: true,
          nickname: '',
          nicknameInitial: '',
          avatarUrl: '',
        })
      }

      // 加载今日统计
      await this.loadTodayStats()

      // 从分享卡片进来的，统计拉完再自动打开吃饭询问
      if (this.autoOpenMeal && this.data.userInfo) {
        this.autoOpenMeal = false
        this.setData({ showMealModal: true })
      }
    } catch (e) {
      console.error('loadUserInfo error', e)
    }
  },

  async loadTodayStats() {
    const { todayDate } = this.data
    if (!todayDate) return

    try {
      // 今日打卡人数
      const checkinRes = await db.collection('checkins').where({ date: todayDate }).get()
      const checkins = checkinRes.data || []
      const openid = app.globalData.openid
      const isCheckedInToday = checkins.some(c => c._openid === openid)

      // 今日抽签人数
      const lotteryRes = await db.collection('lottery').where({ date: todayDate }).get()
      const lottery = lotteryRes.data || []
      const hasLotteryToday = lottery.some(l => l._openid === openid)

      // 找出最晚的预计回寝（00:40 要比 23:30 晚，用 nightMinutes 比较）
      const latestCheckin = checkins.length > 0
        ? checkins.reduce((a, b) => (nightMinutes(a.hour, a.minute) > nightMinutes(b.hour, b.minute) ? a : b))
        : null
      const arrivedCount = checkins.filter(c => c.arrivedAt).length

      // 计算时间字符串
      let latestCheckinTimeText = ''
      if (latestCheckin) {
        const h = String(latestCheckin.hour).padStart(2, '0')
        const m = String(latestCheckin.minute).padStart(2, '0')
        latestCheckinTimeText = `${h}:${m}`
      }

      // 今日吃饭询问
      let mealAskLunch = null
      let mealAskDinner = null
      let mealCardDesc = '发起「中午/下午吃什么」全宿舍询问'
      try {
        const mealRes = await db.collection('mealAsks').where({ date: todayDate }).get()
        const mealAsks = mealRes.data || []
        const lunch = mealAsks.find(a => a.mealType === '中午')
        const dinner = mealAsks.find(a => a.mealType === '下午')
        mealAskLunch = lunch ? this.buildMealDisplay(lunch, openid) : null
        mealAskDinner = dinner ? this.buildMealDisplay(dinner, openid) : null
        const active = mealAskLunch || mealAskDinner
        if (active) {
          mealCardDesc = `${active.mealType}的询问进行中，${active.answerCount} 人已选`
        }
      } catch (e) {
        console.error('loadMealAsks error', e)
      }

      this.setData({
        checkedInCount: checkins.length,
        arrivedCount,
        lotteryCount: lottery.length,
        isCheckedInToday,
        hasLotteryToday,
        latestCheckin,
        latestCheckinTimeText,
        latestLottery: lottery.length > 0 ? lottery[lottery.length - 1] : null,
        mealAskLunch,
        mealAskDinner,
        mealCardDesc,
      })
    } catch (e) {
      console.error('loadTodayStats error', e)
    }
  },

  // 把 mealAsks 文档转成页面展示结构（选项聚合、谁选了什么）
  buildMealDisplay(ask, openid) {
    const answers = ask.answers || []
    const options = MEAL_OPTIONS.map(label => {
      const voters = answers.filter(a => a.choice === label)
      return {
        label,
        count: voters.length,
        votersText: voters.length > 0 ? voters.map(v => v.nickname).join('、') : '',
        isMine: voters.some(v => v.openid === openid),
      }
    })
    const mine = answers.find(a => a.openid === openid)
    return {
      id: ask._id,
      mealType: ask.mealType,
      creator: ask.nickname,
      options,
      myChoice: mine ? mine.choice : '',
      answerCount: answers.length,
    }
  },

  onChooseAvatar(e) {
    this.setData({
      avatarUrl: e.detail.avatarUrl,
    })
  },

  // 从相册/拍照选头像：chooseAvatar 面板在不同机型上表现不一致，这里给一个稳定入口
  async onPickAvatarFromAlbum() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
      })
      const file = (res.tempFiles || [])[0]
      if (file && file.tempFilePath) {
        this.setData({ avatarUrl: file.tempFilePath })
      } else {
        console.warn('chooseMedia 没有返回可用文件', res)
      }
    } catch (e) {
      // 用户取消会走到这里，属于正常情况；其他错误打出来方便排查
      console.warn('从相册选择头像失败', e)
    }
  },

  onNicknameInput(e) {
    this.setData({
      nickname: e.detail.value,
    })
  },

  // 打开资料弹窗（统一入口，保证输入框初始值正确、键盘态复位）
  openProfileModal() {
    this.setData({
      showProfileModal: true,
      keyboardUp: false,
      nicknameInitial: this.data.nickname || '',
    })
  },

  // 阻断事件冒泡用（配合 catchtap），必须存在真实方法，否则点弹窗内部会冒泡到遮罩把弹窗关掉
  noop() {},

  // 键盘弹起时把弹窗顶到上方，否则 position:fixed 的遮罩会被键盘推着跑出屏幕
  onNicknameFocus() {
    this.setData({ keyboardUp: true })
  },

  onNicknameBlur(e) {
    this.setData({ keyboardUp: false })
    if (e && e.detail) this.setData({ nickname: e.detail.value })
  },

  async onSaveProfile() {
    const { nickname, avatarUrl } = this.data
    if (!nickname || !nickname.trim()) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    if (!avatarUrl) {
      wx.showToast({ title: '请选择头像', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...', mask: true })
    try {
      // 1. 确保拿到 openid（上传文件名要用）
      let openid = app.globalData.openid
      if (!openid) {
        const openidRes = await wx.cloud.callFunction({ name: 'getOpenId' })
        openid = openidRes.result.openid
        app.globalData.openid = openid
      }

      // 2. 头像是本地临时文件时，先上传阿里云 OSS 换成永久地址
      let finalAvatar = avatarUrl
      if (isTempFile(avatarUrl)) {
        finalAvatar = await uploadAvatar(avatarUrl, openid)
      }
      console.log('[保存头像] 最终地址：', finalAvatar)

      // 3. 兜底：上传失败时不要把临时路径存进库
      if (!isPermanentUrl(finalAvatar)) {
        throw new Error('头像上传失败，请检查网络后重试')
      }

      // 4. 自检：确认别人也能访问（Bucket 非公共读会返回 403）
      const checked = await checkUrls([finalAvatar])
      if (checked.length && !checked[0].ok) {
        const st = checked[0].status
        throw new Error(
          st === 403
            ? '图片无法公开访问（403）：请到 OSS 控制台把 Bucket 读写权限改成「公共读」'
            : `图片无法访问（${st || checked[0].error}），请检查 OSS 配置`
        )
      }

      // 5. 写入数据库
      const res = await wx.cloud.callFunction({
        name: 'saveUserInfo',
        data: { nickname: nickname.trim(), avatarUrl: finalAvatar }
      })
      if (res.result.success) {
        wx.hideLoading()
        wx.showToast({ title: '设置成功' })
        this.setData({ showProfileModal: false, keyboardUp: false, avatarUrl: finalAvatar })
        this.loadUserInfo()
      } else {
        throw new Error(res.result.error || '保存失败')
      }
    } catch (e) {
      wx.hideLoading()
      console.error('save profile error', e)
      wx.showModal({
        title: '保存失败',
        content: e.message || '未知错误',
        showCancel: false,
      })
    }
  },

  // ===== 吃饭询问 =====

  openMealModal() {
    this.silentTopUpSubscribe()
    if (!this.data.userInfo) {
      this.openProfileModal()
      return
    }
    this.setData({ showMealModal: true })
  },

  closeMealModal() {
    this.setData({ showMealModal: false })
  },

  // 开启微信提醒（一次性订阅）：点一次 = 攒一次可被提醒的额度
  async onEnableRemind() {
    if (!isConfigured()) {
      wx.showModal({
        title: '还没配置订阅模板',
        content:
          '请先在小程序后台「功能 → 订阅消息 → 公共模板库 → 一次性订阅」申请模板，' +
          '然后把模板 ID 填到 miniprogram/utils/subscribe.js 和云函数 mealActions 里。',
        showCancel: false,
      })
      return
    }
    wx.showLoading({ title: '开启中...', mask: true })
    const r = await requestMealSubscribe()
    wx.hideLoading()
    if (r.ok) {
      this.setData({ subQuota: r.quota })
      // 用户可能刚勾了「总是保持以上选择」，刷新缓存，之后就能静默补额度了
      this.refreshSubSetting()
      wx.showToast({ title: `已开启，可提醒 ${r.quota} 次`, icon: 'none' })
    } else if (r.reason === 'reject') {
      wx.showToast({ title: '你拒绝了提醒授权', icon: 'none' })
    } else {
      wx.showToast({ title: '开启失败，请重试', icon: 'none' })
    }
  },

  // 转发到宿舍群：群里点卡片直接进入作答页
  onShareAppMessage() {
    const tab = this.data.mealTab || '中午'
    return {
      title: `🍚 ${tab}吃什么？进来选一下`,
      path: '/pages/index/index?openMeal=1',
    }
  },

  // 兜底：小程序未认证时微信会禁用转发，改为复制一段文字，粘贴到群里
  onCopyMealText() {
    const tab = this.data.mealTab || '中午'
    const text = `🍚 有人问${tab}吃什么，打开小程序「乱世诸雄」→ 首页 → 吃饭询问，选一下`
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，粘贴到群里即可', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    })
  },

  switchMealTab(e) {
    this.setData({ mealTab: e.currentTarget.dataset.tab })
  },

  // 发起询问（当天该餐次已有人发起时，云函数会直接返回现有的）
  async onCreateMealAsk() {
    this.silentTopUpSubscribe()
    const { mealTab, userInfo, todayDate } = this.data
    if (!userInfo) return
    wx.showLoading({ title: '发起中...' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'mealActions',
        data: {
          action: 'create',
          mealType: mealTab,
          date: todayDate,
          nickname: userInfo.nickname,
          avatarUrl: userInfo.avatarUrl,
        }
      })
      wx.hideLoading()
      if (res.result && res.result.success) {
        if (res.result.existed) {
          wx.showToast({ title: '已有询问，直接作答吧', icon: 'none' })
        } else {
          const subSent = (res.result.notify && res.result.notify.sent) || 0
          const wecomOk = !!(res.result.wecom && res.result.wecom.ok)
          let msg = '已发起，可转发到宿舍群'
          if (wecomOk) msg = '已发起，已推送到宿舍群'
          else if (subSent > 0) msg = `已发起，已通知 ${subSent} 人`
          wx.showToast({ title: msg, icon: 'none' })
        }
        this.loadTodayStats()
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '发起失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('create meal ask error', e)
      wx.showToast({ title: '发起失败', icon: 'none' })
    }
  },

  // 选择选项（再点同一个不处理，点别的可以改答案）
  async onChooseMealOption(e) {
    this.silentTopUpSubscribe()
    const choice = e.currentTarget.dataset.choice
    const ask = this.data.mealTab === '中午' ? this.data.mealAskLunch : this.data.mealAskDinner
    if (!ask || !choice) return

    if (ask.myChoice === choice) {
      wx.showToast({ title: '已选过这个啦', icon: 'none' })
      return
    }

    wx.showLoading({ title: '提交中...' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'mealActions',
        data: {
          action: 'answer',
          askId: ask.id,
          choice,
          nickname: this.data.userInfo.nickname,
          avatarUrl: this.data.userInfo.avatarUrl,
        }
      })
      wx.hideLoading()
      if (res.result && res.result.success) {
        this.loadTodayStats()
      } else {
        wx.showToast({ title: (res.result && res.result.error) || '提交失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('answer meal error', e)
      wx.showToast({ title: '提交失败', icon: 'none' })
    }
  },

  goToCourtyard() {
    wx.navigateTo({ url: '/pages/courtyard/courtyard' })
  },

  goToCheckin() {
    if (!this.data.userInfo) {
      this.openProfileModal()
      return
    }
    wx.switchTab({ url: '/pages/checkin/checkin' })
  },

  goToLottery() {
    if (!this.data.userInfo) {
      this.openProfileModal()
      return
    }
    wx.switchTab({ url: '/pages/lottery/lottery' })
  },

  goToMoments() {
    if (!this.data.userInfo) {
      this.openProfileModal()
      return
    }
    wx.switchTab({ url: '/pages/moments/moments' })
  },

  // 作业共享是普通页面（不在 tabBar 里），用 navigateTo
  goToHomework() {
    if (!this.data.userInfo) {
      this.openProfileModal()
      return
    }
    wx.navigateTo({ url: '/pages/homework/homework' })
  },

  goToProfile() {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  closeProfileModal() {
    if (this.data.userInfo) {
      // 取消时还原成已保存的值，避免页面上留着没保存的临时图
      this.setData({
        showProfileModal: false,
        keyboardUp: false,
        nickname: this.data.userInfo.nickname,
        avatarUrl: toDisplayUrl(this.data.userInfo.avatarUrl),
      })
    }
  },
})