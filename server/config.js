import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 状态：数据目录由插件 Config/dataDir 决定，initConfig 时绑定 ----------
let dataDir = ''
let envsFile = ''
let defaultProjectPath = ''
let envs = []
const seedBases = {}

// 种子数据：随包分发（来自旧项目 scripts-extract.json）
const SEED_FILE = fileURLToPath(new URL('../seed/scripts-extract.json', import.meta.url))

// 固定 4 个种子模块的显示名与旧 record 键的映射
const MODULE_NAME = { bsFront: 'bs 前端', bsServer: 'bs 服务端', adminFront: 'admin 前端', adminServer: 'admin 服务端' }
const MODULE_ORDER = ['bsFront', 'bsServer', 'adminFront', 'adminServer']

// 种子分组：fxy=官方，dyx/jh/xsy/yjy=私有化，jcd/xl=OEM
const GROUP_BY_ID = { fxy: '官方', dyx: '私有化', jh: '私有化', xsy: '私有化', yjy: '私有化', jcd: 'OEM', xl: 'OEM' }

function defaultModules() {
  return [
    { id: 'bsFront', name: 'bs 前端', kind: 'front', enabled: true, gradleTask: 'client:client-front:dist', key: '', extraArgs: '', localPath: 'client/client-front/dist/', remotePath: '', postCommand: '', frontEnv: '' },
    { id: 'bsServer', name: 'bs 服务端', kind: 'server', enabled: true, gradleTask: 'client:client-server:bootJar', key: '', extraArgs: '', localPath: 'client/client-server/build/libs/financial-v5.jar', remotePath: '', postCommand: '', frontEnv: '' },
    { id: 'adminFront', name: 'admin 前端', kind: 'front', enabled: true, gradleTask: 'admin:admin-front:dist', key: '', extraArgs: '', localPath: 'admin/admin-front/dist/', remotePath: '', postCommand: '', frontEnv: '' },
    { id: 'adminServer', name: 'admin 服务端', kind: 'server', enabled: true, gradleTask: 'admin:admin-server:bootJar', key: '', extraArgs: '', localPath: 'admin/admin-server/build/libs/financial-admin-v5.jar', remotePath: '', postCommand: '', frontEnv: '' },
  ]
}

function templateEnv() {
  return { id: '', name: '', note: '', group: '', projectPath: defaultProjectPath, jdkHome: '', expTime: '', ssh: { host: '', port: 22, user: 'root', password: '', options: '' }, modules: defaultModules() }
}

function splitGradle(cmd) {
  const parts = cmd.trim().split(/\s+/)
  let key = '', extra = []
  for (const p of parts.slice(1)) {
    if (p.startsWith('-Pkey=')) key = p.slice(6)
    else extra.push(p)
  }
  return { task: parts[0], key, extra: extra.join(' ') }
}

function seedFromExtract(id, name, note, e) {
  const toMod = (mid, me) => {
    const g = splitGradle(me.gradleTask)
    // distDir 部署 dist/<key> 子目录（原脚本源带尾斜杠，复制内容进远程目录，保留此语义）；
    // jh 后端同步 build/libs 整个目录（原脚本源同样带尾斜杠）
    const local = me.distDir ? `${me.distDir}/` : me.jarLocal ? (id === 'jh' ? `${me.jarLocal}/` : me.jarLocal) : ''
    return { id: mid, name: MODULE_NAME[mid] || mid, kind: mid.endsWith('Front') ? 'front' : 'server', enabled: true, gradleTask: g.task, key: g.key, extraArgs: g.extra, localPath: local, remotePath: me.remotePath, postCommand: me.postCommand ?? '', frontEnv: '' }
  }
  return {
    id, name, note, projectPath: defaultProjectPath, jdkHome: e.javaHome,
    ssh: { host: e.ssh.host, port: e.ssh.port, user: e.ssh.user, password: '', options: '' },
    modules: [toMod('bsFront', e.bsFront), toMod('bsServer', e.bsServer), toMod('adminFront', e.adminFront), toMod('adminServer', e.adminServer)],
  }
}

const DEFAULTS = [
  ['update.sh', 'fxy', '分析云 (官方)', '主站'],
  ['update-dyx.sh', 'dyx', '深圳德永信', '私有化'],
  ['update-jh.sh', 'jh', '金合', ''],
  ['update-oem-jcd.sh', 'jcd', '金财道 OEM', 'OEM'],
  ['update-oem-xl.sh', 'xl', '企云乐 OEM', 'OEM'],
  ['update-xsy.sh', 'xsy', '新世洋', '私有化 / 带过期时间'],
  ['update-yjy.sh', 'yjy', '有机云', ''],
]

async function loadSeeds() {
  let data = {}
  try { data = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8')) } catch {}
  for (const k of Object.keys(data)) {
    const e = data[k]
    const def = DEFAULTS.find(d => d[0] === e.file)
    const [id, name, note] = def ? [def[1], def[2], def[3]] : [k, k, '']
    seedBases[e.file] = seedFromExtract(id, name, note, e)
  }
}

function defaultEnvs() {
  // 播种也走一遍归一化：保证首启返回/写盘即符合契约 schema（group/expTime 等字段齐全）
  return DEFAULTS.map(([file, id, name, note]) => normalizeEnv({ ...(seedBases[file] || templateEnv()), id, name, note }))
}

// ---------- 加载 / 迁移 envs.json ----------
function isNewSchema(e) {
  return !!e && typeof e === 'object' && !!e.ssh && typeof e.ssh === 'object'
}

// 把 modules 归一化为数组；record 旧格式自动转数组（id 保持 bsFront 等，name 映射），frontEnv.bs/admin 迁移进对应 front 模块
function toModArray(mods, fe) {
  const out = []
  if (Array.isArray(mods)) {
    let i = 0
    for (const raw of mods) {
      const id = String(raw?.id || `mod${++i}`)
      out.push({
        id,
        name: String(raw?.name || MODULE_NAME[id] || id),
        kind: (raw?.kind === 'server' ? 'server' : raw?.kind === 'front' ? 'front' : (id.endsWith('Front') ? 'front' : 'server')),
        enabled: raw?.enabled !== false,
        gradleTask: String(raw?.gradleTask || ''),
        key: String(raw?.key || ''),
        extraArgs: String(raw?.extraArgs || ''),
        localPath: String(raw?.localPath || ''),
        remotePath: String(raw?.remotePath || ''),
        postCommand: String(raw?.postCommand || ''),
        healthCheckUrl: String(raw?.healthCheckUrl || '').trim(),
        frontEnv: String(raw?.frontEnv || ''),
      })
    }
  } else if (mods && typeof mods === 'object') {
    for (const mk of MODULE_ORDER) {
      const m = mods[mk]
      if (!m) continue
      const feText = mk === 'bsFront' ? (fe?.bs || '') : mk === 'adminFront' ? (fe?.admin || '') : ''
      out.push({
        id: mk, name: MODULE_NAME[mk] || mk, kind: mk.endsWith('Front') ? 'front' : 'server',
        enabled: m.enabled !== false,
        gradleTask: String(m.gradleTask || ''), key: String(m.key || ''), extraArgs: String(m.extraArgs || ''),
        localPath: String(m.localPath || ''), remotePath: String(m.remotePath || ''), postCommand: String(m.postCommand || ''),
        frontEnv: feText,
      })
    }
  }
  return out
}

function normalizeEnv(e) {
  const env = {
    id: e.id, name: e.name, note: e.note ?? '',
    group: e.group ?? GROUP_BY_ID[e.id] ?? '',
    projectPath: e.projectPath || defaultProjectPath,
    jdkHome: e.jdkHome ?? '',
    expTime: e.expTime ?? '',
    ssh: { host: e.ssh?.host ?? '', port: Number(e.ssh?.port) || 22, user: e.ssh?.user ?? 'root', password: e.ssh?.password ?? '', options: e.ssh?.options ?? '' },
    modules: toModArray(e.modules, { bs: e.frontEnv?.bs, admin: e.frontEnv?.admin }),
  }
  // 迁移（幂等）：把 server 模块 extraArgs 里的 -PexpTime=xxx 提取到 env.expTime 并从 extraArgs 移除
  let extracted = ''
  for (const m of env.modules) {
    if (m.kind !== 'server' || !m.extraArgs) continue
    const kept = m.extraArgs.trim().split(/\s+/).filter(p => {
      if (p.startsWith('-PexpTime=')) { if (!extracted) extracted = p.slice(10); return false }
      return true
    })
    m.extraArgs = kept.join(' ')
  }
  if (extracted && !env.expTime) env.expTime = extracted
  return env
}

async function loadEnvs() {
  let raw = null
  try { raw = JSON.parse(await fsp.readFile(envsFile, 'utf8')) } catch {}
  if (!Array.isArray(raw) || !raw.length) {
    const defs = defaultEnvs()
    await fsp.writeFile(envsFile, JSON.stringify(defs, null, 2))
    return defs
  }
  let migrated = false
  const out = []
  for (const e of raw) {
    if (isNewSchema(e)) {
      const r = e
      if ((!r.group && GROUP_BY_ID[r.id]) || !Array.isArray(r.modules) || r.modules.some(m => m?.extraArgs?.toString().includes('-PexpTime='))) migrated = true
      out.push(normalizeEnv(r))
      continue
    }
    migrated = true
    // 旧 schema（{id,name,script,...}）：按 script 播种，保留 id/name/note
    const old = e
    const base = seedBases[String(old.script || '')] || templateEnv()
    out.push(normalizeEnv({ ...base, id: String(old.id || ''), name: String(old.name || base.name), note: String(old.note ?? base.note ?? '') }))
  }
  if (migrated) await fsp.writeFile(envsFile, JSON.stringify(out, null, 2))
  return out
}

export async function initConfig({ dataDir: dir, defaultProjectPath: projectPath = '' } = {}) {
  dataDir = dir || ''
  envsFile = dataDir ? path.join(dataDir, 'envs.json') : ''
  defaultProjectPath = projectPath || ''
  if (!envsFile) throw new Error('未配置数据目录')
  await loadSeeds()
  envs = await loadEnvs()
}

export function getEnvs() { return envs }

export async function saveEnvs(next = envs) {
  await fsp.writeFile(envsFile, JSON.stringify(next, null, 2))
  envs = next
}

export function getDefaultProjectPath() { return defaultProjectPath }

// 旧 schema 迁移用：按原脚本文件名取种子环境
export function seedBase(file) { return seedBases[file] || null }

// ---------- 校验 ----------
const BAD_PATH = /[\s;"'`$&|<>()*?[\]{}!]/ // 禁止空格/引号/; & | ` $ 等
const BAD_CMD = /["'`;&|<>$()*?[\]{}!]/ // 允许空格，其余同上

// 前端 .env 文本：只允许 KEY=VALUE（KEY 为 A-Z0-9_）、空行、# 注释
export function validateFrontEnv(s) {
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (!/^[A-Z0-9_]+\s*=/.test(t)) return '前端 .env 只允许 KEY=VALUE 行（KEY 为 A-Z0-9_）或空行/注释行'
  }
  return ''
}

// 前端 .env 文件路径（仅种子 bsFront/adminFront 有约定路径，供「配置为空时读文件作参考」）
export function frontEnvFile(e, m) {
  const p = (e.projectPath || defaultProjectPath || '').replace(/\/+$/, '')
  if (!p) return null
  const key = m.key ? '.' + m.key : ''
  if (m.id === 'bsFront') return `${p}/client/client-front/.env${key}`
  if (m.id === 'adminFront') return `${p}/admin/admin-front/.env${key}`
  return null
}

export function validateEnv(e) {
  const errs = []
  if (!/^[a-z0-9-]+$/.test(e.id)) errs.push('ID 只能是小写字母/数字/连字符')
  if (!e.name.trim()) errs.push('名称必填')
  if (e.group && !/^[\u4e00-\u9fa5A-Za-z0-9 -]{1,20}$/.test(e.group)) errs.push('分组只能含中文/字母/数字/空格/连字符，最长 20 字符')
  if (!e.projectPath.startsWith('/')) errs.push('项目路径必须是绝对路径')
  if (BAD_PATH.test(e.projectPath)) errs.push('项目路径含非法字符（禁止空格/引号/; & | ` $ 等）')
  if (e.jdkHome && !e.jdkHome.startsWith('/')) errs.push('JDK 路径必须是绝对路径')
  if (e.jdkHome && BAD_PATH.test(e.jdkHome)) errs.push('JDK 路径含非法字符')
  const s = e.ssh
  if (!/^[a-zA-Z0-9.-]+$/.test(s.host)) errs.push('SSH host 非法（仅字母/数字/./-）')
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) errs.push('SSH port 必须是 1-65535 的整数')
  if (!/^[a-zA-Z0-9._-]+$/.test(s.user)) errs.push('SSH user 非法')
  if (BAD_CMD.test(s.options)) errs.push('SSH 自定义选项含非法字符')
  if (s.password.includes('\n')) errs.push('SSH 密码不能包含换行')
  if (e.expTime && !/^\d{4}-\d{2}-\d{2}$/.test(e.expTime)) errs.push('过期时间必须是 YYYY-MM-DD')
  if (!Array.isArray(e.modules) || !e.modules.length) errs.push('至少需要一个模块')
  const seenId = {}
  for (const m of (e.modules || [])) {
    if (!/^[A-Za-z0-9-]+$/.test(m.id)) errs.push(`模块 ${m.name || m.id}: ID「${m.id}」只能包含字母/数字/连字符`)
    else if (seenId[m.id]) errs.push(`模块 ${m.name || m.id}: ID「${m.id}」重复（环境内须唯一）`)
    seenId[m.id] = true
    if (!m.name.trim()) errs.push('模块显示名必填')
    if (m.kind !== 'front' && m.kind !== 'server') errs.push(`模块 ${m.name || m.id}: kind 必须是 front 或 server`)
    if (m.kind === 'front') {
      const fe = validateFrontEnv(m.frontEnv || '')
      if (fe) errs.push(`${m.name || m.id}: ${fe}`)
    }
    if (m.healthCheckUrl) {
      try {
        const url = new URL(m.healthCheckUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid URL')
      } catch { errs.push(`${m.name || m.id}: 健康检查 URL 必须是 HTTP/HTTPS 地址，且不能包含用户名或密码`) }
    }
    if (!m.enabled) continue
    if (!/^[a-zA-Z0-9:_-]+$/.test(m.gradleTask)) errs.push(`${m.name || m.id}: gradle 任务非法`)
    if (m.key && !/^[a-zA-Z0-9._-]+$/.test(m.key)) errs.push(`${m.name || m.id}: -Pkey 非法`)
    if (m.extraArgs && BAD_CMD.test(m.extraArgs)) errs.push(`${m.name || m.id}: 额外参数含非法字符`)
    if (!m.localPath) errs.push(`${m.name || m.id}: 本地产物路径必填`)
    else if (BAD_PATH.test(m.localPath)) errs.push(`${m.name || m.id}: 本地产物路径含非法字符`)
    if (!m.remotePath) errs.push(`${m.name || m.id}: 远程目标路径必填`)
    else if (BAD_PATH.test(m.remotePath)) errs.push(`${m.name || m.id}: 远程目标路径含非法字符（禁止空格/引号/; & | \` $ 等）`)
    if (m.postCommand && BAD_CMD.test(m.postCommand)) errs.push(`${m.name || m.id}: 远程命令含非法字符`)
  }
  return errs
}

export { MODULE_NAME, MODULE_ORDER, DEFAULTS, templateEnv, isNewSchema, normalizeEnv }
