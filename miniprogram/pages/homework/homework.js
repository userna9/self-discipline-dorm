// pages/homework/homework.js - 宿舍作业共享
const app = getApp()
const { uploadFile, toDisplayUrl } = require('../../utils/oss.js')

const db = wx.cloud.database()

const MAX_SIZE = 20 * 1024 * 1024 // 和 ossSign 的 MAX_SIZE 保持一致

// 扩展名 → [标签, 颜色]
const KIND_MAP = {
  pdf: ['PDF', '#c4574a'],
  doc: ['DOC', '#2f6b52'],
  docx: ['DOC', '#2f6b52'],
  xls: ['XLS', '#3f7a5a'],
  xlsx: ['XLS', '#3f7a5a'],
  csv: ['CSV', '#3f7a5a'],
  ppt: ['PPT', '#c4754a'],
  pptx: ['PPT', '#c4754a'],
  md: ['MD', '#4f6558'],
  txt: ['TXT', '#4f6558'],
  zip: ['ZIP', '#8aa095'],
  rar: ['RAR', '#8aa095'],
  '7z': ['7Z', '#8aa095'],
}
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp']
// wx.openDocument 支持的格式
const DOC_OPENABLE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf']
// 能直接读成文本预览的
const TEXT_EXT = ['md', 'txt', 'csv']

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function relTime(value) {
  if (!value) return ''
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(t)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

Page({
  data: {
    list: [],
    loading: true,
    needInit: false, // 集合还没建
    showUpload: false,
    uploading: false,
    titleInitial: '',
    picked: null, // { path, name, size, sizeText, ext }
    keyboardUp: false,
  },

  onLoad() {
    this.title = ''
    this.loadList()
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh())
  },

  async loadList() {
    try {
      const res = await db
        .collection('homeworks')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get()

      const list = (res.data || []).map((it) => {
        const ext = it.ext || extOf(it.fileName)
        const kind = KIND_MAP[ext] || ['文件', '#8aa095']
        const isImage = IMAGE_EXT.indexOf(ext) !== -1
        return {
          ...it,
          ext,
          isImage,
          kindLabel: isImage ? '图片' : kind[0],
          kindColor: kind[1],
          sizeText: sizeText(it.fileSize),
          timeText: relTime(it.createdAt),
          avatarUrl: toDisplayUrl(it.avatarUrl),
        }
      })

      this.setData({ list, loading: false })
    } catch (e) {
      console.error('load homework error', e)
      const msg = String((e && (e.errMsg || e.message)) || '')
      const notExist = (e && e.errCode === -502005) || /collection not exists/i.test(msg)
      this.setData({ loading: false, needInit: notExist })
      if (!notExist) wx.showToast({ title: '加载失败，下拉重试', icon: 'none' })
    }
  },

  // ============ 上传 ============

  openUpload() {
    this.title = ''
    this.setData({ showUpload: true, titleInitial: '', picked: null, uploading: false })
  },

  closeUpload() {
    this.setData({ showUpload: false, picked: null, uploading: false, keyboardUp: false })
  },

  noop() {},

  onTitleInput(e) {
    this.title = e.detail.value
  },

  onFocus() {
    this.setData({ keyboardUp: true })
  },

  onBlur(e) {
    this.setData({ keyboardUp: false })
    if (e && e.detail) this.title = e.detail.value
  },

  // 选图片（相册/拍照）
  async onPickImage() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['original'],
        sourceType: ['album', 'camera'],
      })
      const f = (res.tempFiles || [])[0]
      if (!f) return
      if (f.size > MAX_SIZE) {
        wx.showToast({ title: '图片超过 20MB', icon: 'none' })
        return
      }
      const ext = extOf(f.tempFilePath) || 'jpg'
      const name = `图片.${ext}`
      this.setData({
        picked: { path: f.tempFilePath, name, size: f.size, sizeText: sizeText(f.size), ext },
      })
    } catch (e) {
      // 用户取消
    }
  },

  // 选文件（从聊天记录里选 doc/pdf/ppt/md 等）
  async onPickFile() {
    try {
      const res = await wx.chooseMessageFile({ count: 1, type: 'file' })
      const f = (res.tempFiles || [])[0]
      if (!f) return
      if (f.size > MAX_SIZE) {
        wx.showToast({ title: '文件超过 20MB', icon: 'none' })
        return
      }
      this.setData({
        picked: {
          path: f.path,
          name: f.name,
          size: f.size,
          sizeText: sizeText(f.size),
          ext: extOf(f.name),
        },
      })
    } catch (e) {
      // 用户取消
    }
  },

  async onSubmit() {
    const title = (this.title || '').trim()
    const picked = this.data.picked

    if (!title) {
      wx.showToast({ title: '给作业起个名字吧', icon: 'none' })
      return
    }
    if (title.length > 30) {
      wx.showToast({ title: '名字最多 30 个字', icon: 'none' })
      return
    }
    if (!picked) {
      wx.showToast({ title: '先选一个文件', icon: 'none' })
      return
    }
    if (this.data.uploading) return

    this.setData({ uploading: true })
    wx.showLoading({ title: '上传中...', mask: true })

    try {
      let openid = app.globalData.openid
      if (!openid) {
        const r = await wx.cloud.callFunction({ name: 'getOpenId' })
        openid = r.result.openid
        app.globalData.openid = openid
      }

      // 上传者信息（取自己的 users 文档）
      let nickname = '室友'
      let avatarUrl = ''
      try {
        const u = await db.collection('users').where({ _openid: openid }).limit(1).get()
        if (u.data && u.data.length) {
          nickname = u.data[0].nickname || '室友'
          avatarUrl = u.data[0].avatarUrl || ''
        }
      } catch (e) {
        // 没设昵称也能上传，用默认名
      }

      const url = await uploadFile(picked.path, 'homework', openid, picked.name)

      await db.collection('homeworks').add({
        data: {
          title,
          fileName: picked.name,
          ext: picked.ext,
          fileSize: picked.size,
          fileUrl: url,
          nickname,
          avatarUrl,
          createdAt: new Date(),
        },
      })

      wx.hideLoading()
      this.title = ''
      this.setData({ uploading: false, showUpload: false, picked: null, titleInitial: '' })
      wx.showToast({ title: '已分享' })
      this.loadList()
    } catch (e) {
      wx.hideLoading()
      this.setData({ uploading: false })
      console.error('upload homework error', e)
      wx.showModal({
        title: '上传失败',
        content: (e && e.message) || '请重试',
        showCancel: false,
      })
    }
  },

  // ============ 打开 ============

  onOpenFile(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.list[index]
    if (!item) return

    if (item.isImage) {
      wx.previewImage({ current: item.fileUrl, urls: [item.fileUrl] })
      return
    }
    if (DOC_OPENABLE.indexOf(item.ext) !== -1) {
      this.openDocument(item)
      return
    }
    if (TEXT_EXT.indexOf(item.ext) !== -1) {
      this.previewText(item)
      return
    }
    // 压缩包之类：只能复制链接
    this.copyLink(item)
  },

  async openDocument(item) {
    wx.showLoading({ title: '打开中...', mask: true })
    try {
      const r = await wx.downloadFile({ url: item.fileUrl })
      if (r.statusCode !== 200) throw new Error('下载失败')
      wx.hideLoading()
      await wx.openDocument({ filePath: r.tempFilePath, fileType: item.ext, showMenu: true })
    } catch (e) {
      wx.hideLoading()
      console.error('open document error', e)
      wx.showModal({
        title: '打不开这个文件',
        content: '可以先复制链接，在电脑上打开。',
        confirmText: '复制链接',
        success: (s) => {
          if (s.confirm) this.copyLink(item)
        },
      })
    }
  },

  async previewText(item) {
    wx.showLoading({ title: '读取中...', mask: true })
    try {
      const r = await wx.downloadFile({ url: item.fileUrl })
      const text = wx.getFileSystemManager().readFileSync(r.tempFilePath, 'utf-8')
      wx.hideLoading()
      wx.showModal({
        title: item.title,
        content: text.slice(0, 600) + (text.length > 600 ? '\n\n…（内容较长，可复制链接在电脑查看）' : ''),
        showCancel: false,
        confirmText: '知道了',
      })
    } catch (e) {
      wx.hideLoading()
      this.copyLink(item)
    }
  },

  copyLink(item) {
    wx.setClipboardData({
      data: item.fileUrl,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' }),
    })
  },
})
