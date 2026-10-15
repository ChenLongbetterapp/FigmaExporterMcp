---
name: figma-exporter-mcp
description: Use when Codex needs the shared local FigmaExporterMcp bridge for Figma design inspection, node export, design modification, or maintenance of the Figma plugin/MCP server. Trigger when a user mentions FigmaExporterMcp, the custom Figma plugin, connecting Codex to Figma, modifying plugin code, exporting Figma nodes/assets, or supporting multiple Codex sessions against one Figma plugin connection.
---

# FigmaExporterMcp

## Overview

Use the FigmaExporterMcp checkout to connect Codex MCP clients to Figma through the local development plugin. The server owns or proxies to a WebSocket relay on port `3066`, so multiple Codex sessions can share one active Figma plugin connection.

Each computer keeps its own checkout location. Locate the repository root by finding the directory that contains `package.json`, `src/server.ts`, and `figma-plugin/manifest.json`; never assume a fixed path.

## Quick Workflow

1. Locate the FigmaExporterMcp checkout on this computer (each computer keeps its own clone path). If it is missing, clone `git@github.com:ChenLongbetterapp/FigmaExporterMcp.git` and follow the repository `README.md` for build, MCP config, plugin install, and skill install.
2. Check whether port `3066` already has a relay owner. If it does not, start the built server yourself before asking the user to reconnect or restart anything:
   ```powershell
   $repo = '<path-to-your-checkout>'
   Start-Process -FilePath 'node' -ArgumentList 'dist/server.js' `
     -WorkingDirectory $repo -WindowStyle Hidden `
     -RedirectStandardOutput "$repo\copilot_temp\server-stdout.log" `
     -RedirectStandardError "$repo\copilot_temp\server-stderr.log"
   ```
   Then verify `http://localhost:3066/channels`. The Figma plugin reconnects automatically when it is already open.
3. If changing code, edit the source files directly in that repo:
   - `src/server.ts` for MCP tools, relay, proxy, session routing, exports.
   - `figma-plugin/code.js` for Figma Plugin API commands.
   - `figma-plugin/ui.html` for WebSocket UI, channel join, reconnect, and plugin messaging.
4. Run `npm install` only when dependencies are missing or changed.
5. Run `npm run build` after TypeScript server changes; this regenerates `dist/server.js`.
6. In Figma, install or reload the dev plugin from `figma-plugin/manifest.json` inside the checkout.
7. Start the plugin in the target Figma file; it auto-connects to `ws://localhost:3066`.
8. In Codex, use the MCP tools if available. If not visible, use the relay HTTP endpoints for the current task, then restart Codex after confirming the global MCP config points to `dist/server.js` of this checkout so future tasks expose the tools directly.

## Design Inspection Workflow

1. Call `get_connected_files`, then `set_active_file` when more than one file is connected.
2. Call `get_document_info` to enumerate every page and its visible top-level layers.
3. Use `get_design_context` with the smallest useful scope:
   - `selection` for a focused component or screen.
   - `current_page` for normal implementation work.
   - `all_pages` for a complete file audit or export.
4. Treat `get_design_context` as the platform-neutral source for hierarchy, bounds, auto-layout, constraints, paints, effects, text runs, components, variables, and token summaries. It excludes nodes hidden directly or through an ancestor and reads all hierarchy levels unless `maxDepth` is explicitly supplied.
5. For web work, call `get_node_css` only for the small set of nodes where Figma Inspect CSS accelerates implementation. For Compose, use the structured context instead of translating CSS blindly.
6. Call `list_design_assets` to review recognized visible screens/assets. It scans all pages by default.
7. Call `export_design_assets` for bulk local PNG export, optionally filtering by page, kind, or node ID. For Android icons, use `platform: "android"` for fixed 4x PNG. For illustrations, request an explicit 3x PNG with `export_node_as_image`; do not apply the icon batch default to every asset. Use `platform: "web"` for web exports and SVG/PDF/JPG for source inspection or explicitly requested deliverables.

### Android PNG density rules

Android icon delivery defaults to PNG; delivering SVG/XML vectors instead requires an explicit user exception, even when the vector geometry matches the design.

- Android icons default to transparent 4x PNG files in `drawable-xxxhdpi`. `export_design_assets(platform: "android")` is suitable for bulk fixed 4x icon export.
- Export scale does not change the UI size in dp: a `24dp` icon exports as `96px` at 4x and still displays as `24dp`.
- Illustrations and background artwork default to true 3x PNG files in `drawable-xxhdpi`. Export these explicitly by node, for example `export_node_as_image(..., format: "PNG", scale: 3)`.
- Do not redraw or replace requested or designed bitmap icons with approximate XML or SVG assets.
- Do not apply the 4x icon rule to all artwork. Another scale is allowed when the actual display size, asset purpose, or an existing resource protocol requires it; record the reason.
- Keep source PNG files through primary acceptance. Convert them to WebP only when an explicit repository submission or publishing rule requires it.

After changing the plugin source, stop and rerun the development plugin in Figma. After rebuilding the server, restart the MCP process that owns relay port `3066`; otherwise existing sessions may continue exposing the previous tool schema.

## Connection Checks

- Treat a plugin UI status of "Connected to server in channel: ..." as a real relay connection even when the file key is blank. Figma may not expose `figma.fileKey` for team library files, but the channel and file name are sufficient for the local relay.
- Always call `get_connected_files` first. In multi-session/proxy mode it queries `http://localhost:3066/channels?sessionId=...`; the relay must handle query strings on `/channels`.
- If `get_connected_files` says no files while the plugin UI is connected, inspect `http://localhost:3066/channels` before telling the user to reconnect. If a channel is listed, use `set_active_file` with the file name or channel keyword, or restart Codex if an older relay build is still owning port `3066`.
- A blank `fileKey` in `/channels` is not an error by itself. Do not report "not connected" solely because `fileKey` is empty.

## Multi-Session Rules

- Keep the relay port at `3066` unless there is a conflict.
- The first MCP server process owns the relay; later Codex sessions enter proxy mode and forward commands to the relay owner.
- Each Codex MCP process gets its own `FIGMA_EXPORTER_SESSION_ID` or an auto-generated session id; `set_active_file` is scoped per session.
- Always call `get_connected_files` before mutating a design when multiple Figma files may be connected.
- Use `set_active_file` with a file name or channel keyword before commands that should target a specific file.

## Maintenance Guidelines

- Preserve the plugin message protocol unless updating both sides together: server sends `broadcast` messages; plugin returns `message` responses with matching ids.
- Do not remove proxy HTTP endpoints: `/channels`, `/api/command`, and `/api/set_active_file` are needed for multiple Codex sessions.
- Keep generated `dist/` committed because MCP config points to `dist/server.js`.
- Keep `node_modules/`, logs, temp exports, and `copilot_temp/` out of git.
- If the plugin stops connecting, check the Figma plugin UI port, Windows firewall/local port conflicts, and whether another process owns `3066`.

## References

Read `references/maintenance.md` when changing relay/session behavior or updating Codex MCP configuration.
