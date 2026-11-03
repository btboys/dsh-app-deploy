# dsh-app-deploy

[![npm](https://img.shields.io/npm/v/dsh-app-deploy)](https://www.npmjs.com/package/dsh-app-deploy)

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）插件：把交互式部署工具收进 DSH Web 面板。按环境分组管理配置，勾选模块、拖拽编排执行顺序，一键完成 Gradle 构建、rsync 同步与 SSH 远程命令，实时推送日志并保留执行记录。

## 特性

- **部署面板**：侧边栏「部署」入口，按环境分组管理，模块勾选 + 拖拽排序，一键部署。
- **实时日志**：SSE 推送 gradle / rsync / ssh 输出，断线按 `Last-Event-ID` 重连回放，绝不重复触发部署。
- **执行记录**：成功 / 失败 / 中断状态、耗时、失败模块与阶段、日志尾部，最多保留 500 条。
- **配置导入 / 导出**：JSON 导入时同 ID 覆盖、其余追加、非法配置整体拒绝；导出为同构 JSON（含 SSH 密码）。
- **数据本地化**：配置与记录存放在 `~/.dsh/dsh-app-deploy/`，含 SSH 密码，不进包、不进配置 patch。

## 要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | >= 22 |
| DSH | >= 0.2.1-rc.3, < 0.3.0 |
| 部署机工具 | `rsync`、`ssh`；配置 SSH 密码时另需 `sshpass` |

## 安装

插件发布在 npm，通过 DSH 插件管理器直接安装：

```text
plugin_manager → action: install_bundle → target: dsh-app-deploy@0.1.0
```

安装后刷新 DSH Web，左侧导航出现「部署」入口。

卸载用 `plugin_manager` 的 `remove_bundle`；升级先卸载再安装新版本（`target` 换成新的 `dsh-app-deploy@<version>`）。

## 配置

插件 Config 可在插件设置里改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/.dsh/dsh-app-deploy` | `envs.json` / `history.json` 所在目录 |
| `defaultProjectPath` | `''` | 新建环境的项目路径默认值 |

新装插件默认为空配置（不播种），环境通过「+ 添加环境」或「导入」创建。

## 使用

单模块部署流程：

```
清理构建目录 → ./gradlew <task> [-Pkey] [额外参数] [-PexpTime]
  → rsync [-r -t -z] 本地产物 → user@host:远程路径（前端加 --delete）
  → ssh 远程命令（可空）
  → 健康检查（可空：HTTP 2xx + success=true + code=200）
```

任一步非零中止本轮部署并记录失败模块 / 阶段。

## 项目结构

```
index.js        Host 入口：路由 /api/dsh-app-deploy（RPC + SSE）、生命周期
server/         配置、部署执行、历史、本机工具、健康检查
client.js       Client 面板（React，模块加载器格式）
locale/         插件标题与描述（en / zh）
test/           node --test
CONTRACT.md     Host/Client 接口契约
```

## 开发

```bash
npm run check   # node --check index.js && node --check client.js
npm test        # node --test
```
