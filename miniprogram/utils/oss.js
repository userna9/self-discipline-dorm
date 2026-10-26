// utils/oss.js - 阿里云 OSS 直传工具
//
// 流程：前端向云函数 ossSign 要一份「上传签名」→ 用 wx.uploadFile 直传 OSS
//      → 拿到 https 永久地址存进数据库。
// 好处：AccessKey 只在云函数里，小程序包里没有密钥；图片是公共读的 https 地址，
//      宿舍任何人都能直接看到，不再受云开发免费环境「仅创建者可读写」的限制。

const POLICY_CACHE = {}          // dir -> { data, fetchedAt }
const POLICY_TTL = 10 * 60 * 1000 // 本地缓存 10 分钟（服务端签发 15 分钟有效）

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  // 作业共享支持的文件类型
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
}

/** 取出文件扩展名（默认 jpg，仅用于图片上传） */
function extOf(filePath) {
  const m = /\.([a-z0-9]+)$/i.exec(filePath || '')
  const ext = m ? m[1].toLowerCase() : 'jpg'
  return MIME[ext] ? ext : 'jpg'
}

/** 取出原始扩展名，未知返回空串（用于文档上传，不能把 pdf 改成 jpg） */
function extOfName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

/** 向云函数要上传签名（带本地缓存，避免每次上传都调用云函数） */
async function getUploadParams(dir) {
  const cached = POLICY_CACHE[dir]
  if (cached && Date.now() - cached.fetchedAt < POLICY_TTL) {
    return cached.data
  }
  const res = await wx.cloud.callFunction({
    name: 'ossSign',
    data: { action: 'policy', dir },
  })
  const r = (res && res.result) || {}
  if (!r.success) {
    throw new Error(r.error || '获取上传签名失败，请检查 ossSign 云函数配置')
  }
  POLICY_CACHE[dir] = { data: r, fetchedAt: Date.now() }
  return r
}

/**
 * 读取图片尺寸（失败返回 null，不阻塞上传）
 */
function getImageSize(filePath) {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: filePath,
      success: (r) => resolve({ width: r.width, height: r.height, type: r.type }),
      fail: () => resolve(null),
    })
  })
}

/**
 * 上传前压缩图片
 *
 * 为什么必须做：
 * 1. 微信头像走 chooseAvatar 返回的是小图（几十 KB），而**相册原图**动辄 3~10MB，
 *    很容易撞上 OSS 上传策略里 10MB 的上限，直接 400 失败——这就是"只有相册图不行"的主因。
 * 2. iPhone 相册里的照片常是 **HEIC** 格式，直接传上去小程序 <image> 解不出来，头像会显示空白。
 *    wx.compressImage 会把 HEIC 转成标准 JPEG，一并解决。
 *
 * @param {string} filePath 本地临时路径
 * @param {number} maxSide 长边最大像素
 * @param {number} quality 压缩质量 0-100
 */
function compress(filePath, width, quality) {
  return new Promise((resolve) => {
    const opt = { src: filePath, quality: quality || 80 }
    if (width) opt.compressedWidth = width
    wx.compressImage({
      ...opt,
      success: (r) => resolve(r.tempFilePath || filePath),
      // 压缩失败（老版本基础库等）就用原图，不要卡住整个流程
      fail: () => resolve(filePath),
    })
  })
}

async function shrinkImage(filePath, maxSide, quality) {
  const info = await getImageSize(filePath)

  // 读不到尺寸（HEIC 等特殊格式），也重新编码一次，尽量转成标准 JPEG
  if (!info || !info.width || !info.height) {
    return compress(filePath, null, quality)
  }

  const longSide = Math.max(info.width, info.height)
  const needShrink = longSide > maxSide
  const needConvert = info.type && !/^(jpg|jpeg|png|gif|webp)$/i.test(info.type)
  if (!needShrink && !needConvert) return filePath

  const width = info.width >= info.height
    ? Math.min(info.width, maxSide)
    : Math.round((info.width * maxSide) / info.height)

  return compress(filePath, width, quality)
}

/** 把 OSS 返回的 XML 错误翻成人话 */
function describeOssError(res) {
  const raw = typeof res.data === 'string' ? res.data : ''
  const code = (/<Code>([^<]+)<\/Code>/.exec(raw) || [])[1] || ''
  const msg = (/<Message>([^<]+)<\/Message>/.exec(raw) || [])[1] || raw.slice(0, 160)
  let hint = ''
  if (code === 'EntityTooLarge' || code === 'InvalidPolicyDocument') {
    hint = '（文件过大，单文件上限 20MB）'
  } else if (code === 'SignatureDoesNotMatch') {
    hint = '（AccessKeySecret 可能填错）'
  } else if (code === 'AccessDenied') {
    hint = '（没有上传权限，检查 RAM 授权）'
  }
  return `上传失败 ${res.statusCode}${code ? ' ' + code : ''}${hint || '：' + msg}`
}

/** 直传 OSS，返回 https 永久地址 */
async function putToOss(params, key, localPath, contentType) {
  const res = await new Promise((resolve, reject) => {
    wx.uploadFile({
      url: params.host,
      filePath: localPath,
      name: 'file',
      formData: {
        key,
        policy: params.policy,
        OSSAccessKeyId: params.accessId,
        signature: params.signature,
        success_action_status: '200',
        'Content-Type': contentType,
      },
      success: resolve,
      fail: reject,
    })
  })

  if (res.statusCode !== 200 && res.statusCode !== 204) {
    throw new Error(describeOssError(res))
  }
  return `${params.host}/${key}`
}

/**
 * 上传一个本地文件到 OSS
 * @param {string} filePath 本地临时路径（wx.chooseMedia / chooseAvatar 返回的）
 * @param {string} dir 'avatars' | 'moments' | 'homework'
 * @param {string} openid 用于给文件名加前缀
 * @param {object} [options] { maxSide }
 * @returns {Promise<string>} https 永久地址
 */
async function uploadImage(filePath, dir, openid, options) {
  const opts = options || {}
  // 头像压到 512px 足够清晰，动态图压到 1600px
  const maxSide = opts.maxSide || (dir === 'avatars' ? 512 : 1600)

  // 先压缩，再取扩展名（压缩后统一是 jpg，避免 HEIC 之类传上去显示不出来）
  const localPath = await shrinkImage(filePath, maxSide, 80)

  const params = await getUploadParams(dir)
  const ext = extOf(localPath)
  const rand = Math.random().toString(36).slice(2, 8)
  const key = `${dir}/${openid || 'anon'}-${Date.now()}-${rand}.${ext}`

  return putToOss(params, key, localPath, MIME[ext])
}

/**
 * 上传任意文件（作业共享用）：不压缩、保留原始扩展名和 MIME
 * @param {string} filePath 本地临时路径
 * @param {string} dir 'homework'
 * @param {string} openid
 * @param {string} fileName 原始文件名，用来取扩展名
 * @returns {Promise<string>} https 永久地址
 */
async function uploadFile(filePath, dir, openid, fileName) {
  const params = await getUploadParams(dir)
  const ext = extOfName(fileName || filePath) || 'bin'
  const rand = Math.random().toString(36).slice(2, 8)
  const key = `${dir}/${openid || 'anon'}-${Date.now()}-${rand}.${ext}`

  return putToOss(params, key, filePath, MIME[ext] || 'application/octet-stream')
}

// 我们自己的 OSS 地址：https://<bucket>.<region>.aliyuncs.com/xxx
const OSS_URL_RE = /^https:\/\/[a-z0-9.-]+\.aliyuncs\.com\//i

/** 是否已经是「永久可访问」的地址（旧的 cloud:// 也算，只是显示不出来） */
function isPermanentUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (url.indexOf('cloud://') === 0) return true
  return OSS_URL_RE.test(url)
}

/**
 * 把数据库里的头像/图片地址转成能显示的地址
 * - cloud:// 是旧云存储文件 ID，免费环境下别人读不了 → 返回空，页面显示占位图
 * - 本地临时路径（http://tmp/、http://usr/、wxfile://）已过期 → 返回空
 * - OSS 的 https 地址原样返回
 */
function toDisplayUrl(url) {
  if (!url || typeof url !== 'string') return ''
  if (!isPermanentUrl(url)) return ''
  if (url.indexOf('cloud://') === 0) return ''
  return url
}

/**
 * 判断是否是需要上传的本地临时文件
 *
 * 微信在不同平台/版本上返回的临时路径格式不一样（http://tmp/、http://usr/、wxfile://tmp_），
 * 所以这里采用「白名单」判断：只有 cloud:// 和 OSS 的 https 地址算已保存，其余一律当作待上传的临时文件。
 * 这样无论微信返回什么格式，都不会把临时路径当成永久地址存进数据库。
 */
function isLocalTempFile(path) {
  if (!path || typeof path !== 'string') return false
  return !isPermanentUrl(path)
}

/**
 * 让云函数以「陌生人」的身份去访问这些 URL，确认别人真的能看到图。
 * 主要用于保存头像后自检：Bucket 不是「公共读」时会返回 403，能立刻发现而不是静默失败。
 * @param {string[]} urls
 * @returns {Promise<Array<{url:string, ok:boolean, status:number, error?:string}>>}
 */
async function checkUrls(urls) {
  const list = (urls || []).filter((u) => OSS_URL_RE.test(u)).slice(0, 12)
  if (!list.length) return []
  try {
    const res = await wx.cloud.callFunction({
      name: 'ossSign',
      data: { action: 'check', urls: list },
    })
    const r = (res && res.result) || {}
    return r.results || []
  } catch (e) {
    // 自检失败不应该阻塞业务流程
    console.warn('checkUrls failed', e)
    return []
  }
}

module.exports = {
  uploadImage,
  uploadFile,
  getUploadParams,
  toDisplayUrl,
  isLocalTempFile,
  isPermanentUrl,
  checkUrls,
}
