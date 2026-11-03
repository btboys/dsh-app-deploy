import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initConfig } from '../server/config.js'
import { handleDeploy } from '../server/deployment.js'

const DIR = await fsp.mkdtemp(path.join(tmpdir(), 'dad-deploy-'))
await initConfig({ dataDir: DIR, defaultProjectPath: '/tmp/project' })

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true },
    flushHeaders() {},
    end(chunk) { this.body += chunk || '' },
  }
}

function fakeReq(headers = {}) {
  return { headers, on() {} }
}

async function deploy(query, req = fakeReq()) {
  const res = fakeRes()
  await handleDeploy(req, res, new URL(`/api/dsh-app-deploy/deploy${query}`, 'http://dsh.local'))
  return res
}

test('部署参数非法：流开始前返回 400 JSON，不启动部署', async () => {
  const cases = [
    ['?env=nope', '未知环境'],
    ['?env=fxy', '未指定模块'],
    ['?env=fxy&modules=zzz', '所选模块在环境中均不可用或已禁用'],
  ]
  for (const [query, error] of cases) {
    const res = await deploy(query)
    assert.equal(res.status, 400, query)
    assert.equal(JSON.parse(res.body).error, error, query)
  }
})

test('Last-Event-ID 对应部署不存在：返回 204 且不触发新部署', async () => {
  const res = await deploy('?env=fxy&modules=bsFront', fakeReq({ 'last-event-id': 'gone' }))
  assert.equal(res.status, 204)
  assert.equal(res.body, '')
})
