import { registerTool } from "./register.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sendCommandToFigma } from "../relay.js";

import { nodeFilterOptionsSchema, readScopeSchema, assetKindSchema } from "../design.js";

export function registerReadTools(server: McpServer) {
registerTool(server,
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
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
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
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "get_design_context",
  "Read implementation-ready design context: visible nodes at every requested hierarchy level, layout, text runs, colors, effects, components, variables, token summaries, screens, and exportable assets. Use scope=all_pages for the complete file.",
  {
    scope: readScopeSchema.optional().describe("Read the selection, current page, or every page. Defaults to current_page for speed."),
    pageIds: z.array(z.string()).optional().describe("Optional page IDs to read. Supplying this loads the document page index first."),
    options: nodeFilterOptionsSchema,
  },
  async ({ scope, pageIds, options }: any) => {
    try {
      const result = await sendCommandToFigma("get_design_context", {
        scope: scope || "current_page",
        pageIds,
        options,
      }, 120000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error reading design context: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }
);

registerTool(server,
  "list_design_assets",
  "Find every visible screen and recognizable export asset across the requested Figma scope. Recognition uses Figma isAsset, image fills, export settings, slices, vector/media types, and top-level screens.",
  {
    scope: readScopeSchema.optional().describe("Defaults to all_pages."),
    pageIds: z.array(z.string()).optional().describe("Optional page IDs to scan."),
    kinds: z.array(assetKindSchema).optional().describe("Optional asset-kind filter."),
  },
  async ({ scope, pageIds, kinds }: any) => {
    try {
      const result = await sendCommandToFigma("list_design_assets", {
        scope: scope || "all_pages",
        pageIds,
        kinds,
      }, 120000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing design assets: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }
);

registerTool(server,
  "get_node_css",
  "Get Figma Inspect CSS for visible nodes. Useful as a web implementation aid; use get_design_context for platform-neutral data such as Compose.",
  {
    nodeIds: z.array(z.string()).min(1).max(100).describe("Visible node IDs to inspect."),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_css", { nodeIds }, 120000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error getting node CSS: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }
);

registerTool(server,
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {
    options: nodeFilterOptionsSchema,
  },
  async ({ options }: any) => {
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
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "get_node_info",
  "Get detailed information about a specific node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
    options: nodeFilterOptionsSchema,
  },
  async ({ nodeId, options }: any) => {
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
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get information about"),
    options: nodeFilterOptionsSchema,
  },
  async ({ nodeIds, options }: any) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId: any) => {
          const result = await sendCommandToFigma('get_node_info', { nodeId, options });
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
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
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
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
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
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }: any) => {
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

registerTool(server,
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
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

registerTool(server,
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
  },
  async ({ nodeId }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: "Starting text node scanning. This may take a moment for large designs...",
      };

      // Use the plugin's scan_text_nodes function with chunking flag
      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,  // Enable chunking on the plugin side
        chunkSize: 10       // Process 10 nodes at a time
      });

      // If the result indicates chunking was used, format the response accordingly
      if (result && typeof result === 'object' && 'chunks' in result) {
        const typedResult = result as {
          success: boolean,
          totalNodes: number,
          processedNodes: number,
          chunks: number,
          textNodes: Array<any>
        };

        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.textNodes, null, 2)
            }
          ],
        };
      }

      // If chunking wasn't used or wasn't reported in the result format, return the result as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "scan_nodes_by_types",
  "Scan for child nodes with specific types in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z.array(z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
  },
  async ({ nodeId, types }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(', ')}...`,
      };

      // Use the plugin's scan_nodes_by_types function
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types
      });

      // Format the response
      if (result && typeof result === 'object' && 'matchingNodes' in result) {
        const typedResult = result as {
          success: boolean,
          count: number,
          matchingNodes: Array<{
            id: string,
            name: string,
            type: string,
            bbox: {
              x: number,
              y: number,
              width: number,
              height: number
            }
          }>,
          searchedTypes: Array<string>
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(', ')}`;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.matchingNodes, null, 2)
            }
          ],
        };
      }

      // If the result is in an unexpected format, return it as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
  },
  async ({ nodeIds }: any) => {
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
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
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
