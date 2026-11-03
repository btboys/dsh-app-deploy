import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// 命令执行：不抛异常，统一返回退出码与输出（Bun.spawn 的等价收敛）
function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: stdout || '', stderr: stderr || '' })
      })
    } catch {
      resolve({ code: 1, stdout: '', stderr: '' })
    }
  })
}

// 等价旧 Bun.which：找到返回绝对路径，找不到返回 null
export async function which(command) {
  const { code, stdout } = await run('which', [command])
  const found = stdout.trim()
  return code === 0 && found ? found : null
}

// 列出目录所在 git 仓库的全部 worktree（含主工作区）；非 git 仓库/失败返回空数组
export async function listWorktrees(dir) {
  const worktrees = []
  try {
    const { code, stdout } = await run('git', ['-C', dir, 'worktree', 'list', '--porcelain'])
    if (code === 0) {
      for (const block of stdout.split(/\n\n+/)) {
        const wm = block.match(/^worktree (.+)$/m)
        if (!wm) continue
        const head = (block.match(/^HEAD (.+)$/m) || [])[1] || ''
        const branch = (block.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || ''
        worktrees.push({ path: wm[1], branch, head: head.slice(0, 7) })
      }
    }
  } catch {}
  return worktrees
}

// 读取指定本地目录的 git 分支/提交信息；非 git 仓库或读取失败返回对应的标记字段
export async function readGitInfo(dir) {
  try {
    // 用 git -C 判断是否为 git 仓库；rev-parse --is-inside-work-tree 定位仓库根
    const rootProc = await run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    const rootOut = (rootProc.stdout + rootProc.stderr).trim()
    if (rootProc.code !== 0 || rootOut !== 'true') return { ok: true, isGit: false }

    // 当前分支（HEAD detached 时 rev-parse --abbrev-ref 会输出 HEAD）
    const branchProc = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = branchProc.stdout.trim()
    const detached = branch === 'HEAD'

    // 当前提交短 hash
    const commitProc = await run('git', ['-C', dir, 'rev-parse', '--short=7', 'HEAD'])
    const shortCommit = commitProc.stdout.trim()

    return { ok: true, isGit: true, branch, shortCommit, detached }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

async function fileExists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

export async function listJdks() {
  const found = new Set()
  // a) /usr/libexec/java_home -V 输出的已装 JDK 路径（2>&1）
  try {
    const p = await run('/usr/libexec/java_home', ['-V'])
    for (const m of (p.stdout + p.stderr).matchAll(/[ \t](\/(?:[^\s]+))[ \t]*$/gm)) found.add(m[1].replace(/\/$/, ''))
  } catch {}
  // b) /Library/Java/JavaVirtualMachines/*/Contents/Home
  try { for (const n of await fsp.readdir('/Library/Java/JavaVirtualMachines')) found.add(path.join('/Library/Java/JavaVirtualMachines', n, 'Contents/Home')) } catch {}
  // c) Homebrew: opt 符号链接 + Cellar 实际版本目录
  const optHome = async (base, sub) => {
    try {
      const names = await fsp.readdir(base)
      for (const n of names) {
        if (!n.startsWith('openjdk')) continue
        let cur = path.join(base, n)
        for (const s of sub) cur = path.join(cur, s)
        found.add(cur)
      }
    } catch {}
  }
  await optHome('/opt/homebrew/opt', ['libexec', 'openjdk.jdk', 'Contents', 'Home'])
  try {
    for (const n of await fsp.readdir('/opt/homebrew/Cellar')) {
      if (!n.startsWith('openjdk')) continue
      const vdir = '/opt/homebrew/Cellar/' + n
      const vers = await fsp.readdir(vdir).catch(() => [])
      for (const v of vers) found.add(path.join(vdir, v, 'libexec/openjdk.jdk/Contents/Home'))
    }
  } catch {}
  // 只保留 bin/java 真实存在者，生成友好短名
  const jdks = []
  for (const p of found) if (await fileExists(`${p}/bin/java`)) {
    const m = p.match(/\/JavaVirtualMachines\/([^/]+)\.jdk\/Contents\/Home$/)
    let label
    if (m) label = (m[1].match(/\d+(?:\.\d+)*/) || [])[1] || m[1]
    else if (p.includes('/opt/homebrew/')) {
      const v = (p.match(/openjdk@?(\d+)/) || [])[1] || (p.match(/\/(\d+(?:\.\d+)+)\/libexec/) || [])[1]
      label = v ? 'homebrew-' + v : 'homebrew'
    } else label = p.split('/').filter(Boolean).pop()
    jdks.push({ label, path: p })
  }
  // 短名去重：同名者追加版本/opt-cellar 段区分
  const seen = {}
  for (const j of jdks) seen[j.label] = (seen[j.label] || 0) + 1
  const suffix = (p, label) => {
    const segs = p.split('/').filter(Boolean)
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/\d/.test(segs[i]) && !label.includes(segs[i].replace(/[^\d.]/g, ''))) return segs[i]
    }
    return p.includes('/opt/homebrew/opt/') ? 'opt' : p.includes('/Cellar/') ? 'cellar' : ''
  }
  const taken = {}
  const out = []
  for (const j of jdks) {
    let label = j.label, n = 0
    while (taken[label]) {
      const s = suffix(j.path, label)
      label = n++ === 0 ? `${j.label} (${s})` : `${j.label} (${s}-${n})`
      if (!s) { label = `${j.label} (${j.path})`; break }
    }
    taken[label] = true
    out.push({ label, path: j.path })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

// 目录浏览：非法/不可读抛出错误，由 RPC 层转成 ok:false
export async function browseDirectory(args = {}) {
  let p = typeof args.path === 'string' ? args.path : ''
  const showHidden = args.hidden === true || args.hidden === '1' || args.hidden === 1
  if (!p) p = process.env.HOME || '/'
  if (!path.isAbsolute(p)) throw new Error('必须为绝对路径')
  p = path.resolve(p)
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true })
    const parent = path.dirname(p)
    const dirs = entries.filter(d => d.isDirectory() && (showHidden || !d.name.startsWith('.'))).map(d => d.name).sort().slice(0, 200)
    // 若当前目录属于 git 仓库（含子目录/任意 worktree），列出全部 worktree 供前端切换
    const worktrees = await listWorktrees(p)
    return { path: p, parent, dirs, worktrees }
  } catch {
    throw new Error('目录不可读')
  }
}
