# FigmaExporterMcp Maintenance Reference

## Repository

- Local repo: the FigmaExporterMcp checkout on this computer (each computer keeps its own clone path)
- GitHub remote: `git@github.com:ChenLongbetterapp/FigmaExporterMcp.git`
- MCP entry point: `dist/server.js`
- Source entry point: `src/server.ts`
- Figma dev plugin manifest: `figma-plugin/manifest.json`
- Codex skill: `skills/figma-exporter-mcp/`

## Codex Global MCP Config

The shared MCP server should be configured in the Codex home config (`$CODEX_HOME/config.toml`; on Windows this defaults to `%USERPROFILE%\.codex\config.toml`) as:

```toml
[mcp_servers.figma_exporter_mcp]
command = 'node'
args = ['<your-checkout>\dist\server.js']
startup_timeout_sec = 120

[mcp_servers.figma_exporter_mcp.env]
FIGMA_EXPORTER_RELAY_PORT = '3066'
FIGMA_EXPORTER_EXPORT_DIR = '<your-checkout>\exports'
```

Codex must be restarted before newly configured MCP tools appear in a session.

## Codex Skill Install

The skill source of truth is `skills/figma-exporter-mcp/` in this repository. Install or refresh it on a computer with:

```powershell
$repo = '<your-checkout>'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
Copy-Item -Recurse -Force (Join-Path $repo 'skills\figma-exporter-mcp') (Join-Path $codexHome 'skills')
```

Restart Codex after copying.

## Architecture

```text
Codex session A MCP server -- owns relay on :3066 -- Figma plugin WebSocket
Codex session B MCP server -- proxy HTTP to :3066
Codex session C MCP server -- proxy HTTP to :3066
```

The owning process accepts Figma plugin WebSocket connections and exposes HTTP proxy endpoints for other MCP server processes. This avoids port conflicts and lets several Codex sessions use the same Figma plugin connection.

## Validation

Run these checks after code changes:

```powershell
cd <your-checkout>
npm run build
git status --short
```

If relay behavior changed, test manually with two Codex sessions: one should log relay mode, the other should log proxy mode.
