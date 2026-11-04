import { promises as fsp } from 'node:fs'
import { getEnvs, saveEnvs, normalizeEnv, isNewSchema, templateEnv, validateEnv, frontEnvFile, getDefaultProjectPath } from './config.js'
import { getHistory, replaceHistory, HIST_LIMIT } from './history.js'
import { activeRecord } from './deployment.js'
import { listJdks, listWorktrees, readGitInfo, browseDirectory, which } from './local-tools.js'

// sshpass 无 Windows 版本；警告文案按平台给出可操作的下一步（保存/导入两处共用）
const SSHPASS_HINT = process.platform === 'win32'
  ? '但本机没有 sshpass（Windows 无此工具），部署时无法使用密码认证；请改用密钥认证（SSH 自定义选项填 -i 私钥路径，并清空密码）'
  : '但本机未安装 sshpass，部署时无法使用密码认证。请先执行: brew install hudochenkov/sshpass/sshpass'

// JSON-RPC 方法表：与旧 server.ts 的 /api/* 逐一对齐（字段名不变）
const methods = {
  config: () => {
    // lastBuild: 每个环境最后一次部署的时间与状态（history 按开始时间正序追加，遍历覆盖即为最新）
    const lastBuild = {}
    for (const r of getHistory()) lastBuild[r.envId] = { time: r.startTime, status: r.status }
    return { envs: getEnvs(), defaultProjectPath: getDefaultProjectPath(), lastBuild }
  },
  saveEnv: async (body) => {
    const b = body && typeof body === 'object' ? body : {}
    const env = normalizeEnv(
      isNewSchema(b)
        ? b
        : { ...templateEnv(), id: String(b.id || ''), name: String(b.name || ''), note: String(b.note || '') },
    )
    const errs = validateEnv(env)
    if (errs.length) throw new Error(errs.join('；'))
    const envs = getEnvs()
    const i = envs.findIndex(x => x.id === env.id)
    if (i >= 0) envs[i] = env; else envs.push(env)
    await saveEnvs()
    let warning = ''
    if (env.ssh.password && !(await which('sshpass'))) {
      warning = '已保存，' + SSHPASS_HINT
    }
    return { envs: getEnvs(), warning }
  },
  deleteEnv: async ({ id } = {}) => {
    await saveEnvs(getEnvs().filter(x => x.id !== id))
    return { envs: getEnvs() }
  },
  // 配置文件导入：同 ID 覆盖本地，其余追加；任一环境校验失败则整体拒绝（不写盘）
  importEnvs: async ({ content } = {}) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error('配置文件内容为空')
    let data
    try { data = JSON.parse(content) } catch { throw new Error('文件不是合法的 JSON') }
    if (data && !Array.isArray(data) && Array.isArray(data.envs)) data = data.envs
    if (!Array.isArray(data) || !data.length) throw new Error('配置文件中没有环境（应为环境数组）')
    const envs = getEnvs()
    const byId = new Map(envs.map(x => [x.id, x]))
    const order = envs.map(x => x.id)
    const localIds = new Set(order)
    const added = []
    const overwritten = []
    const errs = []
    data.forEach((raw, index) => {
      const b = raw && typeof raw === 'object' ? raw : {}
      const env = normalizeEnv(
        isNewSchema(b)
          ? b
          : { ...templateEnv(), id: String(b.id || ''), name: String(b.name || ''), note: String(b.note || '') },
      )
      const list = validateEnv(env)
      if (list.length) { errs.push(`环境 ${env.id || '#' + (index + 1)}: ${list.join('；')}`); return }
      if (!byId.has(env.id)) order.push(env.id)
      const bucket = localIds.has(env.id) ? overwritten : added
      if (!bucket.includes(env.id)) bucket.push(env.id)
      byId.set(env.id, env)
    })
    if (errs.length) throw new Error(errs.join('\n'))
    await saveEnvs(order.map(id => byId.get(id)))
    const touched = new Set([...added, ...overwritten])
    let warning = ''
    if (getEnvs().some(e => touched.has(e.id) && e.ssh.password) && !(await which('sshpass'))) {
      warning = '已导入，' + SSHPASS_HINT
    }
    return { envs: getEnvs(), added, overwritten, warning }
  },
  frontEnv: async ({ env: envId, module: mid } = {}) => {
    const e = getEnvs().find(x => x.id === envId)
    if (!e) throw new Error('未知环境')
    const m = e.modules.find(x => x.id === mid)
    if (!m || m.kind !== 'front') return { text: '' }
    // frontEnv 来源为模块配置；若为空，读对应 .env 文件一次作初始参考展示（绝不写回）
    if (m.frontEnv) return { text: m.frontEnv }
    const p = frontEnvFile(e, m)
    if (!p) return { text: '' }
    try { return { text: await fsp.readFile(p, 'utf8') } } catch { return { text: '' } }
  },
  jdks: () => listJdks(),
  browse: (args) => browseDirectory(args ?? {}),
  git: async ({ env: id, path: sel } = {}) => {
    const e = getEnvs().find(x => x.id === id)
    if (!e || !e.projectPath) return { ok: true, isGit: false, worktrees: [] }
    const worktrees = await listWorktrees(e.projectPath)
    let dir = e.projectPath
    if (sel) {
      if (!worktrees.some(w => w.path === sel)) throw new Error('所选路径不属于该仓库的 worktree')
      dir = sel
    }
    return { ...(await readGitInfo(dir)), worktrees }
  },
  // 执行记录查询：env 按环境过滤（空=全部），limit 条数（默认 50，上限 500），按时间倒序
  history: ({ env: envId, limit } = {}) => {
    const n = Math.min(Math.max(Number(limit) || 50, 1), HIST_LIMIT)
    const list = envId ? getHistory().filter(r => r.envId === envId) : getHistory()
    return list.slice(-n).reverse()
  },
  clearHistory: async () => {
    // 进行中的部署记录保留，其余清空
    const record = activeRecord()
    await replaceHistory(record ? [record] : [])
    return { ok: true }
  },
}

export async function handleRpc(body) {
  try {
    if (!body || typeof body !== 'object') throw new Error('非法请求')
    const method = methods[body.method]
    if (!method) throw new Error('未知方法')
    return { ok: true, value: await method(body.args) }
  } catch (error) {
    return { ok: false, error: error?.message || '请求失败' }
  }
}

export { methods }
