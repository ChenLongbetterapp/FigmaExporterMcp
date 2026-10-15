# 本机维护

源码仓库：`/Users/dp1_dev2/Documents/CompanyProject/FigmaExporterMcp`。
全局能力与运行数据：`/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp`。
Node 与 npm：`/Users/dp1_dev2/Documents/Skills/.runtime/node/bin`。

## 构建与同步运行副本

```bash
export PATH=/Users/dp1_dev2/Documents/Skills/.runtime/node/bin:$PATH
npm run typecheck
npm test
/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/run.sh stop
node /Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/refresh-runtime.mjs
/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/run.sh start
```

`stop` 只结束启动器记录且 `/health` PID 匹配的自有 relay；遇到其他进程不强杀。`stop` 等待自有进程退出，`start/status` 核对安装与运行中的构建摘要。源码变更先构建再同步。`dist/build.json` 同时记录源码输入和产物摘要；任何一边被修改，刷新脚本都会拒绝覆盖运行副本。同步生成 `runtime.json`，记录 upstream commit、源内容摘要和打包时间；没有自动 Git 提交或推送。

依赖使用 lockfile。首次拉取到本机时，先把 `package.json`、`package-lock.json` 放入 Skill 的 `cache/build/`，在那里 `npm ci`，项目 `node_modules` 链接该目录。不要在仓库运行会重建本地依赖目录的安装命令。缓存由 npm 包管理，脚本、依赖和导出都留在全局 Skills 下。

运行副本的 manifest 路径稳定：`scripts/runtime/figma-plugin/manifest.json`。插件源改变后需在 Figma 停止并重跑；修改服务端后重启 relay 与相应 MCP 进程。仅同步文件不会更新已经执行中的 JavaScript。

## Codex MCP 配置

`~/.codex/config.toml` 中配置本地 stdio 命令，官方支持的字段见 [OpenAI MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本机条目为：

```toml
[mcp_servers.figma_exporter_mcp]
command = "/Users/dp1_dev2/Documents/Skills/.runtime/node/bin/node"
args = ["/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/runtime/dist/server.js"]
cwd = "/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/cache"
startup_timeout_sec = 30
tool_timeout_sec = 180

[mcp_servers.figma_exporter_mcp.env]
FIGMA_EXPORTER_RELAY_PORT = "3066"
FIGMA_EXPORTER_EXPORT_DIR = "/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/cache/exports"
```

配置保存后重载对应 MCP 连接；当前会话尚未暴露原生工具时可直接使用全局 CLI。CLI 也通过 stdio MCP SDK 调用，保留参数校验、导出编排和统一文件选择，不把原始 `/api/command` 当成完整 MCP 接口。

## 诊断

- `run.sh doctor`：检查运行文件、Node、relay 和插件连接。
- `run.sh status`：查看 `/health` 与连接文件；无插件时不会伪造成功。
- `cache/relay.log`：自有后台 relay 的 stderr 日志。
- `cache/reads/<channel>/`：显式保存的读取与操作结果。
- `cache/exports/`、`cache/images/`：服务端和客户端的本地图像产物。
- 只有一个连接时可默认选择；多个连接用精确 channel。空 file key 正常，空连接列表才需要排查插件运行状态。
- 超时后先读取实际状态，尤其不要自动重试创建或批量写入。

本机电脑控制曾错误解析 Figma 的安装镜像应用标识；当 UI 自动化不可接管时，可由用户完成一次 manifest 导入。后续文档读写由已连接的插件完成，不依赖窗口自动化。

## Skill 客户端验证

```bash
/Users/dp1_dev2/Documents/Skills/.runtime/node/bin/node --test /Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/tests/client.test.mjs
```

该测试使用全局缓存内的隔离夹具，检查写入授权开关、精确文件选择、结构化失败、缓存写入失败时保留回执、SVG/PDF资源解码，以及拒绝过时源码/损坏产物。不会连接真实Figma。
