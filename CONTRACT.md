# dsh-app-deploy 开发契约

本文件是 Host 半侧（`index.js` + `server/`）与 Client 半侧（`client.js`）的唯一接口约定。
两侧并行开发，**任何一方都不得单方面修改本文件里的字段名/路径/事件名**；确需修改先通知 Lead。

旧项目：`/Users/gson/IdeaProjects/financial-deploy-ui`（Bun 服务 + 原生 JS 页面，功能与行为以它为准）。
可工作的 DSH 插件参考：`/Users/gson/IdeaProjects/yunxiao-taskboard`（宿主路由 + Client 面板）。

## 1. 包与组合

- 包名：`dsh-app-deploy`，纯 ESM JavaScript，**无构建步骤、无运行时依赖**。
- `cordis.patch.yml` 插入一行：`id: dsh-app-deploy`，`name: dsh-app-deploy`。
- Host 入口 `index.js`；Client 入口 `client.js`（`dsh.client` 已声明 `platform: web`, `immediately: true`）。
- 只支持 Web 页面；不做 iframe、不内嵌 HTML 页面。

## 2. Host 契约（`index.js` + `server/`）

### 2.1 插件入口

```js
export const inject = ['webServer']
export const Config = /* schemastery */ {
  dataDir: string   // 默认 '' → ${DSH_HOME:-~/.dsh}/dsh-app-deploy
  defaultProjectPath: string // 默认 ''（新环境模板用；为空时前端自己留空）
}
export function apply(ctx, config) { /* 同步返回，初始化延迟到首次请求 */ }
```

- `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 等宿主包用
  `/Users/gson/IdeaProjects/yunxiao-taskboard/index.js` 第 10-23 行的 `hostRequire()` 方式解析。
- **不要在 `apply` 里 await**：初始化用 `let ready; const ensure = () => ready ??= init()`，请求处理里 `await ensure()`。
- 清理：`ctx.effect(() => { ...; return () => killActiveProcess() })`，插件卸载/重载时终止正在跑的 gradle/rsync/ssh 子进程。
- 不注册任何 Tool（本版不做 `ctx.tools`）。

### 2.2 数据目录

```
dataDir/
  envs.json      Env[]        （含 SSH 密码，绝不能进包、绝不能进 patch config）
  history.json   DeployRecord[]（上限 500 条，超出裁剪最旧）
```

- 新装插件不播种：`envs.json` 不存在/损坏时初始化为 `[]`，环境全部由用户新增或「导入」得到。
- 旧数据迁移由用户手动 `cp` 或面板「导入」，插件不做自动迁移。

### 2.3 HTTP 接口

前缀路由：`ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-app-deploy', handler })`。

**A. JSON-RPC**：`POST /api/dsh-app-deploy`（body 为 JSON）

请求：`{ "method": string, "args"?: unknown }`
响应：`{ "ok": true, "value": any }` 或 `{ "ok": false, "error": string }`（HTTP 一律 200，错误走 `ok:false`）

| method | args | value |
| --- | --- | --- |
| `config` | – | `{ envs: Env[], defaultProjectPath: string, lastBuild: Record<string, { time: number, status: DeployStatus }> }` |
| `saveEnv` | `Env` | `{ envs: Env[], warning?: string }`（校验失败 → `ok:false`，error 为多条用「；」拼接） |
| `deleteEnv` | `{ id: string }` | `{ envs: Env[] }` |
| `importEnvs` | `{ content: string }`（JSON 文本：`Env[]` 或 `{ envs: Env[] }`） | `{ envs: Env[], added: string[], overwritten: string[], warning?: string }`；同 ID 覆盖本地、其余追加；任一环境校验失败 → `ok:false` 且不写盘 |
| `frontEnv` | `{ env: string, module: string }` | `{ text: string }`（front 模块 frontEnv 为空时读 `.env` 参考文本，绝不写回） |
| `jdks` / `nodes` / `packageManagers` | – | `Array<{ label: string, path: string }>` |
| `sshTest` | `{ target: { host, port, user, password?, keyFile?, options? } }` | `{ ok: boolean, ms?: number, error?: string }`；BatchMode 仅无密码时用（避免 sshpass 失效），10s 超时 |
| `browse` | `{ path?: string, hidden?: boolean, file?: boolean }` | `{ path, parent, dirs: string[], worktrees: Worktree[], files?: string[] }`；`file:true` 时额外列出普通文件供选择（如私钥）；支持 `~/` 开头路径；非法/不可读 → `ok:false` |
| `git` | `{ env: string, path?: string }` | `{ ok: boolean, isGit?: boolean, branch?: string, shortCommit?: string, detached?: boolean, worktrees: Worktree[] }` |
| `history` | `{ env?: string, limit?: number }` | `DeployRecord[]`（时间倒序；limit 默认 50，上限 500） |
| `clearHistory` | – | `{ ok: true }`（保留进行中的记录） |

`Worktree = { path: string, branch: string, head: string }`
`DeployStatus = 'running' | 'success' | 'failed' | 'aborted'`

**B. 部署 SSE**：`GET /api/dsh-app-deploy/deploy?env=<id>&modules=<逗号分隔模块 id>&path=<可选 worktree 路径>`

语义与旧 `/api/deploy` 完全一致：

- 响应头 `content-type: text/event-stream`、`cache-control: no-cache`，`res.flushHeaders()`。
- 日志：默认事件 `data: <JSON 字符串片段>`。
- 回放：`event: replay` + `data: <JSON 字符串，已累积日志尾部>`。
- 结束：`event: done` + `data: {"code": number}`，随后 `res.end()`。
- 心跳：每 15s 写 `: hb\n\n`。
- `Last-Event-ID`（值为部署记录 id）：加入匹配的进行中部署并回放；已结束则回放 + 直接 done；记录不存在 → HTTP 204（前端停止重连）。
- 同一时刻只允许一个部署；新请求加入现有部署（先 replay 再续推）。
- 参数非法：流开始前返回 HTTP 400 JSON `{ error }`。
- `req.on('close', ...)` 从广播集合移除；**绝不能因断开重复触发部署**。

### 2.4 数据模型（字段名一个都不能改）

```ts
type ModKind = 'front' | 'server'

interface ModuleCfg {
  id: string; name: string; kind: ModKind; enabled: boolean
  buildCmd: string // 通用构建命令，如 ./gradlew … / mvn -DskipTests package / npm run build
  sshId: string // 发布目标（env.sshs 之一），空 = 第一个目标
  localPath: string; remotePath: string; postCommand: string
  healthCheckUrl?: string; frontEnv: string
}

interface SshTarget {
  id: string; name: string; host: string; port: number; user: string
  password: string; keyFile: string // 私钥绝对路径，空 = 默认密钥/agent，优先于 options 里的 -i
  options: string
}

interface Env {
  id: string; name: string; note: string; group: string
  projectPath: string; jdkHome: string; nodeHome: string; nodeOptions: string
  pmPath: string // 包管理器可执行文件绝对路径，构建时其目录加入 PATH 首位，空 = 跟随 PATH
  buildEnv: string // 环境级 KEY=VALUE 多行，构建时注入所有模块（模块 frontEnv 覆盖同名字段）
  expTime: string
  sshs: SshTarget[] // 至少一个；旧格式 env.ssh 单对象自动迁移为单元素数组
  modules: ModuleCfg[]
}

interface DeployRecord {
  id: string; envId: string; envName: string
  modules: { id: string; name: string }[]
  startTime: number; endTime: number | null; durationMs: number | null
  status: DeployStatus; exitCode: number | null
  failedModule: string | null; failedStep: string | null
  logTail: string   // 约 30000 字符，按整行截断
}
```

### 2.5 Host 行为（从旧项目移植，不新增功能）

- `server/config.js`：类型归一化（旧 record schema → modules 数组、`-PexpTime` 抽到 `env.expTime`、
  旧 gradle 三字段 gradleTask/key/extraArgs → `buildCmd`、旧 `env.ssh` 单对象 → `sshs` 数组）、
  分组默认值、校验（`BAD_PATH`/`BAD_CMD`/frontEnv/buildEnv/healthCheckUrl 等）、`saveEnv` 时若任一目标配了密码但本机无 sshpass 给 `warning`。
- `server/deployment.js`：构建前清理 → 执行模块 `buildCmd`（首 token 含 gradle 的 server 模块自动追加 `-PexpTime`，Windows 下 `./gradlew` 回退 `gradlew.bat`；
  构建 env 依次注入 JAVA_HOME / Node PATH / 包管理器 PATH / NODE_OPTIONS / env.buildEnv / 模块 frontEnv）→ `rsync`（front 加 `--delete --exclude=.user.ini`）→ `ssh postCommand` → 健康检查；
  每个模块按其 `sshId` 解析目标（`targetFor`，空回落第一个）；密钥 keyFile 与密码可同时使用；
  任一步非零中止并记录 `failedModule/failedStep`；结束若项目存在 gradlew 则停 `./gradlew --stop`。
  子进程用 `node:child_process.spawn`，`stdout/stderr` 流式 `broadcast`。
  `sshpass` 检测用 `execFile('which', ['sshpass'])` 或等价方案；有密码时 `rsync/ssh` 走 `sshpass -e`，密码只放 `SSHPASS` 环境变量。
- `server/local-tools.js`：git worktree 列表 / git 分支信息 / JDK/Node/包管理器探测 / 目录与文件浏览（Bun API 换 Node）。
- `server/history.js`：读写 `history.json`；启动时把残留 `running` 标为 `aborted`；500 条裁剪。
- `server/health-check.js`：HTTP 2xx + `success === true` + `code === 200`，单次 5s，间隔 3s，总 120s。

### 2.6 Bun → Node 替换清单

`Bun.spawn`→`node:child_process`、`Bun.file().text()/json()/exists()`→`fs/promises`、`Bun.write`→`fsp.writeFile`、
`Bun.which`→`execFile('which')`、`Bun.sleep`→`setTimeout`、`Bun.env`→`process.env`；`Bun.serve`/`start.sh`/`ACCESS_TOKEN` 全部删除。

## 3. Client 契约（`client.js`）

### 3.1 模块格式（照抄 yunxiao-taskboard/client.js 第 1-27 行）

```js
window.__ModuleLoader__.load({
  id: 'dsh-app-deploy',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement
    /* ...组件... */
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'deploy', label: '部署', order: 45 }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'deploy' }, Panel))
      },
    }
  },
})
```

- **React 从模块表 `require('react')` 拿，禁止自带/打包 React；禁止 JSX（纯 `createElement`）。**
- 只能 fetch 同源 `/api/dsh-app-deploy`，EventSource 同源 `/api/dsh-app-deploy/deploy?...`。
- 样式：组件内渲染 `<style>` 元素（`h('style', null, css)`），类名统一前缀 `dad-`；
  颜色/边框/背景用主题变量 `--dsw-alias-*`（先 `cordis_inspect_query` client `Theme.listTokens` 取可用 token），
  布局尺寸可写死。**不要读取或依赖其它插件的 DOM/CSS。**
- 视觉参考：Plugin Manager 页面的列表/表单风格；间距紧凑，支持窄窗口。
- 面板高度撑满可用区域：外层 `height: 100%; display: flex; overflow: hidden`，左右两栏各自滚动。

### 3.2 功能（与旧 `web/app.js` 对齐）

1. **环境列表**：按 `group` 分组（未分组在最后），选中态；卡片显示 id·note、`user@host:port`、最后构建时间/状态；
   每卡「复制」「删除」。顶部「+ 添加环境」。
2. **环境编辑**：基本项（名称/ID(新增可改)/备注/分组/项目路径/JDK/Node 路径/Node options/包管理器路径/构建环境变量/expTime）、
   SSH 目标列表（名称/ID/host/port/user/密码/私钥路径(可浏览选择)/自定义选项，每个目标带「测试连接」按钮，可增删）、
   模块卡片列表（显示名/类型/ID/启用/构建命令(左侧构建工具下拉)/SSH 目标/本地路径/远程路径/postCommand/健康检查 URL/front 模块的 frontEnv 多行文本）；
   增删模块；「保存环境」「删除此环境」；保存后用返回的 `envs` 刷新。
3. **路径选择**：项目路径「浏览…」弹层（`browse` RPC：目录列表、上级、选择当前、显示隐藏目录开关、worktree 快捷跳转）；私钥路径用 `file:true` 文件选择模式，从 `~/.ssh` 起步。
4. **JDK/Node/包管理器 下拉**：聚焦对应输入框时展示 `jdks`/`nodes`/`packageManagers` 列表，点选填入；构建命令左侧另有构建工具（Gradle/Maven/npm/pnpm/yarn）下拉，选中填充命令模板。
5. **Git 信息条**：选中环境后读 `git`；显示分支/短 hash/生效路径；仓库有多个 worktree 时提供下拉选择**临时构建路径**（不写回配置，仅本次会话）。
6. **部署区**：启用模块多选（勾选/取消/全选/清空）、「执行顺序」列表可拖拽排序、可单独移除；
   「执行部署」弹确认框（环境、模块顺序、每个模块的构建/rsync/ssh 计划），确认后开 EventSource 推日志；
   状态显示部署中/完成/失败；日志面板自动滚底；完成后刷新执行记录与最后构建时间。
7. **执行记录**：当前环境最近 20 条；状态徽标、时间、耗时、模块、失败模块/阶段/exit code；失败记录可展开日志尾部；「清空」。
8. **frontEnv 初始值**：模块 `frontEnv` 为空且类型 front 时，调用 `frontEnv` RPC 读文件参考文本填入（用户已编辑则不覆盖）。
9. **配置导入/导出**：环境列表顶部「导入」选择 JSON 文件 → 确认框列出将覆盖的同 ID 环境 → `importEnvs` RPC；
   成功后用返回的 `envs` 刷新列表并选中导入的环境；失败/校验错误显示在全局提示条。
   「导出」不发请求，直接用当前 `envs` 生成 `envs-YYYY-MM-DD.json`（与 `envs.json` 同构，含 SSH 密码）触发下载，
   导出的文件可直接用于「导入」。

### 3.3 限制

- 不新增功能（不做工具、不做权限、不做多标签页）；旧页面的令牌透传逻辑删除。
- 不要自造 HTML 预览页；交付即真实面板。

## 4. 验收

- `node --check index.js client.js` 通过；`node --test` 通过。
- Host：`node -e` 直接 import `server/*` 的单测覆盖 校验/归一化/清理目标/健康检查判定。
- Client：安装后在 Web 页面侧边栏出现「部署」入口，面板渲染、能读到 `envs.json`。
- 安装只由 Lead 执行（`plugin_manager.install_bundle`），开发方不要改 profile。
