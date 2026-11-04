// AI 可调用的部署工具：列出环境、执行部署、查执行记录、测试 SSH 连接
// 密码绝不暴露给模型（只返回 hasPassword 标记）；密钥路径是本机路径，可返回
import { getEnvs } from './config.js'
import { runDeploy, testSsh, activeRecord } from './deployment.js'
import { getHistory } from './history.js'

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
      id: m.id, name: m.name, kind: m.kind, enabled: m.enabled, buildCmd: m.buildCmd, sshId: m.sshId || '',
      localPath: m.localPath, remotePath: m.remotePath, postCommand: m.postCommand, healthCheckUrl: m.healthCheckUrl || '',
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
  // 每个工具执行前确保初始化完成（幂等，首次才真正读盘）
  const ready = () => (ensure ? ensure() : Promise.resolve())
  ctx.tools.register(defineTool({
    name: 'deploy_list_envs',
    description: 'List deploy environments configured in the dsh-app-deploy plugin: SSH targets (passwords stripped), build modules with their build commands, artifact paths and publish targets. Use before deploy_run to pick env/module IDs.',
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
