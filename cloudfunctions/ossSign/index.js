// 云函数 ossSign
//   作用：给小程序前端签发「阿里云 OSS 直传签名」，让前端把图片直接传到 OSS，
//        并把历史遗留的 cloud:// 文件迁移到 OSS（免费云开发环境读不了别人的文件）。
//
//   入参：
//     { action: 'policy', dir: 'avatars' | 'moments' }   → 拿上传签名
//     { action: 'migrate', limit?: number }              → 迁移旧 cloud:// 文件（可选）
//
//   出参（policy）：
//     { success, host, accessId, policy, signature, dir, maxSize, expire }
//
//   全部使用 Node 内置模块，不需要 npm install。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

// config.js 里是密钥，默认不提交到仓库；缺失时直接读环境变量
function readEnvConfig() {
  return {
    region: process.env.OSS_REGION || '',
    bucket: process.env.OSS_BUCKET || '',
    accessKeyId: process.env.OSS_AK_ID || '',
    accessKeySecret: process.env.OSS_AK_SECRET || '',
  }
}

let cfg = {}
try {
  cfg = require('./config')
} catch (e) {
  // 没有 config.js 时不能用空对象，否则环境变量读不到
  cfg = readEnvConfig()
  console.warn('未找到 config.js，改用环境变量配置 OSS')
}

// 兜底：config.js 存在但某个字段是空的，仍然用环境变量补上
const envCfg = readEnvConfig()
cfg = {
  region: cfg.region || envCfg.region,
  bucket: cfg.bucket || envCfg.bucket,
  accessKeyId: cfg.accessKeyId || envCfg.accessKeyId,
  accessKeySecret: cfg.accessKeySecret || envCfg.accessKeySecret,
}

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 只允许往这几个目录上传，防止前端传任意 key
const ALLOWED_DIRS = ['avatars', 'moments', 'homework']
// 版本号：每次改完重新部署后可以在这里对一下，避免"改了没生效"
const VERSION = '1.3.0'
const ACTIONS = ['policy', 'check', 'migrate', 'selftest']
// 签名有效期（秒）：前端拿到后 15 分钟内必须传完
const POLICY_TTL = 900
// 单文件大小上限 20MB（作业里有 PPT/PDF，10MB 不够用）
const MAX_SIZE = 20 * 1024 * 1024

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

function ossHost() {
  return `https://${cfg.bucket}.${cfg.region}.aliyuncs.com`
}

function assertConfig() {
  const missing = ['bucket', 'accessKeyId', 'accessKeySecret'].filter((k) => !cfg[k])
  if (missing.length) {
    throw new Error(
      `OSS 配置缺失：${missing.join(' / ')}。请填写 cloudfunctions/ossSign/config.js，` +
        '或在云开发控制台给 ossSign 配置同名环境变量。'
    )
  }
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  const ext = m ? m[1].toLowerCase() : 'jpg'
  return MIME[ext] ? ext : 'jpg'
}

function contentTypeOf(ext) {
  return MIME[ext] || 'application/octet-stream'
}

// ============ 1. 签发前端直传签名（PostObject 表单直传） ============

function buildPolicy(dir) {
  assertConfig()
  // OSS 要求 ISO8601 且不带毫秒
  const expiration = new Date(Date.now() + POLICY_TTL * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  const policyText = JSON.stringify({
    expiration,
    conditions: [
      ['content-length-range', 0, MAX_SIZE],
      // 只能传到指定目录下
      ['starts-with', '$key', `${dir}/`],
    ],
  })

  const policy = Buffer.from(policyText, 'utf8').toString('base64')
  const signature = crypto
    .createHmac('sha1', cfg.accessKeySecret)
    .update(policy)
    .digest('base64')

  return {
    success: true,
    host: ossHost(),
    accessId: cfg.accessKeyId,
    policy,
    signature,
    dir,
    maxSize: MAX_SIZE,
    expire: expiration,
  }
}

// ============ 2. 服务端 PUT（迁移用，签名 V1） ============
function ossPut(key, body, contentType) {
  assertConfig()
  const date = new Date().toUTCString()
  const resource = `/${cfg.bucket}/${key}`
  // StringToSign = VERB \n Content-MD5 \n Content-Type \n Date \n CanonicalizedOSSHeaders + CanonicalizedResource
  // 没有 x-oss-* 头时 CanonicalizedOSSHeaders 为空，Date 后面只有一个换行，不能多写
  const stringToSign = ['PUT', '', contentType, date].join('\n') + '\n' + resource
  const signature = crypto
    .createHmac('sha1', cfg.accessKeySecret)
    .update(stringToSign)
    .digest('base64')

  const host = `${cfg.bucket}.${cfg.region}.aliyuncs.com`
  const path = '/' + key.split('/').map(encodeURIComponent).join('/')

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path,
        method: 'PUT',
        headers: {
          Date: date,
          'Content-Type': contentType,
          'Content-Length': body.length,
          Authorization: `OSS ${cfg.accessKeyId}:${signature}`,
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(`${ossHost()}/${key}`)
          } else {
            // 把 OSS 的 XML 错误提取成一行可读信息，方便直接定位
            const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1] || ''
            const message = (/<Message>([^<]+)<\/Message>/.exec(text) || [])[1] || ''
            const detail = message || text.slice(0, 200)
            reject(new Error(`OSS ${res.statusCode}${code ? ` ${code}` : ''}: ${detail}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function fetchAll(colName, limit) {
  const out = []
  const pageSize = 100
  let skip = 0
  while (true) {
    const res = await db.collection(colName).skip(skip).limit(pageSize).get()
    const data = res.data || []
    out.push(...data)
    if (data.length < pageSize) break
    skip += pageSize
    if (limit && out.length >= limit) break
    if (skip > 5000) break
  }
  return limit ? out.slice(0, limit) : out
}

function collectCloudIds(doc) {
  const ids = []
  if (typeof doc.avatarUrl === 'string' && doc.avatarUrl.indexOf('cloud://') === 0) {
    ids.push(doc.avatarUrl)
  }
  if (Array.isArray(doc.images)) {
    for (const u of doc.images) {
      if (typeof u === 'string' && u.indexOf('cloud://') === 0) ids.push(u)
    }
  }
  return ids
}

async function migrate(limit) {
  assertConfig()
  const cache = new Map() // fileID -> https url
  const errors = []
  const collections = ['users', 'checkins', 'lottery', 'moments', 'comments']
  let fileCount = 0
  let docCount = 0

  async function convert(fileID) {
    if (cache.has(fileID)) return cache.get(fileID)
    const dl = await cloud.downloadFile({ fileID })
    const body = dl.fileContent
    const ext = extOf(fileID)
    const hash = crypto.createHash('md5').update(fileID).digest('hex').slice(0, 16)
    const key = `migrated/${hash}.${ext}`
    const url = await ossPut(key, body, contentTypeOf(ext))
    cache.set(fileID, url)
    fileCount++
    return url
  }

  for (const colName of collections) {
    let docs = []
    try {
      docs = await fetchAll(colName, limit)
    } catch (e) {
      errors.push(`${colName} 读取失败：${e.message}`)
      continue
    }

    for (const doc of docs) {
      const ids = collectCloudIds(doc)
      if (!ids.length) continue

      const patch = {}

      if (typeof doc.avatarUrl === 'string' && doc.avatarUrl.indexOf('cloud://') === 0) {
        try {
          patch.avatarUrl = await convert(doc.avatarUrl)
        } catch (e) {
          if (errors.length < 20) errors.push(`${colName}.${doc._id} 头像：${e.message}`)
        }
      }

      if (Array.isArray(doc.images) && doc.images.length) {
        const next = []
        let changed = false
        for (const u of doc.images) {
          if (typeof u === 'string' && u.indexOf('cloud://') === 0) {
            try {
              next.push(await convert(u))
              changed = true
            } catch (e) {
              if (errors.length < 20) errors.push(`${colName}.${doc._id} 图片：${e.message}`)
              next.push(u)
            }
          } else {
            next.push(u)
          }
        }
        if (changed) patch.images = next
      }

      if (Object.keys(patch).length) {
        try {
          await db.collection(colName).doc(doc._id).update({ data: patch })
          docCount++
        } catch (e) {
          if (errors.length < 20) errors.push(`${colName}.${doc._id} 写回失败：${e.message}`)
        }
      }
    }
  }

  return {
    success: errors.length === 0,
    migratedFiles: fileCount,
    updatedDocs: docCount,
    errors,
  }
}

// ============ 3. 自检：以匿名身份访问 URL，确认别人真的能看到图 ============

function headUrl(url) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      resolve({ url, ok: false, status: 0, error: 'URL 格式错误' })
      return
    }
    // 只允许检查自己 Bucket 下的地址，避免被当成通用探测工具
    if (!url.startsWith(`${ossHost()}/`)) {
      resolve({ url, ok: false, status: 0, error: '不是本 Bucket 的地址' })
      return
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'HEAD',
        timeout: 5000,
      },
      (res) => {
        res.resume()
        const ok = res.statusCode >= 200 && res.statusCode < 300
        resolve({ url, ok, status: res.statusCode })
      }
    )
    req.on('error', (e) => resolve({ url, ok: false, status: 0, error: e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ url, ok: false, status: 0, error: 'timeout' })
    })
    req.end()
  })
}

async function checkUrls(urls) {
  // 自检只需要知道 Bucket，不依赖 AccessKey
  if (!cfg.bucket) {
    return { success: false, error: 'OSS 配置缺失：bucket' }
  }
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string').slice(0, 12)
  const results = []
  for (const url of list) {
    results.push(await headUrl(url))
  }
  return { success: true, results }
}

// ============ 4. 一键自检：验证 AK / 权限 / Bucket / 公共读 ============

async function selfTest() {
  assertConfig()
  const key = `selftest/ping-${Date.now()}.txt`
  const body = Buffer.from('oss selftest ok', 'utf8')

  // ① 用 AK 签一个 PUT，能成功说明：AK 有效、有 PutObject 权限、Bucket 名和地域正确
  const url = await ossPut(key, body, 'text/plain')

  // ② 再以匿名身份读一次，能成功说明：Bucket 是「公共读」，室友也能看到图
  const read = await headUrl(url)

  return {
    success: read.ok,
    version: VERSION,
    url,
    put: { ok: true, key },
    read,
    hint: read.ok
      ? '配置正确：AK 有效、Bucket 可写、匿名可读，可以正常用了'
      : `上传成功但匿名读不了（${read.status || read.error}），请把 Bucket 读写权限改成「公共读」`,
  }
}

// ============ 入口 ============

exports.main = async (event = {}) => {
  const action = event.action || 'policy'

  try {
    if (action === 'policy') {
      const dir = event.dir || 'moments'
      if (ALLOWED_DIRS.indexOf(dir) === -1) {
        return { success: false, error: `不支持的目录：${dir}` }
      }
      return buildPolicy(dir)
    }

    if (action === 'migrate') {
      // 迁移耗时较长，务必在控制台把 ossSign 超时时间调到 60 秒
      const limit = Number(event.limit) > 0 ? Number(event.limit) : 0
      return await migrate(limit)
    }

    if (action === 'check') {
      return await checkUrls(event.urls)
    }

    if (action === 'selftest') {
      return await selfTest()
    }

    return {
      success: false,
      error: `未知 action：${action}。当前版本 ${VERSION}，支持：${ACTIONS.join(' / ')}`,
      version: VERSION,
      supported: ACTIONS,
    }
  } catch (err) {
    console.error('ossSign error', err)
    return { success: false, error: err.message, version: VERSION }
  }
}
