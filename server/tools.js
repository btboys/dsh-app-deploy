// AI 可调用的部署工具：列出环境、执行部署、查执行记录、测试 SSH 连接
// 密码绝不暴露给模型（只返回 hasPassword 标记）；密钥路径是本机路径，可返回
import { getEnvs, saveEnvs, normalizeEnv, validateEnv, reloadEnvs } from './config.js'
import { runDeploy, testSsh, activeRecord } from './deployment.js'
import { getHistory } from './history.js'

// 注入系统提示词的配置说明：让模型知道 deploy_save_env 的字段约束与校验规则
export const CONFIG_GUIDE = `## Deploy plugin (dsh-app-deploy) config guide

Create or update a deploy environment with \`deploy_save_env\` (upsert by \`env.id\`; the whole object is validated before writing — on failure you get every validation error and nothing is written). Workflow: \`deploy_list_envs\` → modify/extend an existing env object or build a new one → \`deploy_save_env\` → \`deploy_run\`.

Env fields:
- id: lowercase letters/digits/hyphens, unique. name: required. note/group: optional short strings.
- projectPath: absolute local repo path; no spaces, quotes, or \`; & | \` $\` metacharacters.
- jdkHome / nodeHome / pmPath: absolute paths, may be empty. nodeHome may point at the install dir or its bin dir; pmPath is a package-manager binary (pnpm/yarn) whose dirname is prepended to PATH for builds.
- nodeOptions: NODE_OPTIONS for builds. buildEnv: multi-line KEY=VALUE injected into every module build. expTime: YYYY-MM-DD, auto-appended as -PexpTime to gradle server-module builds.
- sshs[]: { id, name, host (letters/digits/./-), port (1-65535), user, password, keyFile, options }. Password auth requires local sshpass; prefer keyFile (absolute private-key path). options = extra ssh options such as \`-o StrictHostKeyChecking=no\`.
- modules[]: { id (unique per env), name, kind: 'front'|'server', enabled, buildCmd, buildDir, sshId, localPath, remotePath, postCommand, healthCheckUrl, frontEnv, instances }.
  - buildCmd: plain command, split on whitespace and spawned without a shell (POSIX; Windows 经 cmd 启动) — no quotes, pipes, \`&&\`, \`;\` or other shell metacharacters. Examples: \`./gradlew client:dist\`, \`mvn -DskipTests package\`, \`yarn workspace @catering/tenant-web build\`.
  - buildDir: working directory of buildCmd — relative to projectPath (no \`..\`) or absolute; empty = project root.
  - localPath: built artifact path relative to projectPath (or absolute). Front-end pre-build cleanup derives its target from \`/dist\` in localPath — a custom output dir still deploys, but skips the clean (warning logged). A trailing slash syncs the directory's contents (rsync semantics), otherwise the directory itself. Front-end sync mirrors (--delete, excludes .user.ini); server sync never deletes.
  - remotePath: destination path on the SSH host. postCommand: remote shell command run after sync (may be empty). healthCheckUrl: HTTP/HTTPS probe after deploy (empty = skip).
  - frontEnv: multi-line KEY=VALUE for front modules (VITE_* vars override .env files). instances: optional [{ sshId, healthCheckUrl }] for rolling multi-instance publish.
- deploy_list_envs never returns passwords (only hasPassword); when updating an env you must re-supply the password or keyFile.`

// AI 创建/更新环境配置：整体校验通过才写盘（同 id 覆盖，否则追加）
export async function saveEnvForModel(raw) {
  const env = normalizeEnv(raw && typeof raw === 'object' ? raw : {})
  const errors = validateEnv(env)
  if (errors.length) return { ok: false, errors }
  const envs = getEnvs()
  const i = envs.findIndex(x => x.id === env.id)
  if (i >= 0) envs[i] = env; else envs.push(env)
  await saveEnvs()
  return { ok: true, envId: env.id }
}

// 环境摘要：供模型决定部署目标；剥离 password
export function envSummaryForModel(e) {
  return {
    id: e.id, name: e.name, note: e.note, group: e.group,
    projectPath: e.projectPath, jdkHome: e.jdkHome || '', nodeHome: e.nodeHome || '', pmPath: e.pmPath || '',
    sshs: (e.sshs || []).map(s => ({
      id: s.id, name: s.name, host: s.host, port: s.port, user: s.user,
      hasPassword: !!s.password, keyFile: s.keyFile || '', options: s.options || '',
    })),
    modules: (e.modules || []).map(m => ({
      id: m.id, name: m.name, kind: m.kind, enabled: m.enabled, buildCmd: m.buildCmd, buildDir: m.buildDir || '', sshId: m.sshId || '',
      localPath: m.localPath, remotePath: m.remotePath, postCommand: m.postCommand, healthCheckUrl: m.healthCheckUrl || '',
      instances: (m.instances || []).map((i) => ({ sshId: i.sshId, healthCheckUrl: i.healthCheckUrl })),
    })),
  }
}

const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/**
 * 向 ctx.tools 注册 4 个工具。defineTool 由宿主解析（@deepseek-ai/dsh-tools），
 * 插件自身不依赖该包，保证脱离 dsh 宿主时模块仍可加载（如单元测试）。
 * @param {object} ctx cordis Context（需注入 tools 服务）
 * @param {object} defineTool @deepseek-ai/dsh-tools 的 defineTool
 * @param {() => Promise<void>} ensure 插件初始化（数据目录/配置/历史）；工具调用不走 HTTP 路由，必须显式等待
 */
export function registerTools(ctx, defineTool, ensure) {
  // 每个工具执行前确保初始化完成（幂等，首次才真正读盘）；随后重读 envs.json，保证外部修改立即生效
  const ready = async () => {
    await (ensure ? ensure() : Promise.resolve())
    await reloadEnvs()
  }
  ctx.tools.register(defineTool({
    name: 'deploy_list_envs',
    description: 'List deploy environments configured in the dsh-app-deploy plugin: SSH targets (passwords stripped), build modules with their build commands, artifact paths, publish targets and rolling-update instances. Use before deploy_run to pick env/module IDs.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          active: { type: 'object', additionalProperties: true }, // 进行中的部署（无则不返回）
          envs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: jsonRender,
    },
    execute: async () => {
      await ready()
      const rec = activeRecord()
      return {
        ...(rec ? { active: { id: rec.id, env: rec.envName, modules: rec.modules } } : {}),
        envs: getEnvs().map(envSummaryForModel),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deploy_run',
    description: 'Run a deployment for one environment: clean → build each module (generic command: gradlew/mvn/npm…) → rsync/rclone to the module\'s SSH target → remote command → health check. Blocks until finished and returns the exit code plus the full log tail. Fails if another deployment is running. Omit modules to deploy all enabled modules in config order.',
    parameters: {
      env: { type: 'string', required: true, description: 'Environment ID (from deploy_list_envs)' },
      modules: { type: 'array', items: { type: 'string' }, description: 'Module IDs in desired execution order. Omit for all enabled modules.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          code: { type: 'integer', required: true },
          status: { type: 'string', required: true },
          durationMs: { type: 'integer' },
          failedModule: { type: 'string' },
          failedStep: { type: 'string' },
          logTail: { type: 'string', required: true },
        },
      },
      render: jsonRender,
    },
    execute: async (args) => {
      await ready()
      return runDeploy(args.env, args.modules || [])
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deploy_save_env',
    description: 'Create or update a deploy environment config (upsert by env.id). The whole object is validated before writing; on failure returns every validation error and nothing is written. Call deploy_list_envs first to fetch the full object before modifying an existing env (passwords are not returned, re-supply them when updating).',
    parameters: {
      env: { type: 'object', additionalProperties: true, required: true, description: 'Full environment object per the dsh-app-deploy config guide (system prompt).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          envId: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: jsonRender,
    },
    execute: async (args) => {
      await ready()
      return saveEnvForModel(args.env)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deploy_history',
    description: 'Recent deployment records (newest first): status, duration, per-module failure step, and a truncated log tail for failed runs. Filter by environment ID optionally.',
    parameters: {
      env: { type: 'string', description: 'Environment ID to filter by' },
      limit: { type: 'integer', description: 'Max records, default 10' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          records: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: jsonRender,
    },
    execute: async (args) => {
      await ready()
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
      let list = getHistory().slice()
      if (args.env) list = list.filter(r => r.envId === args.env)
      return { records: list.slice(-limit).reverse() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ssh_test_connection',
    description: 'Test an SSH connection (10s timeout): host key/agent auth via keyFile, or password via sshpass. Returns ok/latency or the server-reported error.',
    parameters: {
      host: { type: 'string', required: true },
      port: { type: 'integer' },
      user: { type: 'string', required: true },
      password: { type: 'string', description: 'SSH password; omit to use keyFile or agent' },
      keyFile: { type: 'string', description: 'Absolute private key path; takes precedence over options -i' },
      options: { type: 'string', description: 'Extra ssh options, e.g. -o StrictHostKeyChecking=no' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ms: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: jsonRender,
    },
    execute: async (args) => {
      await ready()
      return testSsh({ host: args.host, port: args.port || 22, user: args.user, password: args.password || '', keyFile: args.keyFile || '', options: args.options || '' })
    },
  }))
}
