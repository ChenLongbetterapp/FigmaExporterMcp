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

- Paths below are relative to the repository root; each computer keeps its own checkout location.
- MCP entry: `dist/server.js`
- Server source: `src/server.ts`
- Plugin manifest: `figma-plugin/manifest.json`
- Plugin code: `figma-plugin/code.js`
- Plugin UI: `figma-plugin/ui.html`

## Install and Build

```powershell
cd <your-checkout>
npm install
npm run build
```

## Install the Codex Skill

The skill for this bridge lives in `skills/figma-exporter-mcp/` in this repository and is the source of truth. Codex discovers skills under `$CODEX_HOME/skills/<name>/`, so install or refresh it by copying that folder into the Codex home of the current computer:

```powershell
$repo = '<your-checkout>'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
New-Item -ItemType Directory -Force -Path (Join-Path $codexHome 'skills') | Out-Null
Copy-Item -Recurse -Force (Join-Path $repo 'skills\figma-exporter-mcp') (Join-Path $codexHome 'skills')
```

Restart Codex after installing or updating the skill. Operating rules are in `skills/figma-exporter-mcp/SKILL.md`; maintenance details are in `skills/figma-exporter-mcp/references/maintenance.md`.

## Codex Global MCP Config

Add this to the Codex home config (`$CODEX_HOME/config.toml`; on Windows this defaults to `%USERPROFILE%\.codex\config.toml`) and restart Codex:

```toml
[mcp_servers.figma_exporter_mcp]
command = 'node'
args = ['<your-checkout>\dist\server.js']
startup_timeout_sec = 120

[mcp_servers.figma_exporter_mcp.env]
FIGMA_EXPORTER_RELAY_PORT = '3066'
FIGMA_EXPORTER_EXPORT_DIR = '<your-checkout>\exports'
```

## Install the Figma Plugin

1. Open Figma.
2. Go to Plugins -> Development -> Import plugin from manifest.
3. Select `figma-plugin/manifest.json` inside your checkout.
4. Run the plugin in the Figma file you want Codex to access.
5. The plugin auto-connects to `ws://localhost:3066`.

## Multi-Session Usage

- Use `get_connected_files` to list connected Figma files.
- Use `set_active_file` with a file name or channel keyword before mutating a design.
- Active file selection is scoped per Codex session, so sessions do not overwrite each other's active target.
- If a session logs `Proxy mode`, it is forwarding commands to the process that owns port `3066`; this is expected.
- Some Figma contexts, especially team library files, may not expose `figma.fileKey` to the plugin. This is normal: the relay still treats the deterministic channel and file name as a connected file, and commands can be routed with `set_active_file`.
- If the plugin UI says "Connected" but `get_connected_files` says no files, check `http://localhost:3066/channels`. A listed channel means the plugin is connected; restart Codex or rebuild/reload the MCP server if the MCP tool is using an older relay build.

## Design Inspection and Export

The read pipeline is visible-only by design. A node is excluded when either the node itself or any ancestor is hidden. Invisible branches inside component instances are skipped through Figma's native `skipInvisibleInstanceChildren` optimization.

- `get_document_info` loads the document page index and returns every page plus its visible top-level layers.
- `get_design_context` returns implementation-ready hierarchy data for `selection`, `current_page`, or `all_pages`. It includes geometry, auto-layout, constraints, fills, strokes, effects, text runs, component/instance metadata, bound variables, design-token summaries, screens, and recognized assets. Depth is unlimited unless `options.maxDepth` is supplied.
- `get_node_css` returns Figma Inspect CSS for up to 100 visible nodes. Use it as a web implementation aid; the platform-neutral fields from `get_design_context` are the source for Compose.
- `list_design_assets` scans all pages by default and recognizes Figma `isAsset` nodes, image fills, explicit export settings, slices, vector/media nodes, and top-level screen frames.
- `export_design_assets` exports all recognized visible assets as PNG to `<export dir>/<file>/<platform>/<page>/`. Android is always 4x. Web uses 4x for tiny assets, 3x for small/medium assets, and normally 2x for larger UI, then reduces the scale only when needed to cap oversized output around 4096 px or 16 MP.
- `export_node_as_image` remains available for a targeted export and now refuses hidden nodes.

Typical implementation workflow:

```text
get_connected_files
set_active_file (when more than one file is connected)
get_document_info
get_design_context(scope: "current_page" or "all_pages")
get_node_css(nodeIds: [...])               # web only, when useful
export_design_assets(scope: "all_pages", platform: "android" or "web")
```

After changing `figma-plugin/code.js`, stop and rerun the development plugin in Figma. After rebuilding `src/server.ts`, restart the Codex MCP process (and the relay owner on port `3066`) so the new tool schema is registered.

The traversal/export behavior follows the official Figma Plugin API documentation for [`loadAllPagesAsync`](https://developers.figma.com/docs/plugins/api/figma/#loadallpagesasync), [`skipInvisibleInstanceChildren`](https://developers.figma.com/docs/plugins/api/properties/figma-skipinvisibleinstancechildren/), [`visible`](https://developers.figma.com/docs/plugins/api/properties/nodes-visible/), [`DocumentNode`](https://developers.figma.com/docs/plugins/api/DocumentNode/), and [`exportAsync`](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/).

## Development Notes

- Modify `src/server.ts` for MCP tools, relay endpoints, proxy mode, and session routing.
- Modify `figma-plugin/code.js` for Figma Plugin API command implementations.
- Modify `figma-plugin/ui.html` for connection UI, reconnect behavior, and WebSocket messaging.
- Run `npm run build` after server changes and commit the regenerated `dist/` files.
- Run `npm test` to verify all-page traversal, unlimited nesting, inherited hidden-state filtering, token extraction, asset recognition, and hidden export rejection.
- Keep `node_modules/`, `exports/`, logs, and `copilot_temp/` out of git.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `FIGMA_EXPORTER_RELAY_PORT` | `3066` | WebSocket/HTTP relay port |
| `FIGMA_EXPORTER_EXPORT_DIR` | `<working-directory>/exports` | Local image export directory |
| `FIGMA_EXPORTER_SESSION_ID` | auto-generated per MCP process | Optional stable session id for active-file routing |
