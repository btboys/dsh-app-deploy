import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig } from '../server/config.js'
import { initHistory } from '../server/history.js'
import { handleRpc } from '../server/rpc.js'

const DIR = await fsp.mkdtemp(path.join(tmpdir(), 'dad-rpc-'))
await initConfig({ dataDir: DIR, defaultProjectPath: '/tmp/project' })
await initHistory(DIR)

test('RPC 分发：config 返回环境列表与 empty lastBuild', async () => {
  const res = await handleRpc({ method: 'config' })
  assert.equal(res.ok, true)
  assert.equal(res.value.envs.length, 7)
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
  const cfg = await handleRpc({ method: 'config' })
  const base = cfg.value.envs.find(e => e.id === 'fxy')
  const env = { ...base, id: 'tmp-env', name: '临时环境', group: '' }

  const saved = await handleRpc({ method: 'saveEnv', args: env })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.envs.length, 8)
  assert.equal(saved.value.envs.find(e => e.id === 'tmp-env').name, '临时环境')
  assert.equal(saved.value.warning, '')

  const withFe = { ...env, modules: env.modules.map(m => m.id === 'bsFront' ? { ...m, frontEnv: 'VITE_API=1' } : m) }
  assert.equal((await handleRpc({ method: 'saveEnv', args: withFe })).ok, true)
  assert.deepEqual(await handleRpc({ method: 'frontEnv', args: { env: 'tmp-env', module: 'bsFront' } }), { ok: true, value: { text: 'VITE_API=1' } })
  assert.deepEqual(await handleRpc({ method: 'frontEnv', args: { env: 'tmp-env', module: 'bsServer' } }), { ok: true, value: { text: '' } })
  assert.equal((await handleRpc({ method: 'frontEnv', args: { env: 'nope', module: 'bsFront' } })).ok, false)

  const deleted = await handleRpc({ method: 'deleteEnv', args: { id: 'tmp-env' } })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.value.envs.length, 7)
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
