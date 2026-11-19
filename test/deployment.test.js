import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cleanTarget, buildRcloneArgs, sshProxyTokens, sshProxyShellArg, buildSshBase, testSsh } from '../server/deployment.js'

const env = { projectPath: '/proj' }
const mod = (over) => ({
  id: 'm', name: 'm', kind: 'server', enabled: true,
  buildCmd: './gradlew t', localPath: '', remotePath: '/r', postCommand: '', frontEnv: '',
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

  const front = buildRcloneArgs(env.ssh, mod({ kind: 'front', remotePath: '/www/fxy' }), '/proj/client/dist/', rclone)
  assert.equal(front[0], 'sync')
  assert.deepEqual(front.slice(1, 4), ['/proj/client/dist/', ':sftp:/www/fxy', '--sftp-host'])
  assert.ok(front.includes('--sftp-port') && front[front.indexOf('--sftp-port') + 1] === '2222')
  assert.ok(front.includes('--sftp-user') && front[front.indexOf('--sftp-user') + 1] === 'deploy')
  assert.ok(front.includes('--exclude') && front[front.indexOf('--exclude') + 1] === '.user.ini')
  // 密码只出现在 --sftp-pass 参数里（混淆值），供 spawn 使用
  assert.ok(front.includes('--sftp-pass') && front[front.indexOf('--sftp-pass') + 1] === 'obscured-pw')

  const server = buildRcloneArgs(env.ssh, mod({ kind: 'server', remotePath: '/opt/app' }), '/proj/build/libs/x.jar', rclone)
  assert.equal(server[0], 'copy')
  assert.ok(!server.includes('sync'))
  assert.ok(!server.includes('--exclude'))
})

test('buildRcloneArgs：无密码时取 SSH 选项里的 -i 作为密钥文件', () => {
  const env = { ssh: { host: 'h', port: 22, user: 'u', password: '', options: '-i /home/u/.ssh/id_ed25519 -o StrictHostKeyChecking=no' } }
  const args = buildRcloneArgs(env.ssh, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: null })
  assert.ok(args.includes('--sftp-key-file') && args[args.indexOf('--sftp-key-file') + 1] === '/home/u/.ssh/id_ed25519')
  assert.ok(!args.includes('--sftp-pass'))
  // 密码与私钥可同时存在（与 ssh/rsync 路径行为一致，rclone 依次尝试）
  const withPass = buildRcloneArgs(env.ssh, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: 'x' })
  assert.ok(withPass.includes('--sftp-pass'))
  assert.ok(withPass.includes('--sftp-key-file') && withPass[withPass.indexOf('--sftp-key-file') + 1] === '/home/u/.ssh/id_ed25519')
  // 专用 keyFile 字段优先于 options 里的 -i
  const withKeyFile = buildRcloneArgs({ host: 'h', port: 22, user: 'u', password: '', keyFile: '/k/id_rsa', options: '-i /other/key' }, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: null })
  assert.ok(withKeyFile.includes('--sftp-key-file') && withKeyFile[withKeyFile.indexOf('--sftp-key-file') + 1] === '/k/id_rsa')
})

test('sshProxyTokens：直连为空；跳板/socks5/http 生成 ProxyCommand', () => {
  assert.deepEqual(sshProxyTokens({}), [])
  assert.deepEqual(sshProxyTokens({ proxyType: '' }), [])
  // 跳板：默认端口 22 与默认 user root，可带跳板私钥
  assert.deepEqual(
    sshProxyTokens({ proxyType: 'jump', jumpHost: 'bastion.example.com' }),
    ['-o', 'ProxyCommand=ssh -p 22 -o BatchMode=yes -W %h:%p root@bastion.example.com'],
  )
  assert.deepEqual(
    sshProxyTokens({ proxyType: 'jump', jumpHost: 'b.com', jumpPort: 2222, jumpUser: 'ops', jumpKeyFile: '/k/bastion' }),
    ['-o', 'ProxyCommand=ssh -p 2222 -o BatchMode=yes -i /k/bastion -W %h:%p ops@b.com'],
  )
  // socks5/http：默认端口 1080/8080，host 未配置时不生成
  assert.deepEqual(
    sshProxyTokens({ proxyType: 'socks5', proxyHost: '127.0.0.1' }),
    ['-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'],
  )
  assert.deepEqual(
    sshProxyTokens({ proxyType: 'http', proxyHost: 'proxy.example.com', proxyPort: 3128 }),
    ['-o', 'ProxyCommand=nc -X connect -x proxy.example.com:3128 %h %p'],
  )
  assert.deepEqual(sshProxyTokens({ proxyType: 'socks5', proxyHost: '' }), [])
})

test('buildRcloneArgs：跳板/代理目标改走 --sftp-ssh 外部 ssh（双引号包裹 ProxyCommand）', () => {
  const target = { host: 'h', port: 22, user: 'u', password: '', keyFile: '/k/id_rsa', options: '-o StrictHostKeyChecking=no', proxyType: 'jump', jumpHost: 'b.com', jumpPort: 2222, jumpUser: 'ops', jumpKeyFile: '/k/bastion' }
  const args = buildRcloneArgs(target, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: null })
  const i = args.indexOf('--sftp-ssh')
  assert.ok(i >= 0)
  assert.equal(args[i + 1], 'ssh -p 22 -i /k/id_rsa -o "ProxyCommand=ssh -p 2222 -o BatchMode=yes -i /k/bastion -W %h:%p ops@b.com" -o StrictHostKeyChecking=no u@h')
  // 直连目标不加 --sftp-ssh
  const direct = buildRcloneArgs({ host: 'h', port: 22, user: 'u' }, mod({ remotePath: '/r' }), '/p/dist/', { bin: 'rclone', pass: null })
  assert.ok(!direct.includes('--sftp-ssh'))
})

test('buildSshBase：跳板目标单引号包裹 ProxyCommand，直连不变', () => {
  const jump = { host: 'h', port: 22, user: 'u', keyFile: '/k/id_rsa', options: '-o StrictHostKeyChecking=no', proxyType: 'jump', jumpHost: 'b.com', jumpPort: 2222, jumpUser: 'ops', jumpKeyFile: '/k/bastion' }
  assert.equal(
    buildSshBase(jump),
    "ssh -p 22 -i /k/id_rsa -o 'ProxyCommand=ssh -p 2222 -o BatchMode=yes -i /k/bastion -W %h:%p ops@b.com' -o StrictHostKeyChecking=no",
  )
  assert.equal(buildSshBase({ host: 'h', port: 22 }), 'ssh -p 22')
  const socks = { host: 'h', port: 22, proxyType: 'socks5', proxyHost: '127.0.0.1' }
  assert.equal(buildSshBase(socks), "ssh -p 22 -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p'")
})

// rsync -e 命令行经 /bin/sh 分词（rsync 把整串拼进 sh -c 命令文本）：回环验证引号生效，
// 外层 ssh 必须把 ProxyCommand 值收为单个参数（回归：未引号时报 Bad stdio forwarding specification '%h:%p'）
test('buildSshBase：经 sh 分词后 ProxyCommand 为单个 argv（POSIX）', { skip: process.platform === 'win32' }, () => {
  const jump = { host: 'h', port: 22, keyFile: '/k/id_rsa', options: '-o StrictHostKeyChecking=no', proxyType: 'jump', jumpHost: 'b.com', jumpPort: 2222, jumpUser: 'ops', jumpKeyFile: '/k/bastion' }
  const out = execFileSync('bash', ['-c', `set -f; set -- ${buildSshBase(jump)}; for a; do echo "$a"; done`], { encoding: 'utf8' })
  const tokens = out.trim().split('\n')
  assert.deepEqual(tokens, [
    'ssh', '-p', '22', '-i', '/k/id_rsa',
    '-o', 'ProxyCommand=ssh -p 2222 -o BatchMode=yes -i /k/bastion -W %h:%p ops@b.com',
    '-o', 'StrictHostKeyChecking=no',
  ])
})

test('testSsh：跳板/代理字段拼接 ProxyCommand 前先做白名单校验（校验失败不触网）', async () => {
  // host 含 shell 元字符：必须在拼接 ProxyCommand（经 /bin/sh 执行）前拦截
  const badHost = await testSsh({ host: 'h', user: 'u', proxyType: 'jump', jumpHost: 'x;touch /tmp/pwned' })
  assert.equal(badHost.ok, false)
  assert.ok(badHost.error.includes('跳板 host'))
  const badUser = await testSsh({ host: 'h', user: 'u', proxyType: 'jump', jumpHost: 'b.com', jumpUser: 'ops$(id)' })
  assert.equal(badUser.ok, false)
  assert.ok(badUser.error.includes('跳板 user'))
  const badKey = await testSsh({ host: 'h', user: 'u', proxyType: 'jump', jumpHost: 'b.com', jumpKeyFile: 'relative/key' })
  assert.equal(badKey.ok, false)
  assert.ok(badKey.error.includes('跳板私钥路径'))
  const badProxy = await testSsh({ host: 'h', user: 'u', proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: 'abc' })
  assert.equal(badProxy.ok, false)
  assert.ok(badProxy.error.includes('代理 port'))
  // 端口 0 非法（默认回落只适用于空值）
  const badJumpPort = await testSsh({ host: 'h', user: 'u', proxyType: 'jump', jumpHost: 'b.com', jumpPort: 0 })
  assert.equal(badJumpPort.ok, false)
  assert.ok(badJumpPort.error.includes('跳板 port'))
})
