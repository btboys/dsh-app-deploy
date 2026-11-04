import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig } from '../server/config.js'
import { envSummaryForModel } from '../server/tools.js'
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
