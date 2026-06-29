# FigmaExporterMcp

FigmaExporterMcp is a local bridge that lets Codex and other MCP clients inspect, export, and modify Figma files through a development Figma plugin.

## Architecture

```text
Codex / MCP client <--stdio--> MCP Server <--WebSocket :3066--> Figma Plugin
                                  ^
                                  |
                     other Codex sessions proxy by HTTP
```

The first MCP server process owns the embedded relay on port `3066`. Additional Codex sessions start normally, detect the occupied port, and proxy commands to the relay owner. This allows multiple Codex sessions to share one Figma plugin connection without port conflicts.

## Local Paths

- Repository: `D:\LongWorkspace\FigmaExporterMcp`
- MCP entry: `dist/server.js`
- Server source: `src/server.ts`
- Plugin manifest: `figma-plugin/manifest.json`
- Plugin code: `figma-plugin/code.js`
- Plugin UI: `figma-plugin/ui.html`

## Install and Build

```powershell
cd D:\LongWorkspace\FigmaExporterMcp
npm install
npm run build
```

## Codex Global MCP Config

Add this to `C:\Users\chenlong\.codex\config.toml` and restart Codex:

```toml
[mcp_servers.figma_exporter_mcp]
command = 'node'
args = ['D:\LongWorkspace\FigmaExporterMcp\dist\server.js']
startup_timeout_sec = 120

[mcp_servers.figma_exporter_mcp.env]
FIGMA_EXPORTER_RELAY_PORT = '3066'
FIGMA_EXPORTER_EXPORT_DIR = 'D:\LongWorkspace\FigmaExporterMcp\exports'
```

## Install the Figma Plugin

1. Open Figma.
2. Go to Plugins -> Development -> Import plugin from manifest.
3. Select `D:\LongWorkspace\FigmaExporterMcp\figma-plugin\manifest.json`.
4. Run the plugin in the Figma file you want Codex to access.
5. The plugin auto-connects to `ws://localhost:3066`.

## Multi-Session Usage

- Use `get_connected_files` to list connected Figma files.
- Use `set_active_file` with a file name or channel keyword before mutating a design.
- Active file selection is scoped per Codex session, so sessions do not overwrite each other's active target.
- If a session logs `Proxy mode`, it is forwarding commands to the process that owns port `3066`; this is expected.

## Development Notes

- Modify `src/server.ts` for MCP tools, relay endpoints, proxy mode, and session routing.
- Modify `figma-plugin/code.js` for Figma Plugin API command implementations.
- Modify `figma-plugin/ui.html` for connection UI, reconnect behavior, and WebSocket messaging.
- Run `npm run build` after server changes and commit the regenerated `dist/` files.
- Keep `node_modules/`, `exports/`, logs, and `copilot_temp/` out of git.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `FIGMA_EXPORTER_RELAY_PORT` | `3066` | WebSocket/HTTP relay port |
| `FIGMA_EXPORTER_EXPORT_DIR` | `D:\LongWorkspace\FigmaExporterMcp\exports` in Codex config | Local image export directory |
| `FIGMA_EXPORTER_SESSION_ID` | auto-generated per MCP process | Optional stable session id for active-file routing |
