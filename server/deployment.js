import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { getEnvs } from './config.js'
import { getHistory, saveHistory, LOGTAIL_CHARS } from './history.js'
import { listWorktrees, which } from './local-tools.js'
import { checkHealth } from './health-check.js'

// ---------- SSE 日志与部署锁（同一时刻只允许一个部署） ----------
let running = null // { clients: Set<ServerResponse>, done, label, record, logTail, lastCode }
let activeProc = null // 当前正在执行的子进程（gradlew/rsync/ssh），插件卸载时终止

function sseWrite(res, chunk) {
  if (!res || res.writableEnded || res.destroyed) return
  try {
    res.write(chunk)
    // dsh Web 宿主对 text/event-stream 也开 gzip，事件会积压在 zlib 缓冲里不刷新；
    // compression 中间件在此响应上挂了 res.flush，写完立刻冲刷（未挂中间件时为 no-op）
    res.flush?.()
  } catch {}
}

function broadcast(text) {
  if (!running) return
  // 累积尾部日志，写入执行记录（按字符截断到整行，避免频繁分行开销）
  running.logTail += text
  if (running.logTail.length > LOGTAIL_CHARS) {
    const cut = running.logTail.slice(-LOGTAIL_CHARS)
    running.logTail = cut.slice(cut.indexOf('\n') + 1 || 0)
  }
  // 带记录 ID 作为 SSE id：断线重连时浏览器回传 Last-Event-ID，服务端据此加入原部署而非重新开始
  const idLine = running.record ? `id: ${running.record.id}\n` : ''
  for (const c of running.clients) sseWrite(c, `${idLine}data: ${JSON.stringify(text)}\n\n`)
}

// SSE 心跳（注释行，不进日志）：防止长静默期连接被中间层断开，浏览器也能感知连接活性
setInterval(() => {
  if (!running || running.done) return
  for (const c of running.clients) sseWrite(c, ': hb\n\n')
}, 15000).unref()

// 插件卸载/重载时终止正在运行的构建子进程，避免 gradlew 成为孤儿继续跑；
// gradlew 客户端被杀后，daemon 端会因连接断开取消本次构建
export function killActiveProcess() {
  try { activeProc?.kill() } catch {}
  activeProc = null
}

// 运行一步子进程并流式广播输出；返回退出码（启动失败为 127）
function runStep(label, args, opts = {}) {
  broadcast(`>>> ${label}\n`)
  return new Promise((resolve) => {
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      activeProc = null
      resolve(code)
    }
    let child
    try {
      child = spawn(args[0], args.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
      activeProc = child
    } catch (err) {
      broadcast(`启动失败: ${String(err)}\n`)
      return resolve(127)
    }
    child.stdout.on('data', (chunk) => broadcast(chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => broadcast(chunk.toString('utf8')))
    child.once('error', (err) => { broadcast(`启动失败: ${String(err)}\n`); finish(127) })
    child.once('close', (code) => finish(code ?? 1))
  })
}

// 部署结束后尽力停掉 Gradle daemon：daemon 是常驻 JVM（默认空闲 3 小时才退出），
// 多次构建复用后类加载器/缓存累积会把堆耗尽（报 "Daemon will expire ... running out of JVM heap space"）。
// 无 daemon 时 --stop 也返回 0；任何失败都忽略，不影响部署结果。
async function stopGradleDaemon(env) {
  try {
    const stopEnv = env.jdkHome ? { ...process.env, JAVA_HOME: env.jdkHome } : process.env
    await new Promise((resolve) => {
      const p = spawn('./gradlew', ['--stop'], { cwd: env.projectPath, env: stopEnv, stdio: 'ignore' })
      p.once('error', resolve)
      p.once('close', resolve)
    })
    broadcast('>>> 已停止 Gradle daemon，释放构建内存\n')
  } catch {}
}

function finishDeploy(code) {
  broadcast(`\n>>> ${code === 0 ? '部署完成' : '部署失败'}，退出码 ${code}\n`)
  if (!running) return
  const idLine = running.record ? `id: ${running.record.id}\n` : ''
  for (const c of running.clients) {
    sseWrite(c, `${idLine}event: done\ndata: ${JSON.stringify({ code })}\n\n`)
    try { c.end() } catch {}
  }
  // 落盘执行记录（failedModule/failedStep 由 runDeployment 在调用前写入）
  const r = running.record
  if (r) {
    r.endTime = Date.now()
    r.durationMs = r.endTime - r.startTime
    r.exitCode = code
    r.status = code === 0 ? 'success' : 'failed'
    r.logTail = running.logTail
    saveHistory().catch(() => {})
  }
  running.done = true
  running.lastCode = code // 保留会话供断线重连获取最终结果
  running.clients.clear()
}

// 递归删除（含隐藏文件）；lstat 不存在时抛出 ENOENT 由调用方处理
async function rmTree(p) {
  const st = await fsp.lstat(p)
  if (st.isDirectory()) {
    for (const ent of await fsp.readdir(p)) await rmTree(path.join(p, ent))
    await fsp.rmdir(p)
  } else {
    await fsp.unlink(p)
  }
}

// 推导构建前要清空的目录（相对 projectPath 的绝对路径），不满足安全约束返回 null
// 前端（kind=front）：取 localPath 中 dist 及之前部分（client/client-front/dist/fxy/ → …/dist）
// 服务端（kind=server）：清空 localPath 所在目录（…/build/libs/financial-v5.jar → …/build/libs；目录型 localPath 清空自身）
export function cleanTarget(env, m) {
  const pp = env.projectPath.replace(/\/+$/, '')
  const local = m.localPath.startsWith('/') ? m.localPath : `${pp}/${m.localPath}`
  let rel
  if (m.kind === 'front') {
    const i = local.lastIndexOf('/dist')
    if (i < 0) return null
    rel = local.slice(0, i + 5)
  } else {
    const isDir = local.endsWith('/')
    const p = local.replace(/\/+$/, '')
    rel = isDir ? p : p.slice(0, p.lastIndexOf('/'))
  }
  const clean = rel.replace(/\/+/g, '/').replace(/\/+$/, '')
  // 安全约束：不含 ..、解析后须在 projectPath 内、深度 ≥ projectPath 下 2 级
  if (!clean || clean.includes('..')) return null
  const resolved = clean.startsWith('/') ? clean : `${pp}/${clean}`
  if (!resolved.startsWith(pp + '/')) return null
  const depth = resolved.slice(pp.length + 1).split('/').length
  if (depth < 2) return null
  return resolved
}

// 构建前清理构建目录；返回 0 成功/跳过，非 0 中止部署
async function cleanBuildDir(env, m) {
  const dir = cleanTarget(env, m)
  if (!dir) {
    broadcast(`[${m.name}] 警告: 无法推导安全的清理目标，跳过清理构建目录\n`)
    return 0
  }
  broadcast(`>>> [${m.name}] 清理构建目录: ${dir}\n`)
  try {
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) { broadcast(`[${m.name}] 警告: 清理目标不是目录，跳过\n`); return 0 }
    for (const ent of await fsp.readdir(dir)) await rmTree(path.join(dir, ent))
    return 0
  } catch (err) {
    if (err?.code === 'ENOENT') return 0 // 目录不存在则跳过
    broadcast(`[${m.name}] 清理失败: ${String(err)}，中止部署\n`)
    return 1
  }
}

// 返回退出码与失败阶段（清理/构建/同步/远程命令），用于执行记录
export async function deployModule(env, m, sshBase, dest, sshpass) {
  // 0. 清理构建目录（恢复原 update-*.sh 行为）
  const c0 = await cleanBuildDir(env, m)
  if (c0 !== 0) return { code: c0, step: '清理' }

  // 1. 构建
  const buildArgs = ['./gradlew', m.gradleTask]
  if (m.key) buildArgs.push(`-Pkey=${m.key}`)
  if (m.extraArgs) buildArgs.push(...m.extraArgs.trim().split(/\s+/).filter(Boolean))
  if (m.kind === 'server' && env.expTime) buildArgs.push(`-PexpTime=${env.expTime}`)
  const jdkNote = env.jdkHome ? `（JAVA_HOME=${env.jdkHome}）` : ''
  const envForGradle = env.jdkHome ? { ...process.env, JAVA_HOME: env.jdkHome } : { ...process.env }
  // 前端模块：把 frontEnv（KEY=VALUE 多行）注入子进程 env；Vite loadEnv 对 process.env 中 VITE_ 前缀变量优先级最高，会覆盖 .env 文件
  if (m.kind === 'front') {
    for (const line of (m.frontEnv || '').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim()
      if (/^[A-Za-z0-9_]+$/.test(k)) envForGradle[k] = v
    }
  }
  const c1 = await runStep(`[${m.name}] 构建: ${buildArgs.join(' ')} ${jdkNote}`, buildArgs, { cwd: env.projectPath, env: envForGradle })
  if (c1 !== 0) { broadcast(`[${m.name}] 构建失败，退出码 ${c1}，中止部署\n`); return { code: c1, step: '构建' } }

  // 2. rsync（--delete 仅用于前端模块，与原脚本行为一致）
  const local = m.localPath.startsWith('/') ? m.localPath : `${env.projectPath.replace(/\/+$/, '')}/${m.localPath}`
  const rsyncArgs = ['rsync', '-r', '-t', '-z', '-e', sshpass ? `sshpass -e ${sshBase}` : sshBase]
  const isFront = m.kind === 'front'
  if (isFront) rsyncArgs.push('--delete', '--exclude=.user.ini') // 排除宝塔 .user.ini（chattr +i 锁定，--delete 无法删除且会导致退出码非 0）
  rsyncArgs.push(local, `${dest}:${m.remotePath}`)
  const rsyncEnv = sshpass ? { ...process.env, SSHPASS: env.ssh.password } : process.env
  const c2 = await runStep(`[${m.name}] rsync ${local} → ${dest}:${m.remotePath}${isFront ? '（--delete）' : ''}`, rsyncArgs, { env: rsyncEnv })
  if (c2 !== 0) { broadcast(`[${m.name}] 同步失败，退出码 ${c2}，中止部署\n`); return { code: c2, step: '同步' } }

  // 3. ssh 远程命令
  if (m.postCommand.trim()) {
    const sshArgs = []
    if (sshpass) sshArgs.push('sshpass', '-e')
    sshArgs.push('ssh', '-p', String(env.ssh.port))
    if (env.ssh.options) sshArgs.push(...env.ssh.options.trim().split(/\s+/).filter(Boolean))
    sshArgs.push(dest, m.postCommand.trim())
    const c3 = await runStep(`[${m.name}] 远程执行: ${m.postCommand.trim()}`, sshArgs, { env: rsyncEnv })
    if (c3 !== 0) { broadcast(`[${m.name}] 远程命令失败，退出码 ${c3}，中止部署\n`); return { code: c3, step: '远程命令' } }
  }
  if (!await checkHealth(m.healthCheckUrl || '', message => broadcast(`[${m.name}] ${message}`))) {
    return { code: 1, step: '健康检查' }
  }
  return { code: 0, step: null }
}

async function runDeployment(env, mods) {
  let code = 1
  try {
    const sshpass = env.ssh.password ? await which('sshpass') : null
    if (env.ssh.password && !sshpass) {
      broadcast('错误: 配置了 SSH 密码但本机没有 sshpass。请先安装: brew install hudochenkov/sshpass/sshpass\n')
      code = 127
    } else {
      const sshBase = `ssh -p ${env.ssh.port}${env.ssh.options ? ' ' + env.ssh.options : ''}`
      const dest = `${env.ssh.user}@${env.ssh.host}`
      code = 0
      for (const m of mods) {
        if (!m.enabled) { broadcast(`[跳过] ${m.name} 已禁用\n`); continue }
        const res = await deployModule(env, m, sshBase, dest, sshpass)
        if (res.code !== 0) {
          if (running?.record) { running.record.failedModule = m.name; running.record.failedStep = res.step }
          code = res.code
          break
        }
      }
    }
  } catch (err) {
    broadcast(`部署异常: ${String(err)}\n`)
    code = 1
  }
  await stopGradleDaemon(env) // 无论成败都停掉 daemon，避免堆累积
  finishDeploy(code)
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

export async function handleDeploy(req, res, url) {
  const bad = (error) => sendJson(res, 400, { error })
  const env = getEnvs().find(e => e.id === url.searchParams.get('env'))
  if (!env) return bad('未知环境')
  // 可选 path：前端在 git 信息条临时选择的构建 worktree（不写回配置）；必须等于项目路径或属于该仓库 worktree 列表
  let runEnv = env
  const selPath = url.searchParams.get('path') || ''
  if (selPath) {
    const wts = await listWorktrees(env.projectPath)
    if (!wts.some(w => w.path === selPath)) return bad('所选构建路径不属于该仓库的 worktree')
    if (selPath !== env.projectPath.replace(/\/+$/, '')) runEnv = { ...env, projectPath: selPath }
  }
  const orderIds = (url.searchParams.get('modules') || '').split(',').filter(Boolean)
  const want = new Set(orderIds)
  if (!want.size) return bad('未指定模块')
  // 按请求中 modules 参数给出的顺序筛选（前端已按用户拖动后的执行顺序提交），保证按照界面编排的顺序执行
  const ordered = env.modules.filter(m => m.enabled && want.has(m.id))
  const mods = orderIds.map(id => ordered.find(m => m.id === id)).filter(m => !!m)
  if (!mods.length) return bad('所选模块在环境中均不可用或已禁用')
  if (!env.ssh.host || !env.ssh.user) return bad('SSH 配置不完整')

  const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
  const lastEventId = req.headers['last-event-id']
  const drop = () => { if (running) running.clients.delete(res) }
  const startSse = () => {
    res.writeHead(200, sseHeaders)
    res.flushHeaders()
    req.on('close', drop)
    req.on('error', drop)
  }

  // EventSource 断线自动重连（带 Last-Event-ID=部署记录 ID）：只加入对应部署，绝不重复触发新部署
  if (lastEventId) {
    if (running && running.record && running.record.id === lastEventId) {
      startSse()
      sseWrite(res, `event: replay\ndata: ${JSON.stringify(running.logTail)}\n\n`)
      if (running.done) {
        // 部署已结束：回放日志后直接发最终结果
        sseWrite(res, `id: ${lastEventId}\nevent: done\ndata: ${JSON.stringify({ code: running.lastCode })}\n\n`)
        res.end()
      } else {
        running.clients.add(res)
        broadcast(`（重连加入部署: ${running.label}）\n`)
      }
      return
    }
    // 对应部署已不存在（如服务已重启）：204 告知浏览器停止重连
    res.writeHead(204)
    res.end()
    return
  }

  if (!running || running.done) {
    startSse()
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      envId: env.id, envName: env.name,
      modules: mods.map(m => ({ id: m.id, name: m.name })),
      startTime: Date.now(), endTime: null, durationMs: null,
      status: 'running', exitCode: null, failedModule: null, failedStep: null, logTail: '',
    }
    getHistory().push(rec)
    saveHistory().catch(() => {})
    running = { clients: new Set([res]), done: false, label: `${env.name} / ${mods.map(m => m.name).join('+')}`, record: rec, logTail: '', lastCode: null }
    broadcast(`>>> 开始部署 [${env.name} / ${mods.map(m => m.name).join('+')}]\n`)
    if (runEnv !== env) broadcast(`>>> 使用临时构建路径（worktree）: ${runEnv.projectPath}\n`)
    runDeployment(runEnv, mods) // 异步执行，不阻塞
  } else {
    // 新浏览器标签页加入：先回放已有日志，再接收后续输出
    startSse()
    sseWrite(res, `event: replay\ndata: ${JSON.stringify(running.logTail)}\n\n`)
    running.clients.add(res)
    broadcast(`（已加入正在进行的部署: ${running.label}）\n`)
  }
}

export function activeRecord() { return running && !running.done ? running.record : null }
