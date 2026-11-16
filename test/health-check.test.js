import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { checkHealth, compilePattern } from '../server/health-check.js'

test('compilePattern：空正则不校验内容，非法正则返回 error', () => {
  assert.deepEqual(compilePattern(''), { re: null })
  assert.equal(compilePattern('success"\\s*:\\s*true').re instanceof RegExp, true)
  const bad = compilePattern('([unclosed')
  assert.ok(bad.error)
})

test('compilePattern：/正则/flags 写法（仅 i m s u y，不支持 g）', () => {
  assert.equal(compilePattern('/ok/i').re.test('OK'), true)
  assert.equal(compilePattern('/^line2$/m').re.test('line1\nline2'), true)
  // 不以 / 开头按纯字符串处理
  assert.equal(compilePattern('a/b').re instanceof RegExp, true)
  // 空表达式与不支持的 flag 报错
  assert.ok(compilePattern('//').error)
  const withG = compilePattern('/ok/g')
  assert.ok(withG.error && withG.error.includes('不支持 g'))
})

test('空健康检查 URL 直接跳过，不发起请求', async () => {
  const log = []
  assert.equal(await checkHealth('', '', message => log.push(message)), true)
  assert.deepEqual(log, [])
})

test('不可达地址在总超时内返回 false 并输出诊断日志', async () => {
  const log = []
  const ok = await checkHealth('http://127.0.0.1:1/', '', message => log.push(message), 120, 10)
  assert.equal(ok, false)
  assert.ok(log.some(line => line.includes('健康检查开始')))
  assert.ok(log.some(line => line.includes('未通过')))
  assert.ok(log.some(line => line.includes('秒内未恢复健康')))
})

// 本地 HTTP server 探活判定用例
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(`http://127.0.0.1:${server.address().port}/`))
      } catch (error) {
        reject(error)
      } finally {
        server.close()
      }
    })
  })
}

test('HTTP 200 且无正则时直接通过', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end('anything') },
    async (url) => {
      const log = []
      assert.equal(await checkHealth(url, '', message => log.push(message), 3000, 100), true)
    })
})

test('HTTP 200 但响应内容不匹配正则不通过，并输出原因', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end('{"success": false}') },
    async (url) => {
      const log = []
      const ok = await checkHealth(url, '"success"\\s*:\\s*true', message => log.push(message), 300, 50)
      assert.equal(ok, false)
      assert.ok(log.some(line => line.includes('内容与成功正则不匹配')))
    })
})

test('HTTP 200 且响应内容匹配正则时通过', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end('{"code":200,"success":true}') },
    async (url) => {
      assert.equal(await checkHealth(url, '"success"\\s*:\\s*true', () => {}, 3000, 100), true)
    })
})

test('非 200 状态码不通过（2xx 的 201 也不行）', async () => {
  await withServer(
    (req, res) => { res.writeHead(201); res.end('ok') },
    async (url) => {
      const log = []
      const ok = await checkHealth(url, '', message => log.push(message), 300, 50)
      assert.equal(ok, false)
      assert.ok(log.some(line => line.includes('HTTP 201')))
    })
})

test('/regex/i flags 写法对响应内容生效', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end('STATUS: OK') },
    async (url) => {
      assert.equal(await checkHealth(url, '/ok/i', () => {}, 3000, 100), true)
      assert.equal(await checkHealth(url, '/ok/', () => {}, 300, 50), false)
    })
})

test('非法正则直接失败并提示，不发起请求', async () => {
  const log = []
  const ok = await checkHealth('http://127.0.0.1:1/', '([bad', message => log.push(message))
  assert.equal(ok, false)
  assert.ok(log.some(line => line.includes('正则不合法')))
  assert.ok(!log.some(line => line.includes('未通过')))
})
