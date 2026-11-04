import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig, getEnvs, normalizeEnv, templateEnv, validateEnv, instanceList } from '../server/config.js'

async function tempDir() {
  return fsp.mkdtemp(path.join(tmpdir(), 'dad-config-'))
}

test('新装插件不播种：envs.json 缺失时初始化为空数组', async () => {
  const dir = await tempDir()
  await initConfig({ dataDir: dir, defaultProjectPath: '/tmp/project' })

  assert.deepEqual(getEnvs(), [])
  const written = JSON.parse(await fsp.readFile(path.join(dir, 'envs.json'), 'utf8'))
  assert.deepEqual(written, [])
})

test('旧 schema（script/record）迁移：保留 id/name/note，补齐空字段并重写文件', async () => {
  const dir = await tempDir()
  await fsp.writeFile(path.join(dir, 'envs.json'), JSON.stringify([
    { id: 'fxy', name: '分析云旧', note: '旧备注', script: 'update.sh' },
  ]))
  await initConfig({ dataDir: dir, defaultProjectPath: '/tmp/project' })

  const [e] = getEnvs()
  assert.equal(e.id, 'fxy')
  assert.equal(e.name, '分析云旧')
  assert.equal(e.note, '旧备注')
  assert.equal(e.group, '')
  assert.equal(e.sshs[0].host, '')
  assert.equal(e.projectPath, '/tmp/project')
  assert.equal(e.modules.length, 4)

  const written = JSON.parse(await fsp.readFile(path.join(dir, 'envs.json'), 'utf8'))
  assert.ok(written[0].sshs, '迁移后应写回新 schema')
  assert.equal(written[0].script, undefined)
  assert.equal(written[0].modules.length, 4)
})

test('normalizeEnv：record 模块转数组、frontEnv 迁移、-PexpTime 提取、healthCheckUrl 去空格', () => {
  const norm = normalizeEnv({
    id: 'fxy', name: 'x', projectPath: '/p',
    ssh: { host: 'h', port: 2222, user: 'u' },
    frontEnv: { bs: 'A=1', admin: 'B=2' },
    modules: {
      bsFront: { gradleTask: 'client:client-front:dist', localPath: 'd/', remotePath: '/r' },
      bsServer: { gradleTask: 'client:client-server:bootJar', extraArgs: '-PexpTime=2026-12-31', localPath: 'j.jar', remotePath: '/r2', healthCheckUrl: ' https://example.com/api/ ' },
    },
  })
  assert.equal(norm.group, '')
  assert.equal(norm.expTime, '2026-12-31')
  assert.deepEqual(norm.modules.map(m => m.id), ['bsFront', 'bsServer'])
  assert.equal(norm.modules[0].frontEnv, 'A=1')
  assert.equal(norm.modules[1].buildCmd, './gradlew client:client-server:bootJar')

  // 数组 schema：healthCheckUrl 去空格
  const arr = normalizeEnv({
    id: 'fxy', name: 'x', projectPath: '/p', ssh: { host: 'h', port: 22, user: 'u' },
    modules: [{ id: 'bsServer', kind: 'server', gradleTask: 'client:client-server:bootJar', extraArgs: '-PexpTime=2026-12-31', localPath: 'j.jar', remotePath: '/r2', healthCheckUrl: ' https://example.com/api/ ' }],
  })
  assert.equal(arr.modules[0].buildCmd, './gradlew client:client-server:bootJar')
  assert.equal(arr.expTime, '2026-12-31')
  assert.equal(arr.modules[0].healthCheckUrl, 'https://example.com/api/')
  // 幂等：再归一化一次结果不变
  assert.deepEqual(normalizeEnv(arr), arr)
})

test('validateEnv：合法环境零错误，非法字段逐条报出', async () => {
  await initConfig({ dataDir: await tempDir(), defaultProjectPath: '/tmp/project' })
  const env = templateEnv()
  env.id = 'test'
  env.name = '测试'
  env.sshs[0].host = 'localhost'
  env.modules = [{ ...env.modules[1], buildCmd: './gradlew client:client-server:bootJar -PexpTime=2026-12-31', remotePath: '/app', healthCheckUrl: ' https://example.com/api/ ' }]

  const normalized = normalizeEnv(env)
  assert.deepEqual(validateEnv(normalized), [])

  const withUrl = { ...normalized, modules: [{ ...normalized.modules[0], healthCheckUrl: 'file:///etc/passwd' }] }
  assert.ok(validateEnv(withUrl).some(e => e.includes('健康检查 URL')))

  assert.ok(validateEnv({ ...normalized, id: 'BAD_ID' }).some(e => e.includes('ID 只能是')))
  assert.ok(validateEnv({ ...normalized, name: '   ' }).some(e => e.includes('名称必填')))
  assert.ok(validateEnv({ ...normalized, projectPath: 'relative/path' }).some(e => e.includes('项目路径必须是绝对路径')))
  assert.ok(validateEnv({ ...normalized, projectPath: '/bad path' }).some(e => e.includes('项目路径含非法字符')))

  // Windows 盘符路径视为绝对路径（\ 与 / 均可）
  const winPath = { ...normalized, projectPath: 'C:\\work\\proj', jdkHome: 'C:\\Java\\jdk-17' }
  assert.deepEqual(validateEnv(winPath).filter(e => e.includes('路径')), [])
  const winPathSlash = { ...normalized, projectPath: 'D:/work/proj', jdkHome: '' }
  assert.deepEqual(validateEnv(winPathSlash).filter(e => e.includes('项目路径')), [])
  assert.ok(validateEnv({ ...normalized, nodeHome: 'relative/node' }).some(e => e.includes('Node 路径必须是绝对路径')))
  assert.ok(validateEnv({ ...normalized, nodeHome: '/opt/node 22' }).some(e => e.includes('Node 路径含非法字符')))
  assert.ok(validateEnv({ ...normalized, nodeOptions: '--max-old-space-size=4096; rm -rf /' }).some(e => e.includes('Node options')))
  const withNode = { ...normalized, nodeHome: '/usr/local/n/versions/node/22.23.1', nodeOptions: '--max-old-space-size=4096' }
  assert.deepEqual(validateEnv(withNode), [])
  // 包管理器路径 + 环境级构建环境变量
  assert.ok(validateEnv({ ...normalized, pmPath: 'relative/pnpm' }).some(e => e.includes('包管理器路径必须是绝对路径')))
  assert.ok(validateEnv({ ...normalized, pmPath: '/opt/home brew/pnpm' }).some(e => e.includes('包管理器路径含非法字符')))
  assert.ok(validateEnv({ ...normalized, buildEnv: 'hello world' }).some(e => e.includes('构建环境变量')))
  const withPm = { ...normalized, pmPath: '/opt/homebrew/bin/pnpm', buildEnv: 'CI=true\n# 注释\nVITE_FLAG=1' }
  assert.deepEqual(validateEnv(withPm), [])
  assert.equal(normalizeEnv(withPm).pmPath, '/opt/homebrew/bin/pnpm')
  assert.ok(validateEnv({ ...normalized, projectPath: 'C:relpath' }).some(e => e.includes('项目路径必须是绝对路径')))
  assert.ok(validateEnv({ ...normalized, sshs: normalized.sshs.map((s, i) => (i === 0 ? { ...s, port: 0 } : s)) }).some(e => e.includes('port 必须是')))
  assert.ok(validateEnv({ ...normalized, sshs: normalized.sshs.map((s, i) => (i === 0 ? { ...s, host: 'bad host' } : s)) }).some(e => e.includes('host 非法')))
  assert.ok(validateEnv({ ...normalized, sshs: normalized.sshs.map((s, i) => (i === 0 ? { ...s, options: '; rm -rf /' } : s)) }).some(e => e.includes('自定义选项')))
  assert.ok(validateEnv({ ...normalized, expTime: '2026/12/31' }).some(e => e.includes('过期时间')))
  assert.ok(validateEnv({ ...normalized, modules: [] }).some(e => e.includes('至少需要一个模块')))

  const dup = { ...normalized, modules: [normalized.modules[0], { ...normalized.modules[0] }] }
  assert.ok(validateEnv(dup).some(e => e.includes('重复')))

  const badFrontEnv = { ...normalized, modules: [{ ...normalized.modules[0], kind: 'front', frontEnv: 'hello world' }] }
  assert.ok(validateEnv(badFrontEnv).some(e => e.includes('前端 .env')))

  const noCmd = { ...normalized, modules: [{ ...normalized.modules[0], buildCmd: ' ' }] }
  assert.ok(validateEnv(noCmd).some(e => e.includes('构建命令必填')))

  const badCmd = { ...normalized, modules: [{ ...normalized.modules[0], buildCmd: 'mvn test; rm -rf /' }] }
  assert.ok(validateEnv(badCmd).some(e => e.includes('构建命令含非法字符')))

  // 通用构建命令：maven / 前端均合法
  const mvn = { ...normalized, modules: [{ ...normalized.modules[0], buildCmd: 'mvn -DskipTests package' }] }
  assert.deepEqual(validateEnv(mvn), [])
  const npm = { ...normalized, modules: [{ ...normalized.modules[0], kind: 'front', buildCmd: 'npm run build' }] }
  assert.deepEqual(validateEnv(npm), [])

  const noRemote = { ...normalized, modules: [{ ...normalized.modules[0], remotePath: '' }] }
  assert.ok(validateEnv(noRemote).some(e => e.includes('远程目标路径必填')))

  // 多 SSH 目标：合法零错误；模块 sshId 不存在报错
  const multi = normalizeEnv({
    id: 'fxy', name: 'x', projectPath: '/p',
    sshs: [
      { id: 'prod', name: '生产', host: 'a.example.com', port: 22, user: 'root' },
      { id: 'test', name: '测试', host: 'b.example.com', port: 2222, user: 'deploy', password: 'pw' },
    ],
    modules: [{ id: 'm1', kind: 'server', buildCmd: './gradlew t', sshId: 'test', localPath: 'j.jar', remotePath: '/r' }],
  })
  assert.deepEqual(validateEnv(multi), [])
  assert.ok(validateEnv({ ...multi, modules: [{ ...multi.modules[0], sshId: 'nope' }] }).some(e => e.includes('SSH 目标「nope」不存在')))

  // 多实例：合法零错误；实例目标不存在 / 探活 URL 非法报错；instanceList 展开与回落
  const instEnv = normalizeEnv({
    id: 'fxy', name: 'x', projectPath: '/p',
    sshs: [
      { id: 'n1', name: '节点1', host: 'a.com', port: 22, user: 'root' },
      { id: 'n2', name: '节点2', host: 'b.com', port: 22, user: 'root' },
    ],
    modules: [{
      id: 'bsServer', kind: 'server', buildCmd: './gradlew t', localPath: 'j.jar', remotePath: '/r',
      instances: [
        { sshId: 'n1', healthCheckUrl: 'https://a.com/api/' },
        { sshId: 'n2' }, // URL 回落到模块级
      ],
      healthCheckUrl: 'https://shared.com/api/',
    }],
  })
  assert.deepEqual(validateEnv(instEnv), [])
  assert.ok(validateEnv({ ...instEnv, modules: [{ ...instEnv.modules[0], instances: [{ sshId: 'nope' }] }] }).some(e => e.includes('实例1 的 SSH 目标')))
  assert.ok(validateEnv({ ...instEnv, modules: [{ ...instEnv.modules[0], instances: [{ sshId: 'n1', healthCheckUrl: 'ftp://x' }] }] }).some(e => e.includes('实例1 的健康检查 URL')))
  const list = instanceList(instEnv, instEnv.modules[0])
  assert.equal(list.length, 2)
  assert.equal(list[0].target.host, 'a.com')
  assert.equal(list[1].target.host, 'b.com')
  assert.equal(list[1].healthCheckUrl, 'https://shared.com/api/')
  // 无实例 = 单实例（模块默认目标）
  const single = instanceList(instEnv, { ...instEnv.modules[0], instances: [], sshId: 'n2' })
  assert.equal(single.length, 1)
  assert.equal(single[0].target.host, 'b.com')
})
