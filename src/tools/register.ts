import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { withFileTarget } from "../relay.js";

function failedValue(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(failedValue);
  const data = value as Record<string, unknown>;
  if (data.success === false) return true;
  for (const key of ["failed", "failedCount", "nodesFailed", "annotationsFailed", "replacementsFailed"]) {
    if (typeof data[key] === "number" && data[key] > 0) return true;
  }
  if (Array.isArray(data.missingNodeIds) && data.missingNodeIds.length > 0) return true;
  return Array.isArray(data.results) && data.results.some(failedValue);
}

/** Preserve partial receipts while exposing failures through the MCP protocol. */
export function normalizeToolResult(result: CallToolResult): CallToolResult {
  const failed = result.isError || result.content.some(item => {
    if (item.type !== "text") return false;
    try { return failedValue(JSON.parse(item.text)); }
    catch { return /^(Error\b|Failed\b|Proxy error:|No (?:file matching|Figma files connected\.))/.test(item.text); }
  });
  return failed ? { ...result, isError: true } : result;
}

export function registerTool(
  server: McpServer,
  name: string,
  description: string,
  schema: ZodRawShape,
  callback: (args: any) => Promise<CallToolResult>,
  pinFile = true,
) {
  return server.tool(name, description, schema, async args => {
    try {
      return normalizeToolResult(await (pinFile
        ? withFileTarget(() => callback(args)) : callback(args)));
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}
