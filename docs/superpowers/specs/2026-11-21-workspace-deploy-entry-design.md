# 工作空间关联部署 · 右侧工作空间侧栏直达入口 设计文档

- 日期：2026-11-21（v2，修正入口位置）
- 插件：`dsh-app-deploy`（当前 0.6.1）
- 范围：仅 Client 半侧 `client.js`；**不改 Host（`index.js` / `server/`）、不改 `CONTRACT.md`**
- 状态：已实现，待 GUI 实测

> **v2 变更**：v1 误把入口加在左侧全局面板区（`sidebar.panellist`）。用户澄清目标是**右侧工作空间侧栏**
> （rightbar guide 卡片列表：工作区文件/代码审查/新建终端/浏览器/…）。v2 移除左侧动态入口，改在右栏注册
> deploy tab 类型 + guide 卡片；点击在**右栏内开部署 tab**（用户已确认）。左侧常驻「部署」入口保留不变。

## 1. 背景与目标

插件现有常驻全局侧栏「部署」入口（左栏，打开全部环境面板）。用户希望：在**右侧工作空间侧栏**，当当前
工作空间关联了部署环境时，出现一个「部署」guide 卡片；点击在右栏开一个部署 tab（预选匹配环境）直接部署。

## 2. 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 入口位置 | **右侧工作空间侧栏**（rightbar guide 卡片列表） |
| 打开方式 | **右栏内开部署 tab**（与文件/终端/浏览器一致，可右栏全屏） |
| 常驻左栏入口 | 保留，行为不变 |
| 匹配规则 | 规范化后 `cwd === projectPath` 或 `cwd` 在 `projectPath` 之下（单向） |
| 显示条件 | 当前工作空间匹配 ≥1 环境时显示卡片；否则隐藏 |
| 多环境匹配 | 右栏**一个**「部署」卡片；tab 内预选匹配集合第一个环境，面板内可切换 |

## 3. 匹配规则

- `normMatchPath(p)`：trim → `\`→`/` → 去尾 `/`（保留 posix 根 `/`）。
- `pathMatches(cwd, projectPath)`：均非空绝对路径，且相等或 `cwd.startsWith(projectPath + '/')`。
- 当前 `cwd`：`SessionListState.byId` 中 `retainedBy.mainView > 0` 的主会话的 `cwd`。

## 4. 功能规格

### 4.1 guide 卡片
- 通过 rightbar tab 类型的 `guide` 贡献：`{ id:'deploy', order:60, title:()=>'部署', description:live, icon }`。
- description 实时读匹配集合：单环境显示环境名；多环境显示 `N 个环境 · 首环境名`。
- 点击卡片 → 宿主 `openTab(kind, {replaceTab:true})` 在右栏开部署 tab。

### 4.2 部署 tab（v3：紧凑视图）
- 类型：`id='dsh-app-deploy/rightbar'`，`kind='dsh-app-deploy'`，`multiple:false`，`keepMounted:true`。
- body：`sidebar.right.pane.tab` key=类型 id，渲染 `Panel compact`，`initialEnvId`=匹配集合第一个环境。
- **紧凑模式只显示部署区 + 部署日志**（模块勾选/全选、执行顺序拖拽、执行部署+确认、GitBar/worktree、日志），
  **不显示**环境列表、环境编辑表单、执行记录、大标题。
- 匹配到**多个**环境时顶部加环境名切换 tab（`EnvSwitcher`，复用 dad-modtab 样式）；单环境不显示切换。
- 切换经 `selectEnv` 重置勾选；部署确认弹窗保留。

### 4.3 响应式与边界
| 场景 | 行为 |
| --- | --- |
| 匹配集合 0↔>0 | 动态注册/注销 tab 类型 → guide 卡片出现/消失 |
| 注销时已有部署 tab 打开 | 先经 `openTabs` inventory 跨会话 `closeIn` 关闭，再注销类型 |
| 无当前会话 / cwd 空 | 不显示卡片 |
| `sidebarRightTabs`/`sidebarRight` 缺失 | 特性降级关闭，左栏常驻入口不受影响 |
| 环境配置变化 | matchStore 刷新（Panel mutations 就地 + 30s + focus）→ 卡片增删 |
| 插件卸载 | effect 清理订阅/定时器/类型注册 |

## 5. 技术设计

### 5.1 结构
```
apply(ctx)
├─ 左栏常驻（保留）：sidebar.panellist id 'deploy' + main key 'deploy' → Panel
├─ matchStore（ctx.effect）：订阅 sessions.list 算 cwd；envs 缓存 rpc('config') 启动+30s+focus+setEnvs
├─ stage2：slots.inject('sidebar.right.pane.tab') → register(key=RB_TAB_ID, DeployTabBody)  [常驻]
└─ stage1（ctx.effect）：订阅 matchStore
    ├─ matched>0 且未注册 → sidebarRightTabs.register(definition 含 guide)
    └─ matched=0 且已注册 → closeDeployTabs() → disposeType()
```

### 5.2 关键契约（核对安装版源码）
- 两阶段注册：类型进 `ctx.sidebarRightTabs`（`SidebarRightTabRegistry.register`），body 进
  `sidebar.right.pane.tab` keyed by 类型 id（`dsh-client-ui-sidebar-right/src/client/index.ts`、`tab-registry.ts`）。
- guide 卡片来自 `registry.guide()`（definition.guide flatMap），经 `useGuideEntries` 响应式投影
  （`GuideBody.tsx`）；注册/注销类型即增删卡片。
- 点击卡片 `tab.actions.openTab(kind,{replaceTab:true})`（GuideBody）。
- 关闭跨会话 tab：controller 公共方法 `closeIn(sessionId,tabId)`（service.ts:428，不在 ISidebarRight
  接口但运行时存在，防御性 `typeof` 调用）；inventory `ctx.sidebarRight.openTabs`。
- 当前 cwd：`retainedBy.mainView`（`dsh-client-ui-workspace/tree.ts mainSessionId`）。

### 5.3 matchStore
- `sessions.list` 变化只重算匹配（无 RPC）；签名（匹配 id 拼接）去重通知。
- envs 刷新：启动 / 30s / window focus / `setEnvs()`（Panel save/import/delete 后就地）。
- `getSnapshot()/subscribe()/setEnvs()/dispose()`。

### 5.4 Panel
- `Panel({ initialEnvId }={})`：首次加载优先选中 initialEnvId，否则第一个；常驻面板不变。
- mutations 后 `syncDeployEnvs(list)` 刷新 matchStore。

## 6. 不在本次范围
- 左栏常驻入口行为不变；不做左栏 per-env 直达入口（v1 已移除）。
- 不做右栏 per-env 多卡片（guide 点击不传 params，无法 per-env 预选）。
- 不新增 Host 接口/工具/配置字段。

## 7. 验收
1. `npm run check` + `npm test` 通过；匹配边界单测通过。
2. GUI（需已鉴权桌面 webview 硬刷新）：
   - 当前会话 cwd 不匹配 → 右栏 guide 无「部署」卡片；
   - 打开 financial-v5 会话（7 环境共享）→ 右栏出现「部署」卡片（description「7 个环境 · …」）；
   - 点卡片 → 右栏开部署 tab，预选首环境；可全屏；
   - 切走不匹配工作空间 → 卡片消失、已开部署 tab 关闭；
   - 左栏常驻「部署」无回归；控制台无 `slot entry crashed`。

## 8. 风险
- stage1 在 matchStore 订阅回调内延迟 `registry.register`：需真实页面验证 guide 卡片随匹配增删。
- `closeIn` 超出 ISidebarRight 声明接口：防御性调用，缺失时回落当前会话 `close()`。
- 窄右栏内完整 Panel 较挤：依赖右栏全屏；如体验差后续可做紧凑部署视图。