import express from 'express'
import linebot from 'linebot'
import axios from 'axios'
import dotenv from 'dotenv'
import fs from 'fs'

dotenv.config()

/* -------------------- 基本設定 -------------------- */
const app = express()

// 健康檢查（Render + LINE Verify 必要）
app.get('/', (req, res) => {
  res.status(200).send('OK')
})

// 初始化 LINE Bot
const bot = linebot({
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
})

//  正確 parser（你之前漏掉）
const linebotParser = bot.parser()

// 正確 webhook 路由
app.post('/webhook', linebotParser, (req, res) => {
  res.sendStatus(200)
})

/* -------------------- API 設定 -------------------- */
const DATASET_ID = 'a6e90031-7ec4-4089-afb5-361a4efe7202'
const BASE_URL = `https://data.taipei/api/v1/dataset/${DATASET_ID}?scope=resourceAquire`

/* -------------------- 工具函式 -------------------- */
function hhmmToClock(hhmm) {
  if (!hhmm) return ''
  const s = String(hhmm).padStart(4, '0')
  return `${s.slice(0, 2)}:${s.slice(2)}`
}

function toMapUrl(lat, lng, name = '') {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${lat},${lng} ${name}`
  )}`
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/* -------------------- 寫 Flex JSON Log -------------------- */
function saveFlexToFile(flexObj, prefix = 'flex') {
  try {
    const dir = './flex_logs'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
    const filename = `${dir}/${prefix}_${timestamp}.json`

    fs.writeFileSync(filename, JSON.stringify(flexObj, null, 2), 'utf-8')
    console.log(`已輸出 Flex 至：${filename}`)
  } catch (err) {
    console.error(' Flex 寫檔錯誤：', err)
  }
}

/* -------------------- 抓資料 -------------------- */
async function fetchTrashPoints({ district, village, pageSize = 500, maxPages = 10 }) {
  const results = []

  for (let i = 0; i < maxPages; i++) {
    const offset = i * pageSize
    const url = `${BASE_URL}&limit=${pageSize}&offset=${offset}`
    const r = await axios.get(url)
    const payload = r.data?.result
    const rows = payload?.results || []
    if (!rows.length) break

    const filtered = rows.filter((x) => {
      const dist = x['行政區'] || x['行政區域']
      const okDistrict = district ? dist === district : true
      const okVillage = village ? x['里別'] === village : true
      return okDistrict && okVillage
    })

    results.push(...filtered)

    const total = payload?.count ?? 0
    if (offset + rows.length >= total) break
  }

  results.sort((a, b) => Number(a['抵達時間']) - Number(b['抵達時間']))

  return results
}

/* -------------------- Flex Message -------------------- */
function makeFlexBubbles(rows) {
  const max = Math.min(rows.length, 10)
  const bubbles = []

  for (let i = 0; i < max; i++) {
    const r = rows[i]
    const arrive = hhmmToClock(r['抵達時間'])
    const leave = hhmmToClock(r['離開時間'])
    const mapUrl = toMapUrl(r['緯度'], r['經度'], r['地點'])

    bubbles.push({
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `${r['行政區']} ${r['里別']}`, size: 'sm', color: '#666' },
          { type: 'text', text: `路線：${r['路線']}（${r['車次']}）`, weight: 'bold', size: 'md' },
          { type: 'text', text: `車號：${r['車號']}`, size: 'sm' },
          { type: 'text', text: `時間：${arrive} - ${leave}`, size: 'sm' },
          { type: 'text', text: `地點：${r['地點']}`, size: 'sm', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#2E7D32',
            action: { type: 'uri', label: ' 地圖', uri: mapUrl },
          },
        ],
      },
    })
  }
  return bubbles
}

/* -------------------- LINE Bot 主邏輯 -------------------- */
bot.on('message', async (event) => {
  try {
    console.log('收到使用者訊息：', event.message)

    // 開場提示 / 關鍵字
    if (
      event.message.type === 'text' &&
      /(垃圾車|查詢|查清運|start|hi|hello)/i.test(event.message.text)
    ) {
      await event.reply({
        type: 'text',
        text: '請選擇要查詢的方式 ',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: ' 查中山區', text: '中山區' } },
            { type: 'action', action: { type: 'message', label: '查信義區', text: '信義區' } },
            { type: 'action', action: { type: 'location', label: '傳送我的位置' } },
          ],
        },
      })
      return
    }

    // 使用者傳定位
    if (event.message.type === 'location') {
      const { latitude, longitude } = event.message
      const all = await fetchTrashPoints({ district: null, village: null })
      const withDistance = all.map((r) => {
        const lat = parseFloat(r['緯度'])
        const lng = parseFloat(r['經度'])
        return { ...r, distance: haversine(latitude, longitude, lat, lng) }
      })

      withDistance.sort((a, b) => a.distance - b.distance)
      const nearest = withDistance.slice(0, 5)

      const bubbles = makeFlexBubbles(nearest)
      const flexMsg = {
        type: 'flex',
        altText: '最近的垃圾車清運點',
        contents: { type: 'carousel', contents: bubbles },
      }

      saveFlexToFile(flexMsg, 'location')
      await event.reply(flexMsg)
      console.log('已回覆使用者位置查詢')
      return
    }

    // 使用者輸入行政區
    if (event.message.type === 'text') {
      const text = event.message.text.trim()

      // 修正區域判斷（使用 m[0]）
      const m = text.match(
        /(中正區|大同區|中山區|松山區|大安區|萬華區|信義區|士林區|北投區|內湖區|南港區|文山區)/
      )
      const district = m ? m[0] : null

      const vm = text.match(/([\u4e00-\u9fa5]{1,4}里)/)
      const village = vm ? vm[1] : null

      if (!district) {
        await event.reply({
          type: 'text',
          text: '請輸入行政區或使用下方按鈕 ',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '查中山區', text: '中山區' } },
              { type: 'action', action: { type: 'message', label: '查信義區', text: '信義區' } },
              { type: 'action', action: { type: 'location', label: '傳送我的位置' } },
            ],
          },
        })
        return
      }

      const rows = await fetchTrashPoints({ district, village })
      if (!rows.length) {
        await event.reply(`找不到「${district}${village ? ' ' + village : ''}」的垃圾車清運點 `)
        return
      }

      const bubbles = makeFlexBubbles(rows)
      const flex = {
        type: 'flex',
        altText: `台北市垃圾車｜${district}${village ? ' ' + village : ''}`,
        contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
      }

      saveFlexToFile(flex, district)
      console.log('===== FLEX JSON OUTPUT =====')
      console.log(JSON.stringify(flex, null, 2))
      console.log('===== END =====')
      await event.reply(flex)
      console.log('已回覆行政區查詢結果')
    }
  } catch (err) {
    console.error('LINE message error:', err?.response?.data || err.message)
    try {
      await event.reply('查詢時發生錯誤，請稍後再試')
    } catch (e) {
      console.error('Reply fallback 失敗:', e.message)
    }
  }
})

/* -------------------- 啟動伺服器 -------------------- */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`))
