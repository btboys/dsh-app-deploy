import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig, getEnvs } from '../server/config.js'
import { envSummaryForModel, saveEnvForModel } from '../server/tools.js'
import { runDeploy } from '../server/deployment.js'

test('envSummaryForModel：剥离密码，保留目标/模块关键信息', () => {
  const s = envSummaryForModel({
    id: 'fxy', name: '分析云', note: '', group: '', projectPath: '/p',
    jdkHome: '', nodeHome: '', pmPath: '',
    sshs: [{ id: 'prod', name: '生产', host: 'a.com', port: 22, user: 'root', password: 'secret', keyFile: '/k/id_rsa', options: '' }],
    modules: [{ id: 'bsServer', name: 'bs 服务端', kind: 'server', enabled: true, buildCmd: './gradlew x:bootJar', sshId: 'prod', localPath: 'x.jar', remotePath: '/r', postCommand: '', healthCheckUrl: '' }],
  })
  assert.equal(s.sshs[0].password, undefined)
  assert.equal(s.sshs[0].hasPassword, true)
  assert.equal(s.sshs[0].keyFile, '/k/id_rsa')
  assert.equal(s.modules[0].sshId, 'prod')
  assert.equal(JSON.stringify(s).includes('secret'), false)
})

test('runDeploy：未知环境/无启用模块时给出可读错误', async () => {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'dad-tools-'))
  await initConfig({ dataDir: dir, defaultProjectPath: '/tmp/project' })
  await assert.rejects(() => runDeploy('nope'), /未知环境/)
})

test('saveEnvForModel：校验失败整体拒绝不写盘，成功按 id upsert', async () => {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'dad-tools-'))
  await initConfig({ dataDir: dir, defaultProjectPath: '/tmp/project' })

  // 非法配置：坏 id + 缺模块 + 坏 host → 返回全部错误，磁盘仍是 []
  const bad = await saveEnvForModel({
    id: 'BAD ID', name: 'x', projectPath: '/p',
    sshs: [{ host: 'bad host', user: 'u' }], modules: [],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.length >= 2)
  assert.equal(getEnvs().length, 0)
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'envs.json'), 'utf8')), [])

  // 合法配置：写入并可重读
  const env = {
    id: 'cat', name: '餐饮', projectPath: '/p',
    sshs: [{ id: 'prod', name: '生产', host: 'a.com', port: 22, user: 'root', keyFile: '/k/id_rsa' }],
    modules: [{ id: 'tenantWeb', name: '租户端', kind: 'front', enabled: true, buildCmd: 'yarn workspace @catering/tenant-web build', buildDir: '', localPath: 'catering/tenant-web/dist/', remotePath: '/www/tenant/' }],
  }
  const created = await saveEnvForModel(env)
  assert.deepEqual(created, { ok: true, envId: 'cat' })
  assert.equal(getEnvs()[0].modules[0].buildCmd, 'yarn workspace @catering/tenant-web build')

  // 同 id 覆盖更新（改 buildDir），不追加
  const updated = await saveEnvForModel({ ...env, modules: [{ ...env.modules[0], buildDir: 'catering' }] })
  assert.deepEqual(updated, { ok: true, envId: 'cat' })
  assert.equal(getEnvs().length, 1)
  assert.equal(getEnvs()[0].modules[0].buildDir, 'catering')
})
