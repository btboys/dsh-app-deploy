import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanTarget, buildRcloneArgs } from '../server/deployment.js'

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

test('buildRcloneArgs：前端 sync 镜像 + exclude，服务端 copy 不删', () => {
  const env = { ssh: { host: 'h.example.com', port: 2222, user: 'deploy', password: 'pw', options: '' } }
  const rclone = { bin: '/usr/bin/rclone', pass: 'obscured-pw' }

  const front = buildRcloneArgs(env, mod({ kind: 'front', remotePath: '/www/fxy' }), '/proj/client/dist/', rclone)
  assert.equal(front[0], 'sync')
  assert.deepEqual(front.slice(1, 4), ['/proj/client/dist/', ':sftp:/www/fxy', '--sftp-host'])
  assert.ok(front.includes('--sftp-port') && front[front.indexOf('--sftp-port') + 1] === '2222')
  assert.ok(front.includes('--sftp-user') && front[front.indexOf('--sftp-user') + 1] === 'deploy')
  assert.ok(front.includes('--exclude') && front[front.indexOf('--exclude') + 1] === '.user.ini')
  // 密码只出现在 --sftp-pass 参数里（混淆值），供 spawn 使用
  assert.ok(front.includes('--sftp-pass') && front[front.indexOf('--sftp-pass') + 1] === 'obscured-pw')

  const server = buildRcloneArgs(env, mod({ kind: 'server', remotePath: '/opt/app' }), '/proj/build/libs/x.jar', rclone)
  assert.equal(server[0], 'copy')
  assert.ok(!server.includes('sync'))
  assert.ok(!server.includes('--exclude'))
})

test('buildRcloneArgs：无密码时取 SSH 选项里的 -i 作为密钥文件', () => {
  const env = { ssh: { host: 'h', port: 22, user: 'u', password: '', options: '-i /home/u/.ssh/id_ed25519 -o StrictHostKeyChecking=no' } }
  const args = buildRcloneArgs(env, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: null })
  assert.ok(args.includes('--sftp-key-file') && args[args.indexOf('--sftp-key-file') + 1] === '/home/u/.ssh/id_ed25519')
  assert.ok(!args.includes('--sftp-pass'))
  // 有密码时优先密码，不再推密钥
  const withPass = buildRcloneArgs(env, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: 'x' })
  assert.ok(withPass.includes('--sftp-pass'))
  assert.ok(!withPass.includes('--sftp-key-file'))
})
