import { registerTool } from "./register.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { relayActive, proxyGetConnectedFiles, MCP_SESSION_ID, RELAY_PORT, connectedFiles, getActiveChannelForSession, setActiveFileForSession } from "../relay.js";
export function registerFileTools(server: McpServer) {
registerTool(server,
  "get_connected_files",
  "List all Figma design files currently connected via the FigmaExporter plugin. Shows which file is active (receives commands).",
  {},
  async () => {
    // Proxy mode: fetch from relay owner
    if (!relayActive) {
      const remoteFiles = await proxyGetConnectedFiles(MCP_SESSION_ID);
      if (remoteFiles.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No Figma files connected. Open a Figma file and start the FigmaExporter plugin.\n(Running in proxy mode — forwarding to relay on port " + RELAY_PORT + ")",
          }],
        };
      }
      const files = remoteFiles.map((f, i) =>
        `${i + 1}. ${f.active ? "→ " : "  "}**${f.fileName}** (channel: ${f.channel}, key: ${f.fileKey || "N/A"})`
      );
      return {
        content: [{
          type: "text",
          text: `Connected Figma files via relay (${remoteFiles.length}):\n${files.join("\n")}\n\n→ = active file for this Codex session (${MCP_SESSION_ID})\n(proxy mode)`,
        }],
      };
    }

    if (connectedFiles.size === 0) {
      return {
        content: [{
          type: "text",
          text: "No Figma files connected. Open a Figma file and start the FigmaExporter plugin.",
        }],
      };
    }

    const files = Array.from(connectedFiles.values()).map((f, i) => {
      const isActive = f.channel === getActiveChannelForSession(MCP_SESSION_ID);
      return `${i + 1}. ${isActive ? "→ " : "  "}**${f.fileName}** (channel: ${f.channel}, key: ${f.fileKey || "N/A"})`;
    });

    return {
      content: [{
        type: "text",
        text: `Connected Figma files (${connectedFiles.size}):\n${files.join("\n")}\n\n→ = active file for this Codex session (${MCP_SESSION_ID})`,
      }],
    };
  }, false
);

registerTool(server,
  "set_active_file",
  "Switch which Figma file receives commands. Pass a file name or channel keyword to match.",
  {
    keyword: z.string().describe("File name or channel name keyword to match"),
  },
  async ({ keyword }: any) => {
    // Proxy mode: delegate to relay owner
    if (!relayActive) {
      try {
        const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/set_active_file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword, sessionId: MCP_SESSION_ID }),
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json() as { matched?: boolean; activeFileChannel?: string; fileName?: string; error?: string };
        if (!res.ok || data.error) throw new Error(data.error || `Relay returned HTTP ${res.status}`);
        if (data.matched) {
          return {
            content: [{
              type: "text",
              text: `Active file for this Codex session set to: ${data.fileName || data.activeFileChannel} (${data.activeFileChannel}) via proxy`,
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: `No file matching "${keyword}". Use get_connected_files to see available files.`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: `Proxy error: ${err.message}`,
          }],
        };
      }
    }

    const result = setActiveFileForSession(keyword, MCP_SESSION_ID);
    if (result.matched && result.file) {
      return {
        content: [{
          type: "text",
          text: `Active file for this Codex session set to: ${result.file.fileName} (channel: ${result.file.channel})`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `No file matching "${keyword}". Use get_connected_files to see available files.`,
      }],
    };
  }, false
);


}
