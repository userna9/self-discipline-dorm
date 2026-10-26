// 云函数 - 初始化数据库集合
// 在云开发控制台部署此函数后，在云函数测试中调用一次即可创建所有集合
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const db = cloud.database()
  const collections = ['users', 'checkins', 'lottery', 'moments', 'comments', 'mealAsks', 'homeworks', 'courtyard']
  const results = []

  for (const name of collections) {
    try {
      // 尝试获取集合，如果不存在会抛错
      await db.collection(name).limit(1).get()
      results.push({ name, status: 'exists' })
    } catch (e) {
      try {
        // 集合不存在，创建
        await db.createCollection(name)
        results.push({ name, status: 'created' })
      } catch (err) {
        results.push({ name, status: 'error', error: err.message })
      }
    }
  }

  return {
    success: true,
    message: '数据库集合初始化完成',
    collections: results,
    schemas: {
      users: {
        _openid: 'string (系统字段，微信openid)',
        nickname: 'string (昵称)',
        avatarUrl: 'string (头像URL)',
        createdAt: 'date (创建时间)',
        updatedAt: 'date (更新时间)'
      },
      checkins: {
        _openid: 'string (系统字段)',
        nickname: 'string (冗余字段)',
        avatarUrl: 'string (冗余字段)',
        date: 'string (YYYY-MM-DD 当天日期)',
        checkInTime: 'date (打卡时间戳)',
        hour: 'number (小时 0-23，用于排序和展示)',
        minute: 'number (分钟 0-59)'
      },
      lottery: {
        _openid: 'string (系统字段)',
        nickname: 'string',
        avatarUrl: 'string',
        date: 'string (YYYY-MM-DD)',
        result: 'string ("鹿" 或 "不鹿")',
        timestamp: 'date'
      },
      moments: {
        _openid: 'string (系统字段)',
        content: 'string (动态文字)',
        images: 'array (云存储 fileID 数组，最多 9 张)',
        nickname: 'string',
        avatarUrl: 'string',
        createdAt: 'date',
        likes: 'array (点赞用户的 openid 数组，由云函数 momentActions 维护)'
      },
      comments: {
        _openid: 'string (系统字段)',
        momentId: 'string (所属动态的 _id)',
        content: 'string (评论内容)',
        nickname: 'string',
        avatarUrl: 'string',
        createdAt: 'date'
      },
      mealAsks: {
        _openid: 'string (系统字段，发起人)',
        nickname: 'string (发起人昵称)',
        avatarUrl: 'string',
        date: 'string (YYYY-MM-DD)',
        mealType: 'string ("中午" 或 "下午")',
        question: 'string (如 "中午吃什么？")',
        options: 'array (固定选项)',
        answers: 'array (作答数组 [{openid, nickname, avatarUrl, choice, answeredAt}]，由云函数 mealActions 维护)',
        createdAt: 'date'
      }
    }
  }
}