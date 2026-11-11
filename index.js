import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initConfig, reloadEnvs } from './server/config.js'
import { initHistory } from './server/history.js'
import { handleRpc } from './server/rpc.js'
import { handleDeploy, killActiveProcess } from './server/deployment.js'
import { registerTools, CONFIG_GUIDE } from './server/tools.js'

// ponytail: linked workspace cannot resolve dsh's own packages; resolve from the dsh entry instead.
// Must import() (not require()): host loads plugins via Promise.all, require(esm) races and throws ERR_REQUIRE_ESM_RACE_CONDITION.
function hostResolve(spec) {
  try {
    return createRequire(import.meta.url).resolve(spec)
  } catch {}
  if (!process.argv[1]) throw new Error('找不到 dsh 安装目录')
  return createRequire(realpathSync(process.argv[1])).resolve(spec)
}
const hostImport = (spec) => import(pathToFileURL(hostResolve(spec)))
const schema = await hostImport('@deepseek-ai/schemastery')
const z = schema.z ?? schema.default ?? schema

export const inject = ['webServer', 'tools']
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

export async function apply(ctx, config) {
  const dataDir = resolveDataDir(config)
  // 延迟初始化：apply 内不 await，首个请求/工具调用时才读数据目录/初始化配置
  let ready
  const ensure = () => (ready ??= (async () => {
    await mkdir(dataDir, { recursive: true })
    await initConfig({ dataDir, defaultProjectPath: config?.defaultProjectPath || '' })
    await initHistory(dataDir)
  })())
  // AI 工具：列出环境 / 保存环境 / 执行部署 / 执行记录 / SSH 测试（defineTool 从 dsh 宿主解析，失败不影响面板）
  try {
    const { defineTool } = await hostImport('@deepseek-ai/dsh-tools')
    registerTools(ctx, defineTool, ensure)
  } catch (err) {
    console.warn('[dsh-app-deploy] 注册 AI 工具失败:', err?.message || err)
  }
  // 注入配置说明到系统提示词：AI 用 deploy_save_env 创建/修改配置时参考（宿主无 systemPrompt 服务时跳过）
  try {
    ctx.inject(['systemPrompt'], (c) => {
      const sp = c.systemPrompt
      if (!sp || typeof sp.section !== 'function') return
      // 紧跟宿主 TOOLS_SDK section 之后；宿主无该常量时回退 5100
      const sdk = typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('TOOLS_SDK') : NaN
      sp.section({ name: 'dsh-app-deploy:config-guide', order: Number.isFinite(sdk) ? sdk + 100 : 5100, text: CONFIG_GUIDE, interpolate: false })
    })
  } catch {}

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        try {
          await ensure()
          // envs.json 以磁盘为准：每次请求重读，外部修改立即生效
          await reloadEnvs()
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
