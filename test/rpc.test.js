import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig, templateEnv } from '../server/config.js'
import { initHistory } from '../server/history.js'
import { handleRpc } from '../server/rpc.js'

const DIR = await fsp.mkdtemp(path.join(tmpdir(), 'dad-rpc-'))
await initConfig({ dataDir: DIR, defaultProjectPath: '/tmp/project' })
await initHistory(DIR)

// 测试夹具：新装插件不再播种，环境由用例自己创建
function makeEnv(id, name) {
  const env = templateEnv()
  env.id = id
  env.name = name
  env.projectPath = '/tmp/project'
  env.sshs[0].host = 'localhost'
  env.modules = [{ ...env.modules[0], remotePath: '/www' }]
  return env
}

test('RPC 分发：config 初始为空列表与 empty lastBuild', async () => {
  const res = await handleRpc({ method: 'config' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.value.envs, [])
  assert.equal(res.value.defaultProjectPath, '/tmp/project')
  assert.deepEqual(res.value.lastBuild, {})
})

test('RPC 分发：非法请求/未知方法返回 ok:false', async () => {
  assert.equal((await handleRpc(null)).ok, false)
  assert.equal((await handleRpc({})).ok, false)
  const unknown = await handleRpc({ method: 'nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error, '未知方法')
})

test('saveEnv：校验失败返回多条错误用「；」拼接', async () => {
  const res = await handleRpc({ method: 'saveEnv', args: { id: 'X', name: '' } })
  assert.equal(res.ok, false)
  assert.match(res.error, /名称必填/)
  assert.match(res.error, /；/)
})

test('saveEnv / frontEnv / deleteEnv 往返', async () => {
  const created = await handleRpc({ method: 'saveEnv', args: makeEnv('fxy', '分析云') })
  assert.equal(created.ok, true)
  assert.equal(created.value.envs.length, 1)
  assert.equal(created.value.warning, '')

  const base = created.value.envs[0]
  const withFe = { ...base, modules: base.modules.map(m => m.id === 'bsFront' ? { ...m, frontEnv: 'VITE_API=1' } : m) }
  assert.equal((await handleRpc({ method: 'saveEnv', args: withFe })).ok, true)
  assert.deepEqual(await handleRpc({ method: 'frontEnv', args: { env: 'fxy', module: 'bsFront' } }), { ok: true, value: { text: 'VITE_API=1' } })
  assert.deepEqual(await handleRpc({ method: 'frontEnv', args: { env: 'fxy', module: 'bsServer' } }), { ok: true, value: { text: '' } })
  assert.equal((await handleRpc({ method: 'frontEnv', args: { env: 'nope', module: 'bsFront' } })).ok, false)

  const saved = await handleRpc({ method: 'saveEnv', args: makeEnv('tmp-env', '临时环境') })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.envs.length, 2)
  assert.equal(saved.value.envs.find(e => e.id === 'tmp-env').name, '临时环境')

  const deleted = await handleRpc({ method: 'deleteEnv', args: { id: 'tmp-env' } })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.value.envs.length, 1)
})

test('git / browse / history / clearHistory 分支', async () => {
  const git = await handleRpc({ method: 'git', args: { env: 'fxy' } })
  assert.equal(git.ok, true)
  assert.equal(git.value.isGit, false)
  assert.deepEqual(git.value.worktrees, [])
  assert.equal((await handleRpc({ method: 'git', args: { env: 'nope' } })).value.isGit, false)

  const browse = await handleRpc({ method: 'browse', args: { path: 'relative/path' } })
  assert.equal(browse.ok, false)
  assert.equal(browse.error, '必须为绝对路径')

  assert.deepEqual((await handleRpc({ method: 'history' })).value, [])
  assert.deepEqual(await handleRpc({ method: 'clearHistory' }), { ok: true, value: { ok: true } })
})

test('importEnvs：同 ID 覆盖本地、新 ID 追加，非法配置整体拒绝', async () => {
  const cfg = await handleRpc({ method: 'config' })
  const base = cfg.value.envs.find(e => e.id === 'fxy')
  const imported = [
    { ...base, name: '导入覆盖名' },
    { ...base, id: 'imp-new', name: '导入新增' },
  ]

  const res = await handleRpc({ method: 'importEnvs', args: { content: JSON.stringify(imported) } })
  assert.equal(res.ok, true)
  assert.deepEqual(res.value.overwritten, ['fxy'])
  assert.deepEqual(res.value.added, ['imp-new'])
  assert.equal(res.value.envs.length, 2)
  assert.equal(res.value.envs.find(e => e.id === 'fxy').name, '导入覆盖名')
  assert.equal(res.value.envs.find(e => e.id === 'fxy').sshs[0].host, base.sshs[0].host)
  assert.equal(res.value.envs.find(e => e.id === 'imp-new').name, '导入新增')
  // 覆盖不改变原有顺序，新环境追加到末尾
  assert.deepEqual(res.value.envs.map(e => e.id), ['fxy', 'imp-new'])

  // 兼容 { envs: [...] } 包装
  const wrapped = await handleRpc({
    method: 'importEnvs',
    args: { content: JSON.stringify({ envs: [{ ...base, id: 'imp-wrapped', name: '包装导入' }] }) },
  })
  assert.equal(wrapped.ok, true)
  assert.deepEqual(wrapped.value.added, ['imp-wrapped'])

  // 任一环境非法 → 整体拒绝且不写盘
  const badBody = JSON.stringify([{ ...base, name: '不该落盘' }, { ...base, id: 'BAD ID' }])
  const bad = await handleRpc({ method: 'importEnvs', args: { content: badBody } })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /ID/)
  const after = await handleRpc({ method: 'config' })
  assert.equal(after.value.envs.length, 3)
  assert.equal(after.value.envs.find(e => e.id === 'fxy').name, '导入覆盖名')

  assert.equal((await handleRpc({ method: 'importEnvs', args: { content: 'not json' } })).ok, false)
  assert.equal((await handleRpc({ method: 'importEnvs', args: { content: '[]' } })).ok, false)
  assert.equal((await handleRpc({ method: 'importEnvs', args: {} })).ok, false)
})
