import { promises as fsp } from 'node:fs'
import path from 'node:path'

// ---------- 部署执行记录（history.json，上限 500 条自动裁剪） ----------
const HIST_LIMIT = 500
const LOGTAIL_CHARS = 30000 // 尾部日志字符上限（超出后从头部截断到整行）

let history = []
let histFile = ''

async function load() {
  try {
    const h = JSON.parse(await fsp.readFile(histFile, 'utf8'))
    if (Array.isArray(h)) history = h
  } catch {}
  // 上次进程异常退出遗留的 running 记录标记为中断
  for (const r of history) {
    if (r.status === 'running') {
      r.status = 'aborted'
      r.endTime = Date.now()
      r.durationMs = r.endTime - r.startTime
    }
  }
}

export async function initHistory(dir) {
  histFile = path.join(dir, 'history.json')
  await load()
}

export async function saveHistory() {
  if (history.length > HIST_LIMIT) history = history.slice(-HIST_LIMIT)
  try { await fsp.writeFile(histFile, JSON.stringify(history, null, 2)) } catch {}
}

export function getHistory() { return history }

export async function replaceHistory(records) { history = records; await saveHistory() }

export { HIST_LIMIT, LOGTAIL_CHARS }
