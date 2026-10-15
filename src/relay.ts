import WebSocket, { WebSocketServer } from "ws";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger.js";
import type { FigmaCommand, CommandProgressUpdate } from "./protocol.js";
export const RELAY_SERVICE = "figma-exporter-mcp";
export const RELAY_PROTOCOL_VERSION = 1;
const BUILD_ID: string = JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")).sourceHash;
interface FigmaFile {
  ws: WebSocket;
  channel: string;
  fileName: string;
  fileKey: string;
  connectedAt: number;
}
export const connectedFiles = new Map<string, FigmaFile>();
const activeFileBySession = new Map<string, string | null>();
export interface FileIdentity { channel: string; fileName: string; fileKey: string; }
const operationFile = new AsyncLocalStorage<FileIdentity>();

export async function getOperationFile(): Promise<FileIdentity> {
  const pinned = operationFile.getStore();
  if (pinned) return pinned;
  const file = relayActive ? getActiveFile() : (await proxyGetConnectedFiles()).find(item => item.active);
  if (!file) throw new Error("No unique Figma file selected. Connect the plugin, then set_active_file with an exact channel when multiple files are connected.");
  return { channel: file.channel, fileName: file.fileName, fileKey: file.fileKey };
}

export async function withFileTarget<T>(work: () => Promise<T>): Promise<T> {
  return operationFile.run(await getOperationFile(), work);
}

// Pending request tracking
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number;
  socket: WebSocket;
}>();

// Config
export const RELAY_PORT = parseInt(process.env.FIGMA_EXPORTER_RELAY_PORT || "3066", 10);
const DEFAULT_SESSION_ID = "default";
export const MCP_SESSION_ID = process.env.FIGMA_EXPORTER_SESSION_ID || `mcp-${uuidv4()}`;
export let relayActive = false;  // true when this instance owns the relay

function normalizeSessionId(sessionId?: string | null): string {
  const normalized = (sessionId || "").trim();
  return normalized || DEFAULT_SESSION_ID;
}

function getFallbackFile(): FigmaFile | null {
  return connectedFiles.size === 1 ? connectedFiles.values().next().value! : null;
}

export function getActiveChannelForSession(sessionId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const sessionChannel = activeFileBySession.get(normalizedSessionId);
  if (activeFileBySession.has(normalizedSessionId)) return sessionChannel && connectedFiles.has(sessionChannel) ? sessionChannel : null;
  return getFallbackFile()?.channel || null;
}

export function getActiveFile(sessionId: string = MCP_SESSION_ID): FigmaFile | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const activeChannel = getActiveChannelForSession(normalizedSessionId);
  if (activeChannel && connectedFiles.has(activeChannel)) {
    activeFileBySession.set(normalizedSessionId, activeChannel);
    return connectedFiles.get(activeChannel)!;
  }
  return null;
}

export function setActiveFileForSession(
  keyword: string,
  sessionId: string = MCP_SESSION_ID
): { matched: boolean; activeFileChannel: string | null; file?: FigmaFile } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const kw = (keyword || "").trim().toLowerCase();
  if (!kw) {
    activeFileBySession.set(normalizedSessionId, null);
    return { matched: false, activeFileChannel: null };
  }
  let matchedChannel: string | null = null;

  if (connectedFiles.has(keyword)) {
    matchedChannel = keyword;
  } else {
    const entries = [...connectedFiles.entries()];
    const exact = entries.filter(([channel, file]) =>
      channel.toLowerCase() === kw || file.fileName.toLowerCase() === kw || (file.fileKey && file.fileKey.toLowerCase() === kw));
    const matches = exact.length ? exact : entries.filter(([channel, file]) =>
      file.fileName.toLowerCase().includes(kw) || channel.toLowerCase().includes(kw));
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
    file: connectedFiles.get(matchedChannel),
  };
}

export function startRelay(port: number = RELAY_PORT): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: RELAY_SERVICE, protocolVersion: RELAY_PROTOCOL_VERSION, version: "2.1.0", buildId: BUILD_ID, pid: process.pid }));
      return;
    }

    // HTTP is process-to-process only. A web page must not issue design mutations.
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

    // GET /channels — list active files (backward compat for external tools)
    if (requestUrl.pathname === "/channels" && req.method === "GET") {
      const sessionId = normalizeSessionId(requestUrl.searchParams.get("sessionId"));
      const sessionActiveChannel = getActiveChannelForSession(sessionId);
      const result: any[] = [];
      for (const [channel, file] of connectedFiles.entries()) {
        result.push({
          channel,
          fileName: file.fileName,
          fileKey: file.fileKey,
          clients: 1,
          joinedAt: file.connectedAt,
          active: channel === sessionActiveChannel,
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/command — proxy a Figma command from another MCP instance
    if (requestUrl.pathname === "/api/command" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { command, params, timeoutMs, sessionId, targetChannel } = JSON.parse(body);
          const result = await sendCommandToFigma(
            command as FigmaCommand,
            params,
            timeoutMs || 30000,
            normalizeSessionId(sessionId),
            targetChannel
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }

    // POST /api/set_active_file — switch active file from another instance
    if (requestUrl.pathname === "/api/set_active_file" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { keyword, sessionId } = JSON.parse(body);
          const result = setActiveFileForSession(keyword, normalizeSessionId(sessionId));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            matched: result.matched,
            activeFileChannel: result.activeFileChannel,
            fileName: result.file?.fileName,
          }));
        } catch (err: any) {
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

  // Handle errors forwarded from httpServer (ws library re-emits them on WSS)
  wss.on("error", (err: Error) => {
    logger.warn(`WebSocketServer error (handled): ${err.message}`);
  });

  wss.on("connection", (pluginWs: WebSocket) => {
    logger.info("New Figma plugin connected");

    // Send welcome message
    pluginWs.send(JSON.stringify({
      type: "system",
      message: "Please join a channel to start chatting",
    }));

    let pluginChannel: string | null = null;

    pluginWs.on("message", (raw: Buffer | string) => {
      try {
        const data = JSON.parse(raw.toString());

        // Handle plugin joining a channel (i.e., a Figma file connecting)
        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName) return;

          pluginChannel = channelName;

          // Register this Figma file
          connectedFiles.set(channelName, {
            ws: pluginWs,
            channel: channelName,
            fileName: data.fileName || channelName,
            fileKey: data.fileKey || "",
            connectedAt: Date.now(),
          });

          logger.info(`Figma file registered: ${data.fileName || channelName} (${channelName})`);

          // Send join confirmation to plugin (same format as old relay)
          pluginWs.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName,
          }));
          pluginWs.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName,
          }));
          return;
        }

        // Handle response messages from plugin (command results)
        if ((data.type === "message" || data.type === "progress_update") && data.message) {
          const msg = data.message;

          // Handle progress updates
          if (msg.type === "progress_update") {
            const progressData = msg.data as CommandProgressUpdate;
            const requestId = data.id || msg.id || "";

            if (requestId && pendingRequests.get(requestId)?.socket === pluginWs) {
              const request = pendingRequests.get(requestId)!;
              request.lastActivity = Date.now();
              // Progress does not extend the absolute command deadline used by HTTP/MCP.
              logger.info(`Progress: ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
            }
            return;
          }

          // Handle command result
          if (msg.id && pendingRequests.get(msg.id)?.socket === pluginWs) {
            const request = pendingRequests.get(msg.id)!;
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

    pluginWs.on("error", (err: Error) => {
      logger.error(`Plugin WebSocket error: ${err.message}`);
    });
  });

  return new Promise<void>((resolve, reject) => {
    httpServer.listen(port, "127.0.0.1", () => {
      relayActive = true;
      logger.info(`FigmaExporter relay listening on port ${port}`);
      resolve();
    });

    httpServer.on("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        relayActive = false;
        try {
          const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          const info = await health.json() as { service?: string; protocolVersion?: number; buildId?: string };
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
      resolve(); // always resolve so MCP server still starts
    });
  });
}

// Function to send commands to Figma (supports relay mode and proxy mode)
export function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000,
  sessionId: string = MCP_SESSION_ID,
  targetChannel: string | undefined = operationFile.getStore()?.channel
): Promise<unknown> {
  // Proxy mode: forward via HTTP to the instance that owns the relay
  if (!relayActive) {
    return proxyCommandViaHttp(command, params, timeoutMs, sessionId, targetChannel);
  }

  // Relay mode: send directly via WebSocket
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

    // Send command directly to the Figma plugin (wrapped as broadcast, same format plugin expects)
    const request = {
      type: "broadcast",
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id,
        },
      },
      sender: "server",
      channel: file.channel,
    };

    // Set timeout
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} timed out after ${timeoutMs / 1000}s`);
        reject(new Error("Request to Figma timed out"));
      }
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now(),
      socket: file.ws,
    });

    logger.info(`→ ${command} → ${file.fileName}`);
    file.ws.send(JSON.stringify(request), error => {
      if (!error || !pendingRequests.has(id)) return;
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(error);
    });
  });
}

// Proxy a command through HTTP to the relay-owning instance
async function proxyCommandViaHttp(
  command: FigmaCommand,
  params: unknown,
  timeoutMs: number,
  sessionId: string,
  targetChannel?: string
): Promise<unknown> {
  const url = `http://127.0.0.1:${RELAY_PORT}/api/command`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, params, timeoutMs, sessionId: normalizeSessionId(sessionId), targetChannel }),
      signal: controller.signal,
    });
    const data = await res.json() as { result?: unknown; error?: string };
    if (!res.ok || data.error) {
      throw new Error(data.error || `Relay returned HTTP ${res.status}`);
    }
    return data.result;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("Proxy request to relay timed out");
    }
    throw new Error(`Proxy to relay failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Fetch connected files from the relay-owning instance
export async function proxyGetConnectedFiles(sessionId: string = MCP_SESSION_ID): Promise<Array<{ channel: string; fileName: string; fileKey: string; clients: number; joinedAt: number; active?: boolean }>> {
  const url = `http://127.0.0.1:${RELAY_PORT}/channels?sessionId=${encodeURIComponent(normalizeSessionId(sessionId))}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("application/json")) {
      logger.warn(`Unexpected /channels response: HTTP ${res.status} ${contentType || "unknown content-type"}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data as any[] : [];
  } catch (err: any) {
    logger.warn(`Failed to fetch connected files from relay: ${err.message || String(err)}`);
    return [];
  }
}
