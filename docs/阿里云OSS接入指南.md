# 阿里云 OSS 接入指南（宿舍）

> 目标：把头像和动态图片从「微信云开发存储」搬到「阿里云 OSS」，
> 解决免费云环境**云存储权限被锁死为「仅创建者可读写」**、导致室友之间互相看不到头像和照片的问题。
> 数据库和云函数继续留在微信云开发，只换存储这一层。

---

## 0. 先说清楚原理（30 秒版）

```
小程序 ──① 要签名──► 云函数 ossSign（存着 AccessKey）
       ◄─② 返回签名──┘
       ──③ 带签名直传──► 阿里云 OSS（Bucket 设为「公共读」）
       ──④ 把 https 地址存进数据库──► 云开发数据库
其他室友 ──⑤ 直接 <image src="https://..."> 打开图片 ──► OSS
```

三个关键点：

1. **AccessKey 只存在云函数里**，小程序包里没有密钥（小程序包能被解包，绝不能放 AK）。
2. **Bucket 设为「公共读」**，这就是"让所有人能看到别人的图"的开关，对应云开发里被锁住的那个权限。
3. **写权限仍然受控**：Bucket 是"公共读、私有写"，别人只能看，不能传；上传必须拿到云函数签发的、限定目录和 15 分钟有效期的签名。

已经写好的代码：

| 文件 | 作用 |
|---|---|
| `cloudfunctions/ossSign/` | 签发上传签名 + 迁移旧图 |
| `cloudfunctions/ossSign/config.js` | **你要填的配置文件** |
| `miniprogram/utils/oss.js` | 前端直传工具 |
| `miniprogram/utils/upload.js` | 头像上传（已改为走 OSS） |
| 各页面 | 上传与头像显示逻辑已切换 |

---

## 1. 开通 OSS 并创建 Bucket

1. 打开 [阿里云 OSS 控制台](https://oss.console.aliyun.com/)（需先完成实名认证）。
2. 点「创建 Bucket」，按下表填：

| 配置项 | 填什么 | 说明 |
|---|---|---|
| Bucket 名称 | 例如 `luguan-dorm` | 全局唯一，被占用就加后缀，如 `luguan-dorm-2026` |
| 地域 | 离你近的，如 `华东1（杭州）` | **记下来**，后面配置要用（`oss-cn-hangzhou`） |
| 读写权限 | **公共读** | ⭐ 最关键的一步，选错就等于白折腾 |
| 版本控制 | 不开 | |
| 存储冗余 | 本地冗余 | 便宜够用 |
| 服务端加密 | 无 | |

3. 创建完成后，进入 Bucket → 「概览」，记下 **Endpoint（地域节点）**，形如：
   `oss-cn-hangzhou.aliyuncs.com`

> ⚠️ 「公共读」= 任何人只要拿到 URL 就能看图。宿舍 6 人内部使用没问题；
> 如果你介意，可以改成「私有」，但那样每次看图都要再签名，本项目的代码要再改一轮。

---

## 2. 创建 RAM 子账号（拿 AccessKey）

**不要用主账号的 AccessKey**，一旦泄露整个阿里云账号都危险。用只对这个 Bucket 有权限的子账号。

1. 打开 [RAM 控制台](https://ram.console.aliyun.com/users) → 「创建用户」
2. 填写：
   - 登录名称：`luguan-dorm-oss`
   - 访问方式：**只勾「OpenAPI 调用访问」**（不要勾控制台登录）
3. 创建成功后会显示 **AccessKey ID** 和 **AccessKey Secret**。
   **Secret 只显示这一次**，先复制到记事本。

### 2.1 给这个子账号最小权限

左侧「权限策略」→「创建策略」→ 选「脚本编辑」，粘贴（把 `luguan-dorm` 换成你的 Bucket 名）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject"
      ],
      "Resource": [
        "acs:oss:*:*:luguan-dorm",
        "acs:oss:*:*:luguan-dorm/*"
      ]
    }
  ]
}
```

策略名称填 `luguan-dorm-oss-policy`，保存。
然后回到用户 `luguan-dorm-oss` → 「权限策略」→「新增授权」→ 选中刚建的策略。

> **找不到自己建的策略？** 「新增授权」弹窗里「权限策略」的筛选默认是「所有策略类型」，
> 列表前几屏全是系统策略（`AliyunOSSFullAccess` 之类），自己建的在后面。
> 直接把筛选切成 **「自定义策略」**，或者用搜索框搜 `luguan` 就能看到。
>
> **资源范围**选「账号级别」——我们的策略里写的是账号级 ARN（`acs:oss:*:*:bucket/*`），选资源组级别会不生效。

> 只要 `PutObject`（上传）和 `GetObject`（读取，迁移旧图时用）就够了，不要给 `oss:*`。

### 2.2 ⚠️「网络访问限制策略」不要动

RAM 的 AccessKey 详情页里有个「网络访问限制策略」，**保持「未配置」，直接关掉，不要启用**。

原因：微信云函数的出口 IP 是**动态的**（腾讯云的公共出口，随时会变），你没法把它们的 IP 加进白名单。
一旦启用限制策略，云函数调 OSS 会时好时坏、大概率直接 `AccessDenied`，而且极难排查。

> 页面上那句「未配置白名单规则，默认拒绝所有公网和专有网络访问」说的是：**一旦启用策略且白名单为空**，
> 就会拒绝所有访问。保持「未配置」= 不限制 = 正常可用。

如果你担心密钥泄露，正确的做法是：**只授予单个 Bucket 的最小权限**（第 2.1 步已经这么做了），
而不是靠 IP 白名单。

### 2.3 一张表说清：哪些要配、哪些别碰

OSS 控制台左侧菜单一大堆，**本项目只需要 2 项配置**（RAM 授权 + Bucket 公共读），其余全部不用管。

| 你可能会点到的页面 | 要配吗 | 为什么 |
|---|---|---|
| 概览 → **读写权限** | ✅ **必须是「公共读」** | 这是室友能看你头像/照片的总开关 |
| 概览 → **阻止公共访问** | ✅ **必须是「未开启」** | 一旦开启会把公共读废掉，匿名访问全部 403 |
| 访问控制 → RAM（子账号授权） | ✅ 已完成 | 第 2 步，决定云函数能不能上传 |
| **Bucket 授权策略**（Bucket Policy） | ❌ 不用，空的就对了 | 那是给「**其他阿里云账号**」或「指定 IP 段」授权的跨账号机制。我们用的是「RAM 子账号 + 公共读」，不涉及跨账号 |
| **网络访问限制策略**（RAM AK 详情页） | ❌ 不用 | 云函数出口 IP 是动态的，配了必然挂（见 2.2） |
| **跨域设置 CORS** | ❌ 不用 | `wx.uploadFile` 是小程序原生请求，不是浏览器 XHR，不发预检请求 |
| 传输加速 / CDN | ❌ 不用 | 6 人宿舍的量级用不上，还会多花钱 |
| 静态网站托管 | ❌ 不用 | 我们不托管网页 |
| 版本控制 | ❌ 不用 | 图片不需要保留历史版本 |
| 生命周期 / 归档 | ❌ 不用 | 照片量小，不需要自动转冷归档 |

> 判断标准很简单：**这个项目只有「一个账号、一个小程序、6 个人」**，
> 凡是涉及「跨账号」「跨域」「加速」「版本」的功能，统统用不上。

---

## 3. 配置小程序「uploadFile 合法域名」

小程序调用 `wx.uploadFile` 直传 OSS，必须先把 OSS 域名加进白名单，否则报 `url not in domain list`。

1. 打开 [微信公众平台](https://mp.weixin.qq.com/) → 登录你的小程序
2. 左侧「开发管理」→「开发设置」→「服务器域名」
3. 在 **uploadFile 合法域名** 里添加（注意必须 https、不能带路径）：

```
https://你的bucket名.oss-<地域ID>.aliyuncs.com
```

例如 Bucket 叫 `my-first-bucket-996`、地域是华中1（武汉-本地地域），就填：

```
https://my-first-bucket-996.oss-cn-wuhan-lr.aliyuncs.com
```

**常见地域对照表**（以控制台 Bucket 列表里显示的「地域」为准，别猜）：

| 控制台显示的地域 | 地域 ID（config.js 用） | 域名里的部分 |
|---|---|---|
| 华东1（杭州） | `cn-hangzhou` | `oss-cn-hangzhou` |
| 华东2（上海） | `cn-shanghai` | `oss-cn-shanghai` |
| 华北2（北京） | `cn-beijing` | `oss-cn-beijing` |
| 华南1（深圳） | `cn-shenzhen` | `oss-cn-shenzhen` |
| 西南1（成都） | `cn-chengdu` | `oss-cn-chengdu` |
| **华中1（武汉-本地地域）** | **`cn-wuhan-lr`** | **`oss-cn-wuhan-lr`** ← 注意有 `-lr` |

> - 「本地地域」的 ID 带 `-lr` 后缀（local region），不是 `cn-wuhan`，写错会报 `AccessDenied` 或域名解析失败。
> - 查完整列表：[OSS 地域和 Endpoint](https://help.aliyun.com/zh/oss/user-guide/regions-and-endpoints)
> - OSS 默认域名是阿里云已备案的，可以直接填，**不需要自己买域名做备案**。
> - 图片显示用的是 `<image src>` 组件，**不受域名白名单限制**，所以只显示图片的话 `downloadFile` / `request` 域名都不用配。
> - ⚠️ **但「作业共享」要下载 doc/pdf/ppt 再用 `wx.openDocument` 打开，用的是 `wx.downloadFile`，必须在「downloadFile 合法域名」里加上同一个 OSS 域名**，否则真机报 `downloadFile:fail url not in domain list`。开发工具勾了「不校验合法域名」会掩盖这个问题，真机才暴露。
> - 本地调试时可以在开发者工具「详情 → 本地设置」勾选 **不校验合法域名**，但真机预览必须配好。
> - 阿里云对**默认域名**有「浏览器直接打开会变成下载」的策略，这不影响小程序里的 `<image>` 显示和 `previewImage` 预览。

---

## 4. 填写配置并部署云函数

### 4.1 填配置

打开 `cloudfunctions/ossSign/config.js`，把四个值填上（没有这个文件就先复制模板：
`cp cloudfunctions/ossSign/config.example.js cloudfunctions/ossSign/config.js`）：

```js
module.exports = {
  region: process.env.OSS_REGION || 'oss-cn-hangzhou',       // 你的地域
  bucket: process.env.OSS_BUCKET || 'luguan-dorm',           // 你的 Bucket 名
  accessKeyId: process.env.OSS_AK_ID || 'LTAI5txxxxxxxx',    // RAM 子账号 AK ID
  accessKeySecret: process.env.OSS_AK_SECRET || 'xxxxxxxx',  // RAM 子账号 AK Secret
}
```

> **更安全的做法（推荐）**：`config.js` 留空，改成在「云开发控制台 → 云函数 → ossSign → 配置 → 环境变量」里
> 添加 `OSS_REGION` / `OSS_BUCKET` / `OSS_AK_ID` / `OSS_AK_SECRET` 四个变量。
> 环境变量优先级更高，这样密钥不会写进任何代码文件。
>
> **已经用环境变量了，`config.js` 要删吗？** 两种都行：
> - 留着但把 `accessKeyId` / `accessKeySecret` 清空（推荐，将来想本地调试或换 Bucket 时有地方改）
> - 直接删掉也行——代码做了兜底：`config.js` 不存在时自动读环境变量，某个字段为空时也会用环境变量补上
>
> ⚠️ 如果删了之后报「OSS 配置缺失」，说明云端环境变量没配全，回控制台检查这 4 个变量。

### 4.2 部署

在微信开发者工具左侧文件树，**右键 `cloudfunctions/ossSign` → 「上传并部署：云端安装依赖」**。

> ⚠️ **改了云函数代码就必须重新上传部署一次**，否则云端跑的还是旧版本。
> 本项目里改过的是 `ossSign` 和 `saveUserInfo` 两个。
>
> 怎么确认部署生效了？云函数测试传 `{"action":"xx"}`（故意写个错的），
> 返回里带 `"version": "1.2.0"` 就说明是新版；如果只返回 `未知 action：xx` 没有版本号，就是旧版没传上去。
> 也可以直接跑 `{"action":"selftest"}`，新版支持这个动作。

### 4.3 把超时时间调到 60 秒

控制台 → 云函数 → `ossSign` → 配置 → 超时时间，改成 **60 秒**。
（签发签名很快，但第 6 步迁移旧图会跑很久，默认超时会中断。）

---

## 5. 验证是否通了

### 5.0 一键自检（强烈推荐，先做这一步）

云函数 `ossSign` → 「云端测试」→ 传参：

```json
{ "action": "selftest" }
```

它会用你的 AK 往 `selftest/` 传一个 15 字节的小文件，再以匿名身份读回来，**一次验证四件事**：

| 验证项 | 失败时返回 |
|---|---|
| AK 是否存在 | `OSS 403 InvalidAccessKeyId: ...` |
| AK 是否有写权限 | `OSS 403 AccessDenied: ...` |
| Bucket 名 / 地域对不对 | `OSS 404 NoSuchBucket` 或 `SecondLevelDomainForbidden` |
| Bucket 是否公共读 | `success: false` + `上传成功但匿名读不了（403）` |

全部通过会返回：

```json
{
  "success": true,
  "url": "https://my-first-bucket-996.oss-cn-wuhan-lr.aliyuncs.com/selftest/ping-1761xxxx.txt",
  "hint": "配置正确：AK 有效、Bucket 可写、匿名可读，可以正常用了"
}
```

> 报错信息已经把 OSS 的 XML 提炼成一行，直接把 `error` 字段发出来就能定位问题。

### 5.1 云端测试签名

云函数 `ossSign` → 「云端测试」→ 传参：

```json
{ "action": "policy", "dir": "moments" }
```

正常应返回类似：

```json
{
  "success": true,
  "host": "https://luguan-dorm.oss-cn-hangzhou.aliyuncs.com",
  "accessId": "LTAI5t...",
  "policy": "eyJleHBpcmF0aW9uIjoi...",
  "signature": "0K28TsuAa03L1ySH/1Hq/n/giAk=",
  "dir": "moments",
  "maxSize": 10485760,
  "expire": "2026-10-21T09:01:07Z"
}
```

如果返回 `OSS 配置缺失：bucket / accessKeyId ...`，说明第 4.1 步没填好。

### 5.2 小程序里实测

1. 重新编译小程序
2. 进「我的」→ 编辑资料 → 换一张头像 → 保存
3. 到 OSS 控制台 → 文件 → 应该能看到 `avatars/` 目录下的新文件
4. 在浏览器里直接打开那个文件的 URL，能显示图片 → 说明「公共读」生效
5. **换一个微信号**（或让室友）打开小程序，能看到你的新头像 → 成功 🎉

如果第 4 步打不开（`AccessDenied`），说明 Bucket 权限没设成「公共读」，回到第 1 步改。

### 5.3 保存时的自动自检

保存头像时，代码会调 `ossSign` 的 `check` 动作，**以陌生人身份 HEAD 一次刚上传的图片**：

- 返回 `200` → 说明室友也能看到，正常保存
- 返回 `403` → 弹出「图片无法公开访问（403）：请把 Bucket 读写权限改成「公共读」」
- 返回 `404` → 上传其实没成功，会提示「图片无法访问」

这样就不会再出现「提示已保存、其实别人看不到」的静默失败。
也可以手动测：

```json
{ "action": "check", "urls": ["https://你的bucket.oss-cn-xxx.aliyuncs.com/avatars/xxx.jpg"] }
```

> 该动作只接受自己 Bucket 域名下的地址，不会被当成通用探测工具。

---

## 6.（可选）迁移旧图

以前发的动态图片和旧头像还是 `cloud://` 文件 ID，在免费环境下别人读不了。
`ossSign` 提供了迁移能力：下载云存储里的旧文件 → 上传到 OSS → 把数据库里的地址改写成 https。

**建议先用小批量试**：

```json
{ "action": "migrate", "limit": 5 }
```

确认 OSS 上出现了 `migrated/` 目录且内容正常，再全量跑：

```json
{ "action": "migrate" }
```

返回示例：

```json
{
  "success": true,
  "migratedFiles": 12,
  "updatedDocs": 9,
  "errors": []
}
```

说明：

- 按 `fileID` 的 MD5 命名，**可以重复执行**，已迁移过的会命中缓存不会重复上传。
- 单个文件失败不影响其他文件，失败信息在 `errors` 里。
- 数据量大的话分几次跑（每次靠超时时间内能跑多少算多少，重复执行即可）。
- 迁移完旧的云存储文件不会删除，可以之后在云开发控制台手动清空，不影响使用。

> 不想迁移也可以：让每个人重新保存一次头像，新发的动态自然就是 OSS 地址了。
> 只是**历史动态里的老照片**会继续显示不出来（页面已经做了处理，会隐藏而不是裂图）。

---

## 7. 成本

6 人宿舍的量级，基本等于免费：

| 项目 | 单价 | 你们大概用量 | 月成本 |
|---|---|---|---|
| 存储（标准-本地冗余） | 0.12 元/GB/月 | 2~5 GB | 0.3~0.6 元 |
| 外网流出流量 | 0.50 元/GB | 每月几 GB | 1~3 元 |
| 请求次数 | 0.01 元/万次 | 可忽略 | ≈0 |

一年大概 **10~30 元**。对比云开发转付费 19.9 元/月（239 元/年），省一大截。

想再省：在 OSS 上开「传输加速」没必要；如果流量变多，可以开 CDN 回源（本项目的图片是公共读，加 CDN 只需换域名）。

---

## 8. 排错对照表

| 现象 | 原因 | 解决 |
|---|---|---|
| `uploadFile:fail url not in domain list` | 域名没加白名单 | 第 3 步，且真机要重新编译 |
| 上传返回 403 `SignatureDoesNotMatch` | AK Secret 填错，或 Bucket/地域填错 | 核对 `config.js`；确认地域和 Bucket 所在区域一致 |
| 上传返回 403 `AccessDenied` | RAM 策略没生效 / 少了 PutObject | 第 2.1 步重新授权，等 1 分钟生效 |
| 上传返回 400 `InvalidPolicyDocument` | 签名过期（超过 15 分钟） | 重新进入小程序再传；签名有本地缓存，正常不会触发 |
| 上传成功但图片打不开 `AccessDenied` | Bucket 不是「公共读」 | 第 1 步改权限 |
| **保存头像提示「已保存」，但下拉刷新后头像变回默认图** | 存进数据库的是微信返回的**本地临时路径**（`http://tmp/`、`http://usr/`、`wxfile://`），不是 OSS 地址 | 已修复：代码改为「白名单」判断（只有 `cloud://` 和 `*.aliyuncs.com` 才算已保存），并在 `saveUserInfo` 服务端拦截临时路径。**重新上传部署 `ossSign` 和 `saveUserInfo` 云函数**，然后重新选一次头像 |
| 保存头像弹「图片无法公开访问（403）」 | Bucket 不是「公共读」 | 第 1 步改权限（这个报错就是保存时的自检在提醒你） |
| 宿舍空间里**所有人的头像一直是空白**，但图片正常 | `checkins` / `lottery` / `moments` / `comments` 里的 `avatarUrl` 是**发布当时的快照**，当时没保存成功就一直是空的 | 已改为以 `users` 集合为唯一数据源（`utils/users.js`），用户只要成功保存过一次头像，历史记录里的头像会自动显示。若仍空白，去「数据库 → users」看 `avatarUrl` 到底是什么值 |
| 图片能打开但显示成下载 | 对象 `Content-Type` 不对 | 代码已带 `Content-Type`，若出现请检查 `utils/oss.js` 的 `MIME` |
| 别人还是看不到新头像 | 数据库里存的还是旧 `cloud://` | 让对应用户重新保存一次头像；或执行第 6 步迁移 |
| 云函数报 `未知 action：selftest` | 云端跑的是旧版 `ossSign`，新代码没部署上去 | 右键 `cloudfunctions/ossSign` → 上传并部署（见 4.2） |
| 云函数报 `OSS 配置缺失` | 配置没填 / 环境变量没生效 | 第 4.1 步 |
| 迁移跑到一半中断 | 云函数超时 | 第 4.3 步改成 60 秒；或分批带 `limit` 跑 |

---

## 9. 安全须知

- **AccessKey Secret 绝不能出现在 `miniprogram/` 目录下**。小程序代码会被下载和解包，等于公开。
- 提交代码到 GitHub 前，确认 `cloudfunctions/ossSign/config.js` 里没有真实密钥。
  项目里已经加了 `.gitignore`，默认忽略这个文件；模板是同目录的 `config.example.js`。
  即使文件缺失云函数也不会崩，会自动退回读环境变量。
- 签名策略已经限制了：只能传 `avatars/` 或 `moments/` 目录、单文件不超过 10MB、15 分钟内有效。即使签名泄露，破坏面也很小。
- 想进一步收紧：把「公共读」改成「私有」+ 生成带签名的临时 URL 给前端（需要再改 `utils/oss.js`，本项目未做）。

---

## 10. 改造清单（已完成的代码改动）

| 文件 | 改了什么 |
|---|---|
| `cloudfunctions/ossSign/index.js` | 新增：签发 PostObject 签名、服务端 PUT 签名、旧文件迁移、`check` / `selftest` 自检 |
| `cloudfunctions/ossSign/config.js` | 新增：OSS 配置（你填这里） |
| `cloudfunctions/ossSign/config.example.js` | 新增：配置模板 |
| `.gitignore` | 新增：忽略含密钥的 `config.js` |
| `miniprogram/utils/oss.js` | 新增：`uploadImage` / `toDisplayUrl` / `isLocalTempFile` |
| `miniprogram/utils/users.js` | 新增：`getAvatarMap` —— 头像统一以 `users` 集合为准（见下） |
| `miniprogram/utils/upload.js` | 头像上传改为走 OSS |
| `pages/moments/moments.js` | 动态图片改为直传 OSS；图片预览直接用 https；过滤掉旧的 cloud:// 图 |
| `pages/index/index.js`、`pages/profile/profile.js` | 头像上传走 OSS；显示地址归一化 |
| `pages/checkin/checkin.js`、`pages/lottery/lottery.js` | 头像显示地址归一化 |
| `cloudfunctions/saveUserInfo/index.js` | 头像换成 OSS 地址后，同步刷新历史记录里的旧头像；**拒绝把本地临时路径存进数据库** |
| `cloudfunctions/momentActions/index.js` | 删除动态时只清理遗留的 cloud:// 文件 |

> ⚠️ 如果你之前已经部署过云函数，这次改动涉及 `ossSign`（新增 `check` 动作）和 `saveUserInfo`（新增临时路径校验），
> **这两个要重新「上传并部署」一次**，否则前端会调不到 `check`、临时路径也拦不住。

> 回滚方式：以上改动都是替换式的，若想退回云开发存储，把 `utils/upload.js` 和 `moments.js` 的上传调用改回
> `wx.cloud.uploadFile` 即可，其余逻辑不受影响。
