import test from 'node:test'
import assert from 'node:assert/strict'
import { checkHealth, isHealthyPayload } from '../server/health-check.js'

test('健康检查判定：HTTP 2xx + success=true + code=200 才通过', () => {
  assert.equal(isHealthyPayload({ success: true, code: 200 }), true)
  assert.equal(isHealthyPayload({ success: true, code: 200, msg: '' }), true)
  assert.equal(isHealthyPayload({ success: false, code: 200 }), false)
  assert.equal(isHealthyPayload({ success: true, code: '200' }), false)
  assert.equal(isHealthyPayload({ code: 200 }), false)
  assert.equal(isHealthyPayload(null), false)
  assert.equal(isHealthyPayload('ok'), false)
})

test('空健康检查 URL 直接跳过，不发起请求', async () => {
  const log = []
  assert.equal(await checkHealth('', message => log.push(message)), true)
  assert.deepEqual(log, [])
})

test('不可达地址在总超时内返回 false 并输出诊断日志', async () => {
  const log = []
  const ok = await checkHealth('http://127.0.0.1:1/', message => log.push(message), 120, 10)
  assert.equal(ok, false)
  assert.ok(log.some(line => line.includes('健康检查开始')))
  assert.ok(log.some(line => line.includes('未通过')))
  assert.ok(log.some(line => line.includes('秒内未恢复健康')))
})
