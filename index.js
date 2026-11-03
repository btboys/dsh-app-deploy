import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { initConfig } from './server/config.js'
import { initHistory } from './server/history.js'
import { handleRpc } from './server/rpc.js'
import { handleDeploy, killActiveProcess } from './server/deployment.js'

// ponytail: linked workspace cannot resolve dsh's own packages; resolve from the dsh entry instead
function hostRequire() {
  const local = createRequire(import.meta.url)
  try {
    local.resolve('@deepseek-ai/dsh-tools')
    return local
  } catch {}
  if (!process.argv[1]) throw new Error('找不到 dsh 安装目录')
  return createRequire(realpathSync(process.argv[1]))
}
const host = hostRequire()
const schema = host('@deepseek-ai/schemastery')
const z = schema.z ?? schema

export const inject = ['webServer']
export const Config = z.object({
  dataDir: z.string().default(''),
  defaultProjectPath: z.string().default(''),
})

const ROUTE = '/api/dsh-app-deploy'
const ROUTE_DEPLOY = `${ROUTE}/deploy`

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function resolveDataDir(config) {
  const custom = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (custom) return custom
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-app-deploy')
}

export function apply(ctx, config) {
  const dataDir = resolveDataDir(config)
  // 延迟初始化：apply 内不 await，首个请求时才读数据目录/播种
  let ready
  const ensure = () => (ready ??= (async () => {
    await mkdir(dataDir, { recursive: true })
    await initConfig({ dataDir, defaultProjectPath: config?.defaultProjectPath || '' })
    await initHistory(dataDir)
  })())

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        try {
          await ensure()
          if (req.method === 'GET' && url.pathname === ROUTE_DEPLOY) {
            await handleDeploy(req, res, url)
            return
          }
          if (req.method !== 'POST') {
            send(res, { ok: false, error: '只支持 POST' })
            return
          }
          const body = await readJson(req).catch(() => null)
          send(res, await handleRpc(body))
        } catch (error) {
          if (res.headersSent) {
            try { res.end() } catch {}
            return
          }
          send(res, { ok: false, error: error?.message || '请求失败' })
        }
      },
    })
    return () => {
      dispose()
      killActiveProcess()
    }
  }, 'dsh-app-deploy: routes')
}
