#!/usr/bin/env node

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/logger.ts
var logger = {
  info: (message) => process.stderr.write(`[INFO] ${message}
`),
  debug: (message) => process.stderr.write(`[DEBUG] ${message}
`),
  warn: (message) => process.stderr.write(`[WARN] ${message}
`),
  error: (message) => process.stderr.write(`[ERROR] ${message}
`),
  log: (message) => process.stderr.write(`[LOG] ${message}
`)
};

// src/relay.ts
import WebSocket, { WebSocketServer } from "ws";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
var RELAY_SERVICE = "figma-exporter-mcp";
var RELAY_PROTOCOL_VERSION = 1;
var BUILD_ID = JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")).sourceHash;
var connectedFiles = /* @__PURE__ */ new Map();
var activeFileBySession = /* @__PURE__ */ new Map();
var operationFile = new AsyncLocalStorage();
async function getOperationFile() {
  const pinned = operationFile.getStore();
  if (pinned) return pinned;
  const file = relayActive ? getActiveFile() : (await proxyGetConnectedFiles()).find((item) => item.active);
  if (!file) throw new Error("No unique Figma file selected. Connect the plugin, then set_active_file with an exact channel when multiple files are connected.");
  return { channel: file.channel, fileName: file.fileName, fileKey: file.fileKey };
}
async function withFileTarget(work) {
  return operationFile.run(await getOperationFile(), work);
}
var pendingRequests = /* @__PURE__ */ new Map();
var RELAY_PORT = parseInt(process.env.FIGMA_EXPORTER_RELAY_PORT || "3066", 10);
var DEFAULT_SESSION_ID = "default";
var MCP_SESSION_ID = process.env.FIGMA_EXPORTER_SESSION_ID || `mcp-${uuidv4()}`;
var relayActive = false;
function normalizeSessionId(sessionId) {
  const normalized = (sessionId || "").trim();
  return normalized || DEFAULT_SESSION_ID;
}
function getFallbackFile() {
  return connectedFiles.size === 1 ? connectedFiles.values().next().value : null;
}
function getActiveChannelForSession(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const sessionChannel = activeFileBySession.get(normalizedSessionId);
  if (activeFileBySession.has(normalizedSessionId)) return sessionChannel && connectedFiles.has(sessionChannel) ? sessionChannel : null;
  return getFallbackFile()?.channel || null;
}
function getActiveFile(sessionId = MCP_SESSION_ID) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const activeChannel = getActiveChannelForSession(normalizedSessionId);
  if (activeChannel && connectedFiles.has(activeChannel)) {
    activeFileBySession.set(normalizedSessionId, activeChannel);
    return connectedFiles.get(activeChannel);
  }
  return null;
}
function setActiveFileForSession(keyword, sessionId = MCP_SESSION_ID) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const kw = (keyword || "").trim().toLowerCase();
  if (!kw) {
    activeFileBySession.set(normalizedSessionId, null);
    return { matched: false, activeFileChannel: null };
  }
  let matchedChannel = null;
  if (connectedFiles.has(keyword)) {
    matchedChannel = keyword;
  } else {
    const entries = [...connectedFiles.entries()];
    const exact = entries.filter(([channel, file]) => channel.toLowerCase() === kw || file.fileName.toLowerCase() === kw || file.fileKey && file.fileKey.toLowerCase() === kw);
    const matches = exact.length ? exact : entries.filter(([channel, file]) => file.fileName.toLowerCase().includes(kw) || channel.toLowerCase().includes(kw));
    if (matches.length === 1) matchedChannel = matches[0][0];
  }
  if (!matchedChannel) {
    activeFileBySession.set(normalizedSessionId, null);
    return { matched: false, activeFileChannel: null };
  }
  activeFileBySession.set(normalizedSessionId, matchedChannel);
  return {
    matched: true,
    activeFileChannel: matchedChannel,
    file: connectedFiles.get(matchedChannel)
  };
}
function startRelay(port = RELAY_PORT) {
  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: RELAY_SERVICE, protocolVersion: RELAY_PROTOCOL_VERSION, version: "2.1.0", buildId: BUILD_ID, pid: process.pid }));
      return;
    }
    if (req.headers.origin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Browser-origin HTTP requests are not supported" }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (requestUrl.pathname === "/channels" && req.method === "GET") {
      const sessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"));
      const sessionActiveChannel = getActiveChannelForSession(sessionId);
      const result = [];
      for (const [channel, file] of connectedFiles.entries()) {
        result.push({
          channel,
          fileName: file.fileName,
          fileKey: file.fileKey,
          clients: 1,
          joinedAt: file.connectedAt,
          active: channel === sessionActiveChannel
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (requestUrl.pathname === "/api/command" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { command, params, timeoutMs, sessionId, targetChannel } = JSON.parse(body);
          const result = await sendCommandToFigma(
            command,
            params,
            timeoutMs || 3e4,
            normalizeSessionId(sessionId),
            targetChannel
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }
    if (requestUrl.pathname === "/api/set_active_file" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const { keyword, sessionId } = JSON.parse(body);
          const result = setActiveFileForSession(keyword, normalizeSessionId(sessionId));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            matched: result.matched,
            activeFileChannel: result.activeFileChannel,
            fileName: result.file?.fileName
          }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("FigmaExporter MCP Relay running");
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("error", (err) => {
    logger.warn(`WebSocketServer error (handled): ${err.message}`);
  });
  wss.on("connection", (pluginWs) => {
    logger.info("New Figma plugin connected");
    pluginWs.send(JSON.stringify({
      type: "system",
      message: "Please join a channel to start chatting"
    }));
    let pluginChannel = null;
    pluginWs.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName) return;
          pluginChannel = channelName;
          connectedFiles.set(channelName, {
            ws: pluginWs,
            channel: channelName,
            fileName: data.fileName || channelName,
            fileKey: data.fileKey || "",
            connectedAt: Date.now()
          });
          logger.info(`Figma file registered: ${data.fileName || channelName} (${channelName})`);
          pluginWs.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));
          pluginWs.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName
            },
            channel: channelName
          }));
          return;
        }
        if ((data.type === "message" || data.type === "progress_update") && data.message) {
          const msg = data.message;
          if (msg.type === "progress_update") {
            const progressData = msg.data;
            const requestId = data.id || msg.id || "";
            if (requestId && pendingRequests.get(requestId)?.socket === pluginWs) {
              const request = pendingRequests.get(requestId);
              request.lastActivity = Date.now();
              logger.info(`Progress: ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
            }
            return;
          }
          if (msg.id && pendingRequests.get(msg.id)?.socket === pluginWs) {
            const request = pendingRequests.get(msg.id);
            clearTimeout(request.timeout);
            if (msg.error) {
              request.reject(new Error(msg.error));
            } else if (Object.prototype.hasOwnProperty.call(msg, "result")) {
              request.resolve(msg.result);
            }
            if (!msg.error && !Object.prototype.hasOwnProperty.call(msg, "result")) {
              request.reject(new Error("Figma returned a malformed response without result or error"));
            }
            pendingRequests.delete(msg.id);
            return;
          }
          logger.debug(`Unmatched message from plugin: ${JSON.stringify(msg).substring(0, 200)}`);
        }
      } catch (err) {
        logger.error(`Error parsing plugin message: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    pluginWs.on("close", () => {
      for (const [id, request] of pendingRequests) {
        if (request.socket === pluginWs) {
          clearTimeout(request.timeout);
          pendingRequests.delete(id);
          request.reject(new Error("The selected Figma plugin disconnected; reconnect or explicitly select a file."));
        }
      }
      if (pluginChannel) {
        logger.info(`Figma file disconnected: ${pluginChannel}`);
        if (connectedFiles.get(pluginChannel)?.ws !== pluginWs) return;
        connectedFiles.delete(pluginChannel);
      }
    });
    pluginWs.on("error", (err) => {
      logger.error(`Plugin WebSocket error: ${err.message}`);
    });
  });
  return new Promise((resolve, reject) => {
    httpServer.listen(port, "127.0.0.1", () => {
      relayActive = true;
      logger.info(`FigmaExporter relay listening on port ${port}`);
      resolve();
    });
    httpServer.on("error", async (err) => {
      if (err.code === "EADDRINUSE") {
        relayActive = false;
        try {
          const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2e3) });
          const info = await health.json();
          if (!health.ok || info.service !== RELAY_SERVICE || info.protocolVersion !== RELAY_PROTOCOL_VERSION) throw new Error("incompatible relay identity");
          if (info.buildId !== BUILD_ID) throw new Error("relay build differs; restart the owned relay before using the updated runtime");
          logger.info(`Proxy mode: forwarding to the verified relay on ${port}`);
        } catch (error) {
          reject(new Error(`Port ${port} belongs to an unknown or incompatible service; refusing to proxy (${error instanceof Error ? error.message : String(error)})`));
          return;
        }
      } else {
        relayActive = false;
        reject(err);
        return;
      }
      resolve();
    });
  });
}
function sendCommandToFigma(command, params = {}, timeoutMs = 3e4, sessionId = MCP_SESSION_ID, targetChannel = operationFile.getStore()?.channel) {
  if (!relayActive) {
    return proxyCommandViaHttp(command, params, timeoutMs, sessionId, targetChannel);
  }
  return new Promise((resolve, reject) => {
    const file = targetChannel ? connectedFiles.get(targetChannel) : getActiveFile(sessionId);
    if (!file) {
      reject(new Error("No unique Figma file selected. Connect the plugin, then set_active_file with an exact channel when multiple files are connected."));
      return;
    }
    if (file.ws.readyState !== WebSocket.OPEN) {
      connectedFiles.delete(file.channel);
      reject(new Error(`Figma file "${file.fileName}" disconnected.`));
      return;
    }
    const id = uuidv4();
    const request = {
      type: "broadcast",
      message: {
        id,
        command,
        params: {
          ...params,
          commandId: id
        }
      },
      sender: "server",
      channel: file.channel
    };
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} timed out after ${timeoutMs / 1e3}s`);
        reject(new Error("Request to Figma timed out"));
      }
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now(),
      socket: file.ws
    });
    logger.info(`\u2192 ${command} \u2192 ${file.fileName}`);
    file.ws.send(JSON.stringify(request), (error) => {
      if (!error || !pendingRequests.has(id)) return;
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(error);
    });
  });
}
async function proxyCommandViaHttp(command, params, timeoutMs, sessionId, targetChannel) {
  const url = `http://127.0.0.1:${RELAY_PORT}/api/command`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5e3);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, params, timeoutMs, sessionId: normalizeSessionId(sessionId), targetChannel }),
      signal: controller.signal
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `Relay returned HTTP ${res.status}`);
    }
    return data.result;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Proxy request to relay timed out");
    }
    throw new Error(`Proxy to relay failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
async function proxyGetConnectedFiles(sessionId = MCP_SESSION_ID) {
  const url = `http://127.0.0.1:${RELAY_PORT}/channels?sessionId=${encodeURIComponent(normalizeSessionId(sessionId))}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5e3) });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("application/json")) {
      logger.warn(`Unexpected /channels response: HTTP ${res.status} ${contentType || "unknown content-type"}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn(`Failed to fetch connected files from relay: ${err.message || String(err)}`);
    return [];
  }
}

// src/tools/register.ts
function failedValue(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(failedValue);
  const data = value;
  if (data.success === false) return true;
  for (const key of ["failed", "failedCount", "nodesFailed", "annotationsFailed", "replacementsFailed"]) {
    if (typeof data[key] === "number" && data[key] > 0) return true;
  }
  if (Array.isArray(data.missingNodeIds) && data.missingNodeIds.length > 0) return true;
  return Array.isArray(data.results) && data.results.some(failedValue);
}
function normalizeToolResult(result) {
  const failed = result.isError || result.content.some((item) => {
    if (item.type !== "text") return false;
    try {
      return failedValue(JSON.parse(item.text));
    } catch {
      return /^(Error\b|Failed\b|Proxy error:|No (?:file matching|Figma files connected\.))/.test(item.text);
    }
  });
  return failed ? { ...result, isError: true } : result;
}
function registerTool(server2, name, description, schema, callback, pinFile = true) {
  return server2.tool(name, description, schema, async (args) => {
    try {
      return normalizeToolResult(await (pinFile ? withFileTarget(() => callback(args)) : callback(args)));
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}

// src/tools/files.ts
import { z } from "zod";
function registerFileTools(server2) {
  registerTool(
    server2,
    "get_connected_files",
    "List all Figma design files currently connected via the FigmaExporter plugin. Shows which file is active (receives commands).",
    {},
    async () => {
      if (!relayActive) {
        const remoteFiles = await proxyGetConnectedFiles(MCP_SESSION_ID);
        if (remoteFiles.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No Figma files connected. Open a Figma file and start the FigmaExporter plugin.\n(Running in proxy mode \u2014 forwarding to relay on port " + RELAY_PORT + ")"
            }]
          };
        }
        const files2 = remoteFiles.map(
          (f, i) => `${i + 1}. ${f.active ? "\u2192 " : "  "}**${f.fileName}** (channel: ${f.channel}, key: ${f.fileKey || "N/A"})`
        );
        return {
          content: [{
            type: "text",
            text: `Connected Figma files via relay (${remoteFiles.length}):
${files2.join("\n")}

\u2192 = active file for this Codex session (${MCP_SESSION_ID})
(proxy mode)`
          }]
        };
      }
      if (connectedFiles.size === 0) {
        return {
          content: [{
            type: "text",
            text: "No Figma files connected. Open a Figma file and start the FigmaExporter plugin."
          }]
        };
      }
      const files = Array.from(connectedFiles.values()).map((f, i) => {
        const isActive = f.channel === getActiveChannelForSession(MCP_SESSION_ID);
        return `${i + 1}. ${isActive ? "\u2192 " : "  "}**${f.fileName}** (channel: ${f.channel}, key: ${f.fileKey || "N/A"})`;
      });
      return {
        content: [{
          type: "text",
          text: `Connected Figma files (${connectedFiles.size}):
${files.join("\n")}

\u2192 = active file for this Codex session (${MCP_SESSION_ID})`
        }]
      };
    },
    false
  );
  registerTool(
    server2,
    "set_active_file",
    "Switch which Figma file receives commands. Pass a file name or channel keyword to match.",
    {
      keyword: z.string().describe("File name or channel name keyword to match")
    },
    async ({ keyword }) => {
      if (!relayActive) {
        try {
          const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/set_active_file`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keyword, sessionId: MCP_SESSION_ID }),
            signal: AbortSignal.timeout(5e3)
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || `Relay returned HTTP ${res.status}`);
          if (data.matched) {
            return {
              content: [{
                type: "text",
                text: `Active file for this Codex session set to: ${data.fileName || data.activeFileChannel} (${data.activeFileChannel}) via proxy`
              }]
            };
          }
          return {
            content: [{
              type: "text",
              text: `No file matching "${keyword}". Use get_connected_files to see available files.`
            }]
          };
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `Proxy error: ${err.message}`
            }]
          };
        }
      }
      const result = setActiveFileForSession(keyword, MCP_SESSION_ID);
      if (result.matched && result.file) {
        return {
          content: [{
            type: "text",
            text: `Active file for this Codex session set to: ${result.file.fileName} (channel: ${result.file.channel})`
          }]
        };
      }
      return {
        content: [{
          type: "text",
          text: `No file matching "${keyword}". Use get_connected_files to see available files.`
        }]
      };
    },
    false
  );
}

// src/tools/read.ts
import { z as z3 } from "zod";

// src/design.ts
import { z as z2 } from "zod";
var nodeFilterOptionsSchema = z2.object({
  includeChildren: z2.boolean().optional().describe("Include recursive child nodes. Defaults to true."),
  includeVectors: z2.boolean().optional().describe("Include VECTOR nodes. Defaults to true."),
  includeText: z2.boolean().optional().describe("Include TEXT nodes and characters. Defaults to true."),
  includeInvisible: z2.boolean().optional().describe("Deprecated and ignored. Hidden nodes and hidden ancestor branches are always excluded."),
  includeFills: z2.boolean().optional().describe("Include fill/stroke metadata. Defaults to true."),
  includeEffects: z2.boolean().optional().describe("Include effect metadata. Defaults to true."),
  includeTextSegments: z2.boolean().optional().describe("Include mixed-style text runs. Defaults to true."),
  includeComponentMetadata: z2.boolean().optional().describe("Include component, instance, variant, and bound-variable metadata. Defaults to true."),
  includeReactions: z2.boolean().optional().describe("Include prototype reactions. Defaults to false."),
  maxDepth: z2.number().int().min(0).max(1e3).optional().describe("Maximum child depth. Omit to read the complete hierarchy."),
  assetOnly: z2.boolean().optional().describe("Return only export/image/vector-like asset nodes and ancestors.")
}).optional();
var readScopeSchema = z2.enum(["selection", "current_page", "all_pages"]);
var assetKindSchema = z2.enum(["screen", "image", "media", "vector", "slice", "configured", "asset"]);

// src/tools/read.ts
function registerReadTools(server2) {
  registerTool(
    server2,
    "get_document_info",
    "List every page and every visible top-level layer in the connected Figma document.",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_document_info");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting document info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_selection",
    "Get information about the current selection in Figma",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_selection");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_design_context",
    "Read implementation-ready design context: visible nodes at every requested hierarchy level, layout, text runs, colors, effects, components, variables, token summaries, screens, and exportable assets. Use scope=all_pages for the complete file.",
    {
      scope: readScopeSchema.optional().describe("Read the selection, current page, or every page. Defaults to current_page for speed."),
      pageIds: z3.array(z3.string()).optional().describe("Optional page IDs to read. Supplying this loads the document page index first."),
      options: nodeFilterOptionsSchema
    },
    async ({ scope, pageIds, options }) => {
      try {
        const result = await sendCommandToFigma("get_design_context", {
          scope: scope || "current_page",
          pageIds,
          options
        }, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error reading design context: ${error instanceof Error ? error.message : String(error)}`
          }]
        };
      }
    }
  );
  registerTool(
    server2,
    "list_design_assets",
    "Find every visible screen and recognizable export asset across the requested Figma scope. Recognition uses Figma isAsset, image fills, export settings, slices, vector/media types, and top-level screens.",
    {
      scope: readScopeSchema.optional().describe("Defaults to all_pages."),
      pageIds: z3.array(z3.string()).optional().describe("Optional page IDs to scan."),
      kinds: z3.array(assetKindSchema).optional().describe("Optional asset-kind filter.")
    },
    async ({ scope, pageIds, kinds }) => {
      try {
        const result = await sendCommandToFigma("list_design_assets", {
          scope: scope || "all_pages",
          pageIds,
          kinds
        }, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing design assets: ${error instanceof Error ? error.message : String(error)}`
          }]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_node_css",
    "Get Figma Inspect CSS for visible nodes. Useful as a web implementation aid; use get_design_context for platform-neutral data such as Compose.",
    {
      nodeIds: z3.array(z3.string()).min(1).max(100).describe("Visible node IDs to inspect.")
    },
    async ({ nodeIds }) => {
      try {
        const result = await sendCommandToFigma("get_node_css", { nodeIds }, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error getting node CSS: ${error instanceof Error ? error.message : String(error)}`
          }]
        };
      }
    }
  );
  registerTool(
    server2,
    "read_my_design",
    "Get detailed information about the current selection in Figma, including all node details",
    {
      options: nodeFilterOptionsSchema
    },
    async ({ options }) => {
      try {
        const result = await sendCommandToFigma("read_my_design", { options });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_node_info",
    "Get detailed information about a specific node in Figma",
    {
      nodeId: z3.string().describe("The ID of the node to get information about"),
      options: nodeFilterOptionsSchema
    },
    async ({ nodeId, options }) => {
      try {
        const result = await sendCommandToFigma("get_node_info", { nodeId, options });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting node info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_nodes_info",
    "Get detailed information about multiple nodes in Figma",
    {
      nodeIds: z3.array(z3.string()).describe("Array of node IDs to get information about"),
      options: nodeFilterOptionsSchema
    },
    async ({ nodeIds, options }) => {
      try {
        const results = await Promise.all(
          nodeIds.map(async (nodeId) => {
            const result = await sendCommandToFigma("get_node_info", { nodeId, options });
            return { nodeId, info: result };
          })
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results.map((result) => result.info))
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_styles",
    "Get all styles from the current Figma document",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_styles");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting styles: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_local_components",
    "Get all local components from the Figma document",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_local_components");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting local components: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_annotations",
    "Get all annotations in the current document or specific node",
    {
      nodeId: z3.string().describe("node ID to get annotations for specific node"),
      includeCategories: z3.boolean().optional().default(true).describe("Whether to include category information")
    },
    async ({ nodeId, includeCategories }) => {
      try {
        const result = await sendCommandToFigma("get_annotations", {
          nodeId,
          includeCategories
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_instance_overrides",
    "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
    {
      nodeId: z3.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used.")
    },
    async ({ nodeId }) => {
      try {
        const result = await sendCommandToFigma("get_instance_overrides", {
          instanceNodeId: nodeId || null
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "scan_text_nodes",
    "Scan all text nodes in the selected Figma node",
    {
      nodeId: z3.string().describe("ID of the node to scan")
    },
    async ({ nodeId }) => {
      try {
        const initialStatus = {
          type: "text",
          text: "Starting text node scanning. This may take a moment for large designs..."
        };
        const result = await sendCommandToFigma("scan_text_nodes", {
          nodeId,
          useChunking: true,
          // Enable chunking on the plugin side
          chunkSize: 10
          // Process 10 nodes at a time
        });
        if (result && typeof result === "object" && "chunks" in result) {
          const typedResult = result;
          const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;
          return {
            content: [
              initialStatus,
              {
                type: "text",
                text: summaryText
              },
              {
                type: "text",
                text: JSON.stringify(typedResult.textNodes, null, 2)
              }
            ]
          };
        }
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "scan_nodes_by_types",
    "Scan for child nodes with specific types in the selected Figma node",
    {
      nodeId: z3.string().describe("ID of the node to scan"),
      types: z3.array(z3.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
    },
    async ({ nodeId, types }) => {
      try {
        const initialStatus = {
          type: "text",
          text: `Starting node type scanning for types: ${types.join(", ")}...`
        };
        const result = await sendCommandToFigma("scan_nodes_by_types", {
          nodeId,
          types
        });
        if (result && typeof result === "object" && "matchingNodes" in result) {
          const typedResult = result;
          const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(", ")}`;
          return {
            content: [
              initialStatus,
              {
                type: "text",
                text: summaryText
              },
              {
                type: "text",
                text: JSON.stringify(typedResult.matchingNodes, null, 2)
              }
            ]
          };
        }
        return {
          content: [
            initialStatus,
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_reactions",
    "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
    {
      nodeIds: z3.array(z3.string()).describe("Array of node IDs to get reactions from")
    },
    async ({ nodeIds }) => {
      try {
        const result = await sendCommandToFigma("get_reactions", { nodeIds });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            },
            {
              type: "text",
              text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
            }
          ],
          followUp: {
            type: "prompt",
            prompt: "reaction_to_connector_strategy"
          }
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "get_local_variables",
    "Get all local Variable Collections and their variables with values. Useful for inspecting the current variable/theming setup.",
    {},
    async () => {
      try {
        const result = await sendCommandToFigma("get_local_variables");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

// src/tools/write.ts
import { z as z4 } from "zod";
function registerWriteTools(server2) {
  registerTool(
    server2,
    "create_rectangle",
    "Create a new rectangle in Figma",
    {
      x: z4.number().describe("X position"),
      y: z4.number().describe("Y position"),
      width: z4.number().describe("Width of the rectangle"),
      height: z4.number().describe("Height of the rectangle"),
      name: z4.string().optional().describe("Optional name for the rectangle"),
      parentId: z4.string().optional().describe("Optional parent node ID to append the rectangle to")
    },
    async ({ x, y, width, height, name, parentId }) => {
      try {
        const result = await sendCommandToFigma("create_rectangle", {
          x,
          y,
          width,
          height,
          name: name || "Rectangle",
          parentId
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "create_frame",
    "Create a new frame in Figma",
    {
      x: z4.number().describe("X position"),
      y: z4.number().describe("Y position"),
      width: z4.number().describe("Width of the frame"),
      height: z4.number().describe("Height of the frame"),
      name: z4.string().optional().describe("Optional name for the frame"),
      parentId: z4.string().optional().describe("Optional parent node ID to append the frame to"),
      fillColor: z4.object({
        r: z4.number().min(0).max(1).describe("Red component (0-1)"),
        g: z4.number().min(0).max(1).describe("Green component (0-1)"),
        b: z4.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z4.number().min(0).max(1).optional().describe("Alpha component (0-1)")
      }).optional().describe("Fill color in RGBA format"),
      strokeColor: z4.object({
        r: z4.number().min(0).max(1).describe("Red component (0-1)"),
        g: z4.number().min(0).max(1).describe("Green component (0-1)"),
        b: z4.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z4.number().min(0).max(1).optional().describe("Alpha component (0-1)")
      }).optional().describe("Stroke color in RGBA format"),
      strokeWeight: z4.number().positive().optional().describe("Stroke weight"),
      layoutMode: z4.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
      layoutWrap: z4.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
      paddingTop: z4.number().optional().describe("Top padding for auto-layout frame"),
      paddingRight: z4.number().optional().describe("Right padding for auto-layout frame"),
      paddingBottom: z4.number().optional().describe("Bottom padding for auto-layout frame"),
      paddingLeft: z4.number().optional().describe("Left padding for auto-layout frame"),
      primaryAxisAlignItems: z4.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
      counterAxisAlignItems: z4.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
      layoutSizingHorizontal: z4.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
      layoutSizingVertical: z4.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
      itemSpacing: z4.number().optional().describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
    },
    async ({
      x,
      y,
      width,
      height,
      name,
      parentId,
      fillColor,
      strokeColor,
      strokeWeight,
      layoutMode,
      layoutWrap,
      paddingTop,
      paddingRight,
      paddingBottom,
      paddingLeft,
      primaryAxisAlignItems,
      counterAxisAlignItems,
      layoutSizingHorizontal,
      layoutSizingVertical,
      itemSpacing
    }) => {
      try {
        const result = await sendCommandToFigma("create_frame", {
          x,
          y,
          width,
          height,
          name: name || "Frame",
          parentId,
          fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
          strokeColor,
          strokeWeight,
          layoutMode,
          layoutWrap,
          paddingTop,
          paddingRight,
          paddingBottom,
          paddingLeft,
          primaryAxisAlignItems,
          counterAxisAlignItems,
          layoutSizingHorizontal,
          layoutSizingVertical,
          itemSpacing
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating frame: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "create_text",
    "Create a new text element in Figma",
    {
      x: z4.number().describe("X position"),
      y: z4.number().describe("Y position"),
      text: z4.string().describe("Text content"),
      fontSize: z4.number().optional().describe("Font size (default: 14)"),
      fontWeight: z4.number().optional().describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
      fontColor: z4.object({
        r: z4.number().min(0).max(1).describe("Red component (0-1)"),
        g: z4.number().min(0).max(1).describe("Green component (0-1)"),
        b: z4.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z4.number().min(0).max(1).optional().describe("Alpha component (0-1)")
      }).optional().describe("Font color in RGBA format"),
      name: z4.string().optional().describe("Semantic layer name for the text node"),
      parentId: z4.string().optional().describe("Optional parent node ID to append the text to")
    },
    async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }) => {
      try {
        const result = await sendCommandToFigma("create_text", {
          x,
          y,
          text,
          fontSize: fontSize || 14,
          fontWeight: fontWeight || 400,
          fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
          name: name || "Text",
          parentId
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating text: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_fill_color",
    "Set the fill color of a node in Figma can be TextNode or FrameNode",
    {
      nodeId: z4.string().describe("The ID of the node to modify"),
      r: z4.number().min(0).max(1).describe("Red component (0-1)"),
      g: z4.number().min(0).max(1).describe("Green component (0-1)"),
      b: z4.number().min(0).max(1).describe("Blue component (0-1)"),
      a: z4.number().min(0).max(1).optional().describe("Alpha component (0-1)")
    },
    async ({ nodeId, r, g, b, a }) => {
      try {
        const result = await sendCommandToFigma("set_fill_color", {
          nodeId,
          color: { r, g, b, a: a || 1 }
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_stroke_color",
    "Set the stroke color of a node in Figma",
    {
      nodeId: z4.string().describe("The ID of the node to modify"),
      r: z4.number().min(0).max(1).describe("Red component (0-1)"),
      g: z4.number().min(0).max(1).describe("Green component (0-1)"),
      b: z4.number().min(0).max(1).describe("Blue component (0-1)"),
      a: z4.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
      weight: z4.number().positive().optional().describe("Stroke weight")
    },
    async ({ nodeId, r, g, b, a, weight }) => {
      try {
        const result = await sendCommandToFigma("set_stroke_color", {
          nodeId,
          color: { r, g, b, a: a || 1 },
          weight: weight || 1
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "move_node",
    "Move a node to a new position in Figma",
    {
      nodeId: z4.string().describe("The ID of the node to move"),
      x: z4.number().describe("New X position"),
      y: z4.number().describe("New Y position")
    },
    async ({ nodeId, x, y }) => {
      try {
        const result = await sendCommandToFigma("move_node", { nodeId, x, y });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error moving node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "clone_node",
    "Clone an existing node in Figma",
    {
      nodeId: z4.string().describe("The ID of the node to clone"),
      x: z4.number().optional().describe("New X position for the clone"),
      y: z4.number().optional().describe("New Y position for the clone")
    },
    async ({ nodeId, x, y }) => {
      try {
        const result = await sendCommandToFigma("clone_node", { nodeId, x, y });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "resize_node",
    "Resize a node in Figma",
    {
      nodeId: z4.string().describe("The ID of the node to resize"),
      width: z4.number().positive().describe("New width"),
      height: z4.number().positive().describe("New height")
    },
    async ({ nodeId, width, height }) => {
      try {
        const result = await sendCommandToFigma("resize_node", {
          nodeId,
          width,
          height
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error resizing node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "delete_node",
    "Delete a node from Figma",
    {
      nodeId: z4.string().describe("The ID of the node to delete")
    },
    async ({ nodeId }) => {
      try {
        await sendCommandToFigma("delete_node", { nodeId });
        return {
          content: [
            {
              type: "text",
              text: `Deleted node with ID: ${nodeId}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting node: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "delete_multiple_nodes",
    "Delete multiple nodes from Figma at once",
    {
      nodeIds: z4.array(z4.string()).describe("Array of node IDs to delete")
    },
    async ({ nodeIds }) => {
      try {
        const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_text_content",
    "Set the text content of an existing text node in Figma",
    {
      nodeId: z4.string().describe("The ID of the text node to modify"),
      text: z4.string().describe("New text content")
    },
    async ({ nodeId, text }) => {
      try {
        const result = await sendCommandToFigma("set_text_content", {
          nodeId,
          text
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting text content: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_annotation",
    "Create or update an annotation",
    {
      nodeId: z4.string().describe("The ID of the node to annotate"),
      annotationId: z4.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
      labelMarkdown: z4.string().describe("The annotation text in markdown format"),
      categoryId: z4.string().optional().describe("The ID of the annotation category"),
      properties: z4.array(z4.object({
        type: z4.string()
      })).optional().describe("Additional properties for the annotation")
    },
    async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }) => {
      try {
        const result = await sendCommandToFigma("set_annotation", {
          nodeId,
          annotationId,
          labelMarkdown,
          categoryId,
          properties
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_multiple_annotations",
    "Set multiple annotations parallelly in a node",
    {
      nodeId: z4.string().describe("The ID of the node containing the elements to annotate"),
      annotations: z4.array(
        z4.object({
          nodeId: z4.string().describe("The ID of the node to annotate"),
          labelMarkdown: z4.string().describe("The annotation text in markdown format"),
          categoryId: z4.string().optional().describe("The ID of the annotation category"),
          annotationId: z4.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z4.array(z4.object({
            type: z4.string()
          })).optional().describe("Additional properties for the annotation")
        })
      ).describe("Array of annotations to apply")
    },
    async ({ nodeId, annotations }) => {
      try {
        if (!annotations || annotations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No annotations provided"
              }
            ]
          };
        }
        const totalToProcess = annotations.length;
        const result = await sendCommandToFigma("set_multiple_annotations", {
          nodeId,
          annotations
        });
        const typedResult = result;
        const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;
        const detailedResults = typedResult.results || [];
        const failedResults = detailedResults.filter((item) => !item.success);
        let detailedResponse = "";
        if (failedResults.length > 0) {
          detailedResponse = `

Nodes that failed:
${failedResults.map(
            (item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`
          ).join("\n")}`;
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            {
              type: "text",
              text: progressText + detailedResponse
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "create_component_instance",
    "Create an instance of a component in Figma. Use componentId for fast local component instantiation, or componentKey for library imports.",
    {
      componentKey: z4.string().optional().describe("Key of the component to instantiate (uses importComponentByKeyAsync, slower)"),
      componentId: z4.string().optional().describe("Node ID of a local component to instantiate (fast, no import needed)"),
      x: z4.number().describe("X position"),
      y: z4.number().describe("Y position"),
      parentId: z4.string().optional().describe("Optional parent node ID to append the instance into (defaults to page root)")
    },
    async ({ componentKey, componentId, x, y, parentId }) => {
      try {
        const result = await sendCommandToFigma("create_component_instance", {
          componentKey,
          componentId,
          x,
          y,
          parentId
        }, 6e4);
        const typedResult = result;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(typedResult)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_instance_overrides",
    "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
    {
      sourceInstanceId: z4.string().describe("ID of the source component instance"),
      targetNodeIds: z4.array(z4.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
    },
    async ({ sourceInstanceId, targetNodeIds }) => {
      try {
        const result = await sendCommandToFigma("set_instance_overrides", {
          sourceInstanceId,
          targetNodeIds: targetNodeIds || []
        });
        const typedResult = result;
        if (typedResult.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result)
              }
            ]
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result)
              }
            ]
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_corner_radius",
    "Set the corner radius of a node in Figma",
    {
      nodeId: z4.string().describe("The ID of the node to modify"),
      radius: z4.number().min(0).describe("Corner radius value"),
      corners: z4.array(z4.boolean()).length(4).optional().describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      )
    },
    async ({ nodeId, radius, corners }) => {
      try {
        const result = await sendCommandToFigma("set_corner_radius", {
          nodeId,
          radius,
          corners: corners || [true, true, true, true]
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_multiple_text_contents",
    "Set multiple text contents parallelly in a node",
    {
      nodeId: z4.string().describe("The ID of the node containing the text nodes to replace"),
      text: z4.array(
        z4.object({
          nodeId: z4.string().describe("The ID of the text node"),
          text: z4.string().describe("The replacement text")
        })
      ).describe("Array of text node IDs and their replacement texts")
    },
    async ({ nodeId, text }) => {
      try {
        if (!text || text.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No text provided"
              }
            ]
          };
        }
        const totalToProcess = text.length;
        const result = await sendCommandToFigma("set_multiple_text_contents", {
          nodeId,
          text
        });
        const typedResult = result;
        const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;
        const detailedResults = typedResult.results || [];
        const failedResults = detailedResults.filter((item) => !item.success);
        let detailedResponse = "";
        if (failedResults.length > 0) {
          detailedResponse = `

Nodes that failed:
${failedResults.map(
            (item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`
          ).join("\n")}`;
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            {
              type: "text",
              text: progressText + detailedResponse
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_layout_mode",
    "Set the layout mode and wrap behavior of a frame in Figma",
    {
      nodeId: z4.string().describe("The ID of the frame to modify"),
      layoutMode: z4.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
      layoutWrap: z4.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
    },
    async ({ nodeId, layoutMode, layoutWrap }) => {
      try {
        const result = await sendCommandToFigma("set_layout_mode", {
          nodeId,
          layoutMode,
          layoutWrap: layoutWrap || "NO_WRAP"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_padding",
    "Set padding values for an auto-layout frame in Figma",
    {
      nodeId: z4.string().describe("The ID of the frame to modify"),
      paddingTop: z4.number().optional().describe("Top padding value"),
      paddingRight: z4.number().optional().describe("Right padding value"),
      paddingBottom: z4.number().optional().describe("Bottom padding value"),
      paddingLeft: z4.number().optional().describe("Left padding value")
    },
    async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }) => {
      try {
        const result = await sendCommandToFigma("set_padding", {
          nodeId,
          paddingTop,
          paddingRight,
          paddingBottom,
          paddingLeft
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_axis_align",
    "Set primary and counter axis alignment for an auto-layout frame in Figma",
    {
      nodeId: z4.string().describe("The ID of the frame to modify"),
      primaryAxisAlignItems: z4.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional().describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
      counterAxisAlignItems: z4.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
    },
    async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }) => {
      try {
        const result = await sendCommandToFigma("set_axis_align", {
          nodeId,
          primaryAxisAlignItems,
          counterAxisAlignItems
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_layout_sizing",
    "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
    {
      nodeId: z4.string().describe("The ID of the frame to modify"),
      layoutSizingHorizontal: z4.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
      layoutSizingVertical: z4.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
    },
    async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }) => {
      try {
        const result = await sendCommandToFigma("set_layout_sizing", {
          nodeId,
          layoutSizingHorizontal,
          layoutSizingVertical
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_item_spacing",
    "Set distance between children in an auto-layout frame",
    {
      nodeId: z4.string().describe("The ID of the frame to modify"),
      itemSpacing: z4.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
      counterAxisSpacing: z4.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
    },
    async ({ nodeId, itemSpacing, counterAxisSpacing }) => {
      try {
        const params = { nodeId };
        if (itemSpacing !== void 0) params.itemSpacing = itemSpacing;
        if (counterAxisSpacing !== void 0) params.counterAxisSpacing = counterAxisSpacing;
        const result = await sendCommandToFigma("set_item_spacing", params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_default_connector",
    "Set a copied connector node as the default connector",
    {
      connectorId: z4.string().optional().describe("The ID of the connector node to set as default")
    },
    async ({ connectorId }) => {
      try {
        const result = await sendCommandToFigma("set_default_connector", {
          connectorId
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "create_connections",
    "Create connections between nodes using the default connector style",
    {
      connections: z4.array(z4.object({
        startNodeId: z4.string().describe("ID of the starting node"),
        endNodeId: z4.string().describe("ID of the ending node"),
        text: z4.string().optional().describe("Optional text to display on the connector")
      })).describe("Array of node connections to create")
    },
    async ({ connections }) => {
      try {
        if (!connections || connections.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No connections provided"
              }
            ]
          };
        }
        const result = await sendCommandToFigma("create_connections", {
          connections
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_focus",
    "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
    {
      nodeId: z4.string().describe("The ID of the node to focus on")
    },
    async ({ nodeId }) => {
      try {
        const result = await sendCommandToFigma("set_focus", { nodeId });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "set_selections",
    "Set selection to multiple nodes in Figma and scroll viewport to show them",
    {
      nodeIds: z4.array(z4.string()).describe("Array of node IDs to select")
    },
    async ({ nodeIds }) => {
      try {
        const result = await sendCommandToFigma("set_selections", { nodeIds });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "create_component",
    "Create a new Component (not an instance) in Figma. This is the foundation for building a component library.",
    {
      x: z4.number().optional().describe("X position"),
      y: z4.number().optional().describe("Y position"),
      width: z4.number().optional().describe("Width"),
      height: z4.number().optional().describe("Height"),
      name: z4.string().describe("Component name (use / for grouping, e.g. 'Icon/Navigation/ArrowBack')"),
      parentId: z4.string().optional().describe("Parent node ID"),
      fillColor: z4.object({
        r: z4.number().min(0).max(1),
        g: z4.number().min(0).max(1),
        b: z4.number().min(0).max(1),
        a: z4.number().min(0).max(1).optional()
      }).optional().describe("Fill color in RGBA (0-1)"),
      layoutMode: z4.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode"),
      paddingTop: z4.number().optional(),
      paddingRight: z4.number().optional(),
      paddingBottom: z4.number().optional(),
      paddingLeft: z4.number().optional(),
      primaryAxisAlignItems: z4.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
      counterAxisAlignItems: z4.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
      layoutSizingHorizontal: z4.enum(["FIXED", "HUG", "FILL"]).optional(),
      layoutSizingVertical: z4.enum(["FIXED", "HUG", "FILL"]).optional(),
      itemSpacing: z4.number().optional(),
      description: z4.string().optional().describe("Component description")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_component", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_component_set",
    "Combine multiple Component variants into a ComponentSet. Each component must have variant-style naming like 'Property=Value'.",
    {
      componentIds: z4.array(z4.string()).describe("Array of Component IDs to combine as variants"),
      name: z4.string().optional().describe("Name for the ComponentSet")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_component_set", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "insert_svg",
    "Insert an SVG string into Figma. Use this to create icons from SVG markup. The SVG will be converted to Figma vector nodes.",
    {
      svgString: z4.string().describe("The SVG markup string to insert"),
      x: z4.number().optional().describe("X position"),
      y: z4.number().optional().describe("Y position"),
      name: z4.string().optional().describe("Name for the inserted node"),
      parentId: z4.string().optional().describe("Parent node ID to insert into"),
      size: z4.number().optional().describe("Target size to scale the SVG to (both width and height)")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("insert_svg", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_component_property",
    "Add a Component Property (Boolean, Text, Instance Swap, or Variant) to a Component or ComponentSet. For INSTANCE_SWAP: defaultValue must be the component KEY (not node ID), and targetChildId should be the child Instance node whose mainComponent will be linked.",
    {
      nodeId: z4.string().describe("Component or ComponentSet node ID"),
      propertyName: z4.string().describe("Property name (e.g. 'Show Icon', 'Label', 'icon')"),
      propertyType: z4.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]).describe("Property type"),
      defaultValue: z4.any().optional().describe("Default value. For INSTANCE_SWAP: use component KEY string (not node ID)"),
      targetChildId: z4.string().optional().describe("For INSTANCE_SWAP: the child Instance node ID to link. Sets componentPropertyReferences.mainComponent automatically")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_component_property", params);
        const r = result;
        let msg = `Set property on "${r.name}": ${r.properties.map((p) => `${p.key}(${p.type})`).join(", ")}`;
        if (r.fullPropertyName) msg += ` | fullName: ${r.fullPropertyName}`;
        if (r.linkedChildId) msg += ` | linked child: ${r.linkedChildId}`;
        return { content: [{ type: "text", text: msg }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_component_property_references",
    "Set componentPropertyReferences on a sublayer within a Component. Links a child node's property to an existing component property. Keys: 'visible'|'characters'|'mainComponent'.",
    {
      nodeId: z4.string().describe("The sublayer node ID (e.g. a child Instance or Text node)"),
      references: z4.record(z4.string()).describe("Object mapping property keys to component property names, e.g. { mainComponent: 'icon#10:0' }")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_component_property_references", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_variable_collection",
    "Create a new Variable Collection with modes. Use this to set up the theming system (Colors, Spacing, Radius, Typography, Font collections).",
    {
      name: z4.string().describe("Collection name (e.g. 'FigmaExporter Colors')"),
      modes: z4.array(z4.string()).optional().describe("Mode names (e.g. ['Default-Light', 'Default-Dark', 'CW-Light', 'MP-Dark'])")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_variable_collection", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_variable",
    "Create a new Variable in an existing Variable Collection.",
    {
      collectionId: z4.string().describe("Variable Collection ID"),
      name: z4.string().describe("Variable name (use / for grouping, e.g. 'color/primary')"),
      resolvedType: z4.enum(["BOOLEAN", "FLOAT", "STRING", "COLOR"]).describe("Variable type")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_variable", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_variable_value",
    "Set the value of a Variable for a specific mode. For COLOR type, pass hex string like '#FF0000'.",
    {
      variableId: z4.string().describe("Variable ID"),
      modeId: z4.string().describe("Mode ID to set the value for"),
      value: z4.any().describe("Value to set. For COLOR: hex string. For FLOAT: number. For STRING: string. For BOOLEAN: boolean.")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_variable_value", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_variable_mode_name",
    "Rename a mode in a Variable Collection.",
    {
      collectionId: z4.string().describe("Variable Collection ID"),
      modeId: z4.string().describe("Mode ID to rename"),
      name: z4.string().describe("New name for the mode")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_variable_mode_name", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "bind_variable",
    "Bind a Variable to a node property. This connects component properties to the theming system.",
    {
      nodeId: z4.string().describe("Node ID to bind the variable to"),
      field: z4.string().describe("Property field to bind. Examples: 'fills/0/color', 'cornerRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'fontSize', 'lineHeight', 'letterSpacing'"),
      variableId: z4.string().describe("Variable ID to bind")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("bind_variable", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_opacity",
    "Set the opacity of a node (0 to 1).",
    {
      nodeId: z4.string().describe("Node ID"),
      opacity: z4.number().min(0).max(1).describe("Opacity value (0-1)")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_opacity", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_visibility",
    "Show or hide a node.",
    {
      nodeId: z4.string().describe("Node ID"),
      visible: z4.boolean().describe("Whether the node should be visible")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_visibility", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_text_style",
    "Set text style properties: font family, size, weight, line height, letter spacing, alignment, decoration, case.",
    {
      nodeId: z4.string().describe("Text node ID"),
      fontFamily: z4.string().optional().describe("Font family name (e.g. 'Inter')"),
      fontStyle: z4.string().optional().describe("Font style (e.g. 'Regular', 'Bold', 'Medium')"),
      fontSize: z4.number().optional().describe("Font size in pixels"),
      fontWeight: z4.number().optional().describe("Font weight (100-900)"),
      lineHeight: z4.number().optional().describe("Line height in pixels"),
      letterSpacing: z4.number().optional().describe("Letter spacing in pixels"),
      textAlignHorizontal: z4.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
      textAlignVertical: z4.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
      textDecoration: z4.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
      textCase: z4.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional()
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_text_style", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_effects",
    "Set effects on a node: drop shadow, inner shadow, layer blur, background blur.",
    {
      nodeId: z4.string().describe("Node ID"),
      effects: z4.array(z4.object({
        type: z4.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
        visible: z4.boolean().optional(),
        color: z4.object({ r: z4.number(), g: z4.number(), b: z4.number(), a: z4.number().optional() }).optional(),
        offset: z4.object({ x: z4.number(), y: z4.number() }).optional(),
        radius: z4.number().optional(),
        spread: z4.number().optional()
      })).describe("Array of effects to apply")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_effects", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_ellipse",
    "Create an ellipse/circle in Figma. Useful for avatars, radio buttons, status indicators.",
    {
      x: z4.number().optional().describe("X position"),
      y: z4.number().optional().describe("Y position"),
      width: z4.number().optional().describe("Width (default 24)"),
      height: z4.number().optional().describe("Height (default 24)"),
      name: z4.string().optional().describe("Node name"),
      parentId: z4.string().optional().describe("Parent node ID"),
      fillColor: z4.object({
        r: z4.number().min(0).max(1),
        g: z4.number().min(0).max(1),
        b: z4.number().min(0).max(1),
        a: z4.number().min(0).max(1).optional()
      }).optional().describe("Fill color")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_ellipse", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_line",
    "Create a line in Figma. Useful for dividers.",
    {
      x: z4.number().optional(),
      y: z4.number().optional(),
      length: z4.number().optional().describe("Line length in pixels"),
      direction: z4.enum(["horizontal", "vertical"]).optional().describe("Line direction"),
      name: z4.string().optional(),
      parentId: z4.string().optional(),
      strokeColor: z4.object({
        r: z4.number().min(0).max(1),
        g: z4.number().min(0).max(1),
        b: z4.number().min(0).max(1),
        a: z4.number().min(0).max(1).optional()
      }).optional(),
      strokeWeight: z4.number().optional()
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_line", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "flatten_node",
    "Flatten a node (or group) into a single vector. Useful for cleaning up imported SVG icons.",
    {
      nodeId: z4.string().describe("Node ID to flatten")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("flatten_node", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_boolean_operation",
    "Create a boolean operation (union, subtract, intersect, exclude) from multiple nodes. Useful for complex icon shapes.",
    {
      nodeIds: z4.array(z4.string()).describe("Node IDs to combine"),
      operation: z4.enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]).optional().describe("Boolean operation type"),
      name: z4.string().optional().describe("Name for the result")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_boolean_operation", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "batch_create",
    "Execute multiple Figma commands in a single batch call. Dramatically improves performance for bulk operations like creating many icons or setting up variables.",
    {
      operations: z4.array(z4.object({
        command: z4.string().describe("Command name (any valid command like create_frame, create_text, set_fill_color, etc.)"),
        params: z4.any().describe("Parameters for the command")
      })).describe("Array of operations to execute sequentially")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("batch_create", params, 12e4);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "set_node_name",
    "Rename a node in Figma.",
    {
      nodeId: z4.string().describe("Node ID"),
      name: z4.string().describe("New name")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("set_node_name", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "group_nodes",
    "Group multiple nodes together.",
    {
      nodeIds: z4.array(z4.string()).describe("Node IDs to group"),
      name: z4.string().optional().describe("Group name")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("group_nodes", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "convert_to_component",
    "Convert an existing Frame or Group into a Component. Preserves all children and properties.",
    {
      nodeId: z4.string().describe("Frame or Group node ID to convert")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("convert_to_component", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
  registerTool(
    server2,
    "create_icon_component",
    "Create an icon component from SVG content. Inserts SVG, flattens vectors, resizes to standard size, sets fill color, and converts to a Component. Returns component ID and key.",
    {
      svgContent: z4.string().describe("SVG markup string"),
      name: z4.string().optional().describe("Component name, e.g. Icon/Navigation/ArrowBack"),
      x: z4.number().optional().describe("X position"),
      y: z4.number().optional().describe("Y position"),
      parentId: z4.string().optional().describe("Parent frame ID"),
      size: z4.number().optional().describe("Icon size in px (default 24)"),
      fillColor: z4.string().optional().describe("Fill color hex, e.g. #1C1C1C")
    },
    async (params) => {
      try {
        const result = await sendCommandToFigma("create_icon_component", params);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

// src/tools/export.ts
import { z as z5 } from "zod";
import path2 from "node:path";

// src/exports.ts
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
function sanitizeFileSegment(value, fallback = "unnamed") {
  const sanitized = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 100);
  return sanitized || fallback;
}
function resolveExportDirectory(customDirectory) {
  return path.resolve(customDirectory || process.env.FIGMA_EXPORTER_EXPORT_DIR || path.join(process.cwd(), "exports"));
}
function saveBase64Export(imageData, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const buffer = Buffer.from(imageData, "base64");
  fs.writeFileSync(targetPath, buffer);
  return buffer.length;
}
function choosePngExportScale(asset, platform) {
  if (platform === "android") return 4;
  const width = Number.isFinite(Number(asset.width)) ? Math.max(0, Number(asset.width)) : 0;
  const height = Number.isFinite(Number(asset.height)) ? Math.max(0, Number(asset.height)) : 0;
  const maxDimension = Math.max(width, height);
  if (maxDimension <= 0) return 2;
  const desiredScale = maxDimension <= 128 ? 4 : maxDimension <= 768 ? 3 : 2;
  const dimensionCap = 4096 / maxDimension;
  const areaCap = width > 0 && height > 0 ? Math.sqrt(16e6 / (width * height)) : desiredScale;
  const cappedScale = Math.min(desiredScale, dimensionCap, areaCap);
  return cappedScale >= 0.25 ? Math.floor(cappedScale * 4) / 4 : cappedScale;
}
function exportFileSegment(file) {
  const identity = file.fileKey || file.channel;
  if (!identity) throw new Error("Cannot export without an identified connected file.");
  return `${sanitizeFileSegment(file.fileName || "figma")}__${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

// src/tools/export.ts
function registerExportTools(server2) {
  registerTool(
    server2,
    "export_node_as_image",
    "Export a node as an image from Figma",
    {
      nodeId: z5.string().describe("The ID of the node to export"),
      format: z5.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format"),
      scale: z5.number().positive().optional().describe("Export scale")
    },
    async ({ nodeId, format, scale }) => {
      try {
        const activeFile = await getOperationFile();
        if (!activeFile) throw new Error("Select a connected Figma file before exporting.");
        const result = await sendCommandToFigma("export_node_as_image", {
          nodeId,
          format: format || "PNG",
          scale: scale || 1
        });
        const typedResult = result;
        if (!typedResult?.imageData) throw new Error("Figma returned no export data");
        const exportDir = path2.join(resolveExportDirectory(), exportFileSegment(activeFile));
        let savedPath = null;
        if (typedResult.imageData) {
          try {
            const ext = (format || "PNG").toLowerCase();
            const safeId = nodeId.replace(/[^A-Za-z0-9_-]/g, "_");
            savedPath = path2.join(exportDir, `node_${safeId}.${ext}`);
            const byteLength = saveBase64Export(typedResult.imageData, savedPath);
            logger.info(`Exported node ${nodeId} to ${savedPath} (${byteLength} bytes)`);
          } catch (e) {
            logger.warn(`Failed to save export to disk: ${e instanceof Error ? e.message : String(e)}`);
            savedPath = null;
          }
        }
        const content = [
          format === "SVG" || format === "PDF" ? {
            type: "resource",
            resource: {
              uri: `figma-export://${encodeURIComponent(activeFile.channel)}/${encodeURIComponent(nodeId)}.${format.toLowerCase()}`,
              mimeType: typedResult.mimeType || (format === "SVG" ? "image/svg+xml" : "application/pdf"),
              blob: typedResult.imageData
            }
          } : {
            type: "image",
            data: typedResult.imageData,
            mimeType: typedResult.mimeType || "image/png"
          }
        ];
        if (savedPath) {
          content.push({ type: "text", text: `Saved to: ${savedPath}` });
        }
        return { content };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
  registerTool(
    server2,
    "export_design_assets",
    "Export every visible recognized asset or screen as PNG. Android always exports at 4x; web chooses a clear scale from the source dimensions while capping oversized output.",
    {
      scope: readScopeSchema.optional().describe("Defaults to all_pages."),
      pageIds: z5.array(z5.string()).optional().describe("Optional page IDs to export from."),
      nodeIds: z5.array(z5.string()).optional().describe("Optional subset of recognized asset node IDs."),
      kinds: z5.array(assetKindSchema).optional().describe("Optional asset-kind filter."),
      platform: z5.enum(["android", "web"]).optional().describe("Android exports PNG at 4x. Web selects an adaptive PNG scale. Defaults to web."),
      outputDirectory: z5.string().optional().describe("Local output directory. Defaults to FIGMA_EXPORTER_EXPORT_DIR or ./exports."),
      concurrency: z5.number().int().min(1).max(6).optional().describe("Parallel Figma exports. Defaults to 3.")
    },
    async ({ scope, pageIds, nodeIds, kinds, platform, outputDirectory, concurrency }) => {
      try {
        const activeFile = await getOperationFile();
        if (!activeFile) throw new Error("Select a connected Figma file before exporting.");
        const exportPlatform = platform || "web";
        const listed = await sendCommandToFigma("list_design_assets", {
          scope: scope || "all_pages",
          pageIds,
          kinds
        }, 12e4);
        const requestedIds = Array.isArray(nodeIds) ? new Set(nodeIds) : null;
        const deduplicated = /* @__PURE__ */ new Map();
        for (const asset of listed.assets || []) {
          if ((!requestedIds || requestedIds.has(asset.id)) && !deduplicated.has(asset.id)) {
            deduplicated.set(asset.id, asset);
          }
        }
        const assets = [...deduplicated.values()];
        const rootDirectory = resolveExportDirectory(outputDirectory);
        const fileDirectory = path2.join(
          rootDirectory,
          exportFileSegment(activeFile),
          exportPlatform
        );
        const exported = [];
        const failed = [];
        let nextIndex = 0;
        const worker = async () => {
          while (nextIndex < assets.length) {
            const asset = assets[nextIndex++];
            const exportScale = choosePngExportScale(asset, exportPlatform);
            try {
              const result = await sendCommandToFigma("export_node_as_image", {
                nodeId: asset.id,
                format: "PNG",
                scale: exportScale
              }, 12e4);
              if (!result.imageData) throw new Error("Figma returned no image data");
              const safeId = String(asset.id).replace(/[^A-Za-z0-9_-]/g, "_");
              const pageDirectory = path2.join(fileDirectory, sanitizeFileSegment(asset.pageName || "page"));
              const targetPath = path2.join(
                pageDirectory,
                `${sanitizeFileSegment(asset.name || asset.type)}__${safeId}.png`
              );
              const byteLength = saveBase64Export(result.imageData, targetPath);
              exported.push({
                nodeId: asset.id,
                name: asset.name,
                kind: asset.kind,
                format: "PNG",
                platform: exportPlatform,
                scale: exportScale,
                sourceWidth: asset.width,
                sourceHeight: asset.height,
                outputWidth: typeof asset.width === "number" ? Math.round(asset.width * exportScale) : void 0,
                outputHeight: typeof asset.height === "number" ? Math.round(asset.height * exportScale) : void 0,
                byteLength,
                path: targetPath
              });
            } catch (error) {
              failed.push({
                nodeId: asset.id,
                name: asset.name,
                kind: asset.kind,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(concurrency || 3, Math.max(assets.length, 1)) },
          () => worker()
        ));
        const missingNodeIds = requestedIds ? [...requestedIds].filter((nodeId) => !deduplicated.has(nodeId)) : [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              outputDirectory: fileDirectory,
              platform: exportPlatform,
              format: "PNG",
              recognizedCount: assets.length,
              exportedCount: exported.length,
              failedCount: failed.length,
              missingNodeIds,
              exported,
              failed
            })
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error exporting design assets: ${error instanceof Error ? error.message : String(error)}`
          }]
        };
      }
    }
  );
}

// src/tools/prompts.ts
function registerPromptsTools(server2) {
  server2.prompt(
    "design_strategy",
    "Best practices for working with Figma designs",
    (_extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`
            }
          }
        ],
        description: "Best practices for working with Figma designs"
      };
    }
  );
  server2.prompt(
    "read_design_strategy",
    "Best practices for reading Figma designs",
    (_extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_my_design() to understand the current selection
   - If no selection ask user to select single or multiple nodes
`
            }
          }
        ],
        description: "Best practices for reading Figma designs"
      };
    }
  );
  server2.prompt(
    "text_replacement_strategy",
    "Systematic approach for replacing text in Figma designs",
    (_extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id",
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text\u2014it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`
            }
          }
        ],
        description: "Systematic approach for replacing text in Figma designs"
      };
    }
  );
  server2.prompt(
    "annotation_conversion_strategy",
    "Strategy for converting manual annotations to Figma's native annotations",
    (_extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Automatic Annotation Conversion

## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")

// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path

\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target =
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);

  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);

    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`

This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
            }
          }
        ],
        description: "Strategy for converting manual annotations to Figma's native annotations"
      };
    }
  );
  server2.prompt(
    "swap_overrides_instances",
    "Guide to swap instance overrides between instances",
    (_extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id",
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Figma files auto-connect when their plugin starts. Use \`get_connected_files()\` to verify, \`set_active_file()\` to switch target
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`
            }
          }
        ],
        description: "Strategy for transferring overrides between component instances in Figma"
      };
    }
  );
  server2.prompt(
    "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    (_extra) => {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_my_design\` on the relevant node(s) to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_my_design\` or by calling \`get_node_info\` if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON_DRAG" and \`actionType\` is "OPEN_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
            }
          }
        ],
        description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'"
      };
    }
  );
}

// src/server.ts
var server = new McpServer({ name: "FigmaExporterMCP", version: "2.1.0" });
registerReadTools(server);
registerWriteTools(server);
registerExportTools(server);
registerPromptsTools(server);
registerFileTools(server);
async function main() {
  await startRelay(RELAY_PORT);
  logger.info(relayActive ? "Relay mode: this instance owns the relay" : "Proxy mode: forwarding commands to existing relay");
  if (process.argv.includes("--relay-only")) return;
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaExporter MCP server running on stdio");
}
main().catch((error) => {
  logger.error(`Error starting FigmaExporter MCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
//# sourceMappingURL=server.js.map
