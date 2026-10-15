# FigmaExporterMcp 开发约定

- 本仓库维护 MCP 服务和 Figma 插件源码。全局 Skill 唯一来源在 `/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp`；不要在仓库重新创建 `skills/` 副本。
- 修改前检查 Git 状态，保留用户已有改动。提交、推送和发布依用户明确要求执行。
- 工具 schema/编排按 `src/tools/` 分组；传输、文件会话和请求相关性属于 `src/relay.ts`。更新命令协议时同步检查插件 `handleCommand`。
- 日志只写 stderr，stdout 保持 MCP stdio 协议。只绑定 loopback，端口占用须验证 relay 身份。
- 文件选择按 session 隔离；不能把断开的文件请求自动发到其他连接。设计写入按用户明确的目标和范围执行，读取请求不授权修改。
- 新源码变更后运行 `npm run typecheck` 与相关真实行为检查；最终 `npm test` 先构建并检验生成产物。测试用隔离端口和插件替身；真实文件测试使用明确的目标和可清理的自有节点。
- `dist/` 为可运行产物，修改服务端后重新构建。插件无需打包，改动后重跑 Figma 开发插件。
- 本机脚本缓存、包缓存和测试输出放在全局 Skills 下；项目的 `node_modules` 使用忽略的链接。依赖以 lockfile 为准。
- 本机禁止 `releaseTest` / `releaseRelease` 及 `version_releasetest` / `version_release` 渠道构建；本仓库没有 Android 构建步骤。
