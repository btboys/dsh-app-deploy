# dsh-app-deploy

DeepSeek Harness（DSH）插件：把原 `financial-deploy-ui` 的交互式部署工具收进 DSH Web 面板。

- **侧边栏「部署」面板**：按环境分组管理配置，勾选模块、拖拽编排执行顺序，一键部署。
- **实时日志**：SSE 推送 gradle / rsync / ssh 输出，断线按 `Last-Event-ID` 重连回放，绝不重复触发部署。
- **执行记录**：成功/失败/中断状态、耗时、失败模块与阶段、日志尾部，最多保留 500 条。
- **数据本地化**：配置与记录存放在 `~/.dsh/dsh-app-deploy/`，含 SSH 密码，不进包、不进配置 patch。

## 安装（本地目录）

```text
plugin_manager → action: install_bundle → target: /Users/gson/IdeaProjects/dsh-app-deploy
```

安装后刷新 DSH Web，左侧导航出现「部署」入口。卸载用 `plugin_manager` 的 `remove_bundle`。

## 配置

插件 Config 可在插件设置里改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/.dsh/dsh-app-deploy` | `envs.json` / `history.json` 所在目录 |
| `defaultProjectPath` | `''` | 新建环境的项目路径默认值 |

## 从旧服务迁移

```bash
mkdir -p ~/.dsh/dsh-app-deploy
cp /Users/gson/IdeaProjects/financial-deploy-ui/envs.json ~/.dsh/dsh-app-deploy/envs.json
```

（`deploy-history.json` 可选复制为 `history.json`。）之后原 `start.sh` / `9610` 端口不再需要。

## 目录

```
index.js        Host 入口：路由 /api/dsh-app-deploy（RPC + SSE）、生命周期
server/         配置、部署执行、历史、本机工具、健康检查
client.js       Client 面板（React，模块加载器格式）
seed/           首次启动的播种数据
locale/         插件标题与描述
test/           node --test
CONTRACT.md     Host/Client 接口契约
```

## 开发

```bash
node --check index.js && node --check client.js
node --test
```

要求 Node >= 22；部署机需要 `rsync`、`ssh`，配置了 SSH 密码时需要 `sshpass`。

## 部署流程（单模块）

```
清理构建目录 → ./gradlew <task> [-Pkey] [额外参数] [-PexpTime]
  → rsync [-r -t -z] 本地产物 → user@host:远程路径（前端加 --delete）
  → ssh 远程命令（可空）
  → 健康检查（可空：HTTP 2xx + success=true + code=200）
```

任一步非零中止本轮部署并记录失败模块/阶段。
