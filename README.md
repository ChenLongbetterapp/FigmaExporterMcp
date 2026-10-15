# FigmaExporterMcp

通过本地开发插件读取、导出和修改当前打开的 Figma 设计文件。链路为 MCP stdio → 本机 relay → Figma 插件 UI → Plugin API；不使用 Figma REST Token。

代码入口为 `src/server.ts`。共注册 **69 个工具**：16 个内容读取、49 个设计操作、2 个资源导出和2个文件路由工具；另有6个策略提示。

## 本机使用

全局 Skill、客户端脚本和运行副本统一维护于 `/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/`，发现入口为 `~/.codex/skills/figma-exporter-mcp`。业务仓库不保存 Skill 副本。

```bash
/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/run.sh start
/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/run.sh status
/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/run.sh call get_document_info --file '<status 返回的 channel>' --save document-index
```

Figma 中导入全局运行副本的 `scripts/runtime/figma-plugin/manifest.json`，在目标文件运行 FigmaExporter。默认连接 `ws://localhost:3066`。文件名、连接通道用于发现目标；`fileKey` 为空是 Plugin API 权限边界，不能仅据此判断未连接，也不能声称已验证某个 URL 的 file key。

`call` 通过真正的 MCP 工具执行并校验参数。设计写入另需 `--write`；此标志表示调用者已核对用户要求的范围，不代替用户授权。调用完成后读取真实节点验证结果；批量操作不提供事务回滚。

## 开发

Node.js 22 或更新版本；本机运行时在 `/Users/dp1_dev2/Documents/Skills/.runtime/node/bin/`。依赖的实际目录在全局 Skill 的 `cache/build/node_modules`，本仓库 `node_modules` 为忽略的符号链接。

依赖安装与链接按 [本机维护](docs/maintenance.md) 执行，包缓存和依赖不落在业务项目。链接准备好后：

```bash
export PATH=/Users/dp1_dev2/Documents/Skills/.runtime/node/bin:$PATH
npm run typecheck
npm test
```

`npm test` 先构建再运行测试。构建使用 esbuild 和 TypeScript，输出 `dist/`；生成文件随代码维护。用 esbuild 独立执行器替代 tsup/Rollup 后，构建无需在签名 Node 进程加载第三方原生扩展。测试的 WebSocket 插件为隔离替身，不会修改真实 Figma 文件。

更新本机全局运行副本见 [维护说明](docs/maintenance.md)。更新插件代码后需要在 Figma 停止并重跑插件；仅更新服务端时重启自己管理的 relay。不要终止其他程序或其他会话拥有的进程。

## 结构与行为

- [架构与数据流](docs/architecture.md)：模块职责、会话路由、读取和写入调用链。
- [工具能力](docs/tools.md)：能力分组、导出语义和操作限制。
- [本机维护](docs/maintenance.md)：构建、运行副本、MCP 配置和诊断。
- [Review 与验收](docs/validation.md)：问题修复、自动化检查、真实文件读写和清理的实际覆盖。

原仓库绑定具体 Windows 项目路径、节点 ID 的7个一次性脚本及旧 Skill 已保存至全局私有缓存 `upstream-legacy.tar.gz`，不再作为执行入口。
