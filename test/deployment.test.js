import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanTarget } from '../server/deployment.js'

const env = { projectPath: '/proj' }
const mod = (over) => ({
  id: 'm', name: 'm', kind: 'server', enabled: true,
  gradleTask: 't', key: '', extraArgs: '', localPath: '', remotePath: '/r', postCommand: '', frontEnv: '',
  ...over,
})

test('cleanTarget：front 清到 dist，server 清到 localPath 所在目录', () => {
  assert.equal(cleanTarget(env, mod({ kind: 'front', localPath: 'client/client-front/dist/' })), '/proj/client/client-front/dist')
  assert.equal(cleanTarget(env, mod({ kind: 'front', localPath: 'client/client-front/dist/fxy/' })), '/proj/client/client-front/dist')
  assert.equal(cleanTarget(env, mod({ kind: 'server', localPath: 'client/client-server/build/libs/financial-v5.jar' })), '/proj/client/client-server/build/libs')
  assert.equal(cleanTarget(env, mod({ kind: 'server', localPath: 'client/client-server/build/libs/' })), '/proj/client/client-server/build/libs')
  // projectPath 带尾斜杠也归一化
  assert.equal(cleanTarget({ projectPath: '/proj/' }, mod({ localPath: 'a/b/x.jar' })), '/proj/a/b')
})

test('cleanTarget：越界/不安全目标一律返回 null', () => {
  // front 路径没有 /dist
  assert.equal(cleanTarget(env, mod({ kind: 'front', localPath: 'client/client-front/out/' })), null)
  // 深度不足 2 级
  assert.equal(cleanTarget(env, mod({ localPath: 'dist/financial-v5.jar' })), null)
  // 含 ..
  assert.equal(cleanTarget(env, mod({ localPath: '../../outside.jar' })), null)
  // 解析后在 projectPath 之外
  assert.equal(cleanTarget(env, mod({ kind: 'front', localPath: '/other/dist/x' })), null)
  assert.equal(cleanTarget(env, mod({ kind: 'front', localPath: '' })), null)
})
