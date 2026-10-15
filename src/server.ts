#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./logger.js";
import { startRelay, RELAY_PORT, relayActive } from "./relay.js";
import { registerFileTools } from "./tools/files.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerExportTools } from "./tools/export.js";
import { registerPromptsTools } from "./tools/prompts.js";

const server = new McpServer({ name: "FigmaExporterMCP", version: "2.1.0" });

registerReadTools(server);
registerWriteTools(server);
registerExportTools(server);
registerPromptsTools(server);
registerFileTools(server);

async function main() {
  // Start the embedded relay (WebSocket + HTTP server)
  await startRelay(RELAY_PORT);
  logger.info(relayActive ? "Relay mode: this instance owns the relay" : "Proxy mode: forwarding commands to existing relay");

  if (process.argv.includes("--relay-only")) return;

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaExporter MCP server running on stdio");
}

main().catch(error => {
  logger.error(`Error starting FigmaExporter MCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
