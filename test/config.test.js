import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig, getEnvs, normalizeEnv, templateEnv, validateEnv } from '../server/config.js'

async function tempDir() {
  return fsp.mkdtemp(path.join(tmpdir(), 'dad-config-'))
}

test('envs.json 不存在时用 seed/scripts-extract.json 播种', async () => {
  const dir = await tempDir()
  await initConfig({ dataDir: dir, defaultProjectPath: '/tmp/project' })

  const envs = getEnvs()
  assert.equal(envs.length, 7)
  assert.deepEqual(envs.map(e => e.id), ['fxy', 'dyx', 'jh', 'jcd', 'xl', 'xsy', 'yjy'])

  const fxy = envs[0]
  assert.equal(fxy.group, '官方')
  assert.equal(fxy.projectPath, '/tmp/project')
  assert.equal(fxy.ssh.password, '')
  assert.equal(fxy.ssh.host, '47.99.77.94')
  assert.equal(fxy.modules.length, 4)
  assert.deepEqual(fxy.modules.map(m => m.id), ['bsFront', 'bsServer', 'adminFront', 'adminServer'])
  assert.equal(fxy.modules[0].kind, 'front')
  assert.equal(fxy.modules[0].name, 'bs 前端')
  assert.equal(fxy.modules[0].key, 'fxy')
  assert.equal(fxy.modules[0].localPath, 'client/client-front/dist/fxy/')
  assert.equal(fxy.modules[1].kind, 'server')
  // jh 后端 jarLocal 是目录：补尾斜杠保留「复制内容进远程目录」语义
  assert.equal(envs[2].modules[1].localPath, 'client/client-server/build/libs/')

  const written = JSON.parse(await fsp.readFile(path.join(dir, 'envs.json'), 'utf8'))
  assert.equal(written.length, 7)
})

test('旧 schema（script/record）迁移：保留 id/name/note，补齐种子字段并重写文件', async () => {
  const dir = await tempDir()
  await fsp.writeFile(path.join(dir, 'envs.json'), JSON.stringify([
    { id: 'fxy', name: '分析云旧', note: '旧备注', script: 'update.sh' },
  ]))
  await initConfig({ dataDir: dir, defaultProjectPath: '/tmp/project' })

  const [e] = getEnvs()
  assert.equal(e.id, 'fxy')
  assert.equal(e.name, '分析云旧')
  assert.equal(e.note, '旧备注')
  assert.equal(e.group, '官方')
  assert.equal(e.ssh.host, '47.99.77.94')
  assert.equal(e.modules.length, 4)

  const written = JSON.parse(await fsp.readFile(path.join(dir, 'envs.json'), 'utf8'))
  assert.ok(written[0].ssh, '迁移后应写回新 schema')
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
  assert.equal(norm.group, '官方')
  assert.equal(norm.expTime, '2026-12-31')
  assert.deepEqual(norm.modules.map(m => m.id), ['bsFront', 'bsServer'])
  assert.equal(norm.modules[0].frontEnv, 'A=1')
  assert.equal(norm.modules[1].extraArgs, '')

  // 数组 schema：healthCheckUrl 去空格
  const arr = normalizeEnv({
    id: 'fxy', name: 'x', projectPath: '/p', ssh: { host: 'h', port: 22, user: 'u' },
    modules: [{ id: 'bsServer', kind: 'server', gradleTask: 'client:client-server:bootJar', extraArgs: '-PexpTime=2026-12-31', localPath: 'j.jar', remotePath: '/r2', healthCheckUrl: ' https://example.com/api/ ' }],
  })
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
  env.ssh.host = 'localhost'
  env.modules = [{ ...env.modules[1], extraArgs: '-PexpTime=2026-12-31', remotePath: '/app', healthCheckUrl: ' https://example.com/api/ ' }]

  const normalized = normalizeEnv(env)
  assert.deepEqual(validateEnv(normalized), [])

  const withUrl = { ...normalized, modules: [{ ...normalized.modules[0], healthCheckUrl: 'file:///etc/passwd' }] }
  assert.ok(validateEnv(withUrl).some(e => e.includes('健康检查 URL')))

  assert.ok(validateEnv({ ...normalized, id: 'BAD_ID' }).some(e => e.includes('ID 只能是')))
  assert.ok(validateEnv({ ...normalized, name: '   ' }).some(e => e.includes('名称必填')))
  assert.ok(validateEnv({ ...normalized, projectPath: 'relative/path' }).some(e => e.includes('项目路径必须是绝对路径')))
  assert.ok(validateEnv({ ...normalized, projectPath: '/bad path' }).some(e => e.includes('项目路径含非法字符')))
  assert.ok(validateEnv({ ...normalized, ssh: { ...normalized.ssh, port: 0 } }).some(e => e.includes('SSH port')))
  assert.ok(validateEnv({ ...normalized, ssh: { ...normalized.ssh, host: 'bad host' } }).some(e => e.includes('SSH host 非法')))
  assert.ok(validateEnv({ ...normalized, ssh: { ...normalized.ssh, options: '; rm -rf /' } }).some(e => e.includes('SSH 自定义选项')))
  assert.ok(validateEnv({ ...normalized, expTime: '2026/12/31' }).some(e => e.includes('过期时间')))
  assert.ok(validateEnv({ ...normalized, modules: [] }).some(e => e.includes('至少需要一个模块')))

  const dup = { ...normalized, modules: [normalized.modules[0], { ...normalized.modules[0] }] }
  assert.ok(validateEnv(dup).some(e => e.includes('重复')))

  const badFrontEnv = { ...normalized, modules: [{ ...normalized.modules[0], kind: 'front', frontEnv: 'hello world' }] }
  assert.ok(validateEnv(badFrontEnv).some(e => e.includes('前端 .env')))

  const badTask = { ...normalized, modules: [{ ...normalized.modules[0], gradleTask: 'a b' }] }
  assert.ok(validateEnv(badTask).some(e => e.includes('gradle 任务非法')))

  const noRemote = { ...normalized, modules: [{ ...normalized.modules[0], remotePath: '' }] }
  assert.ok(validateEnv(noRemote).some(e => e.includes('远程目标路径必填')))
})
