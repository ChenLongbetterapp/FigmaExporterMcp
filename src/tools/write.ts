import { registerTool } from "./register.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sendCommandToFigma } from "../relay.js";

import type { setInstanceOverridesResult } from "../protocol.js";

export function registerWriteTools(server: McpServer) {
registerTool(server,
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
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
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
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
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y });
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

registerTool(server,
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
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
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
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

registerTool(server,
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "create_component_instance",
  "Create an instance of a component in Figma. Use componentId for fast local component instantiation, or componentKey for library imports.",
  {
    componentKey: z.string().optional().describe("Key of the component to instantiate (uses importComponentByKeyAsync, slower)"),
    componentId: z.string().optional().describe("Node ID of a local component to instantiate (fast, no import needed)"),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    parentId: z.string().optional().describe("Optional parent node ID to append the instance into (defaults to page root)"),
  },
  async ({ componentKey, componentId, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentKey,
        componentId,
        x,
        y,
        parentId,
      }, 60000);
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

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

registerTool(server,
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      ),
  },
  async ({ nodeId, radius, corners }: any) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        })
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }: any) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided",
            },
          ],
        };
      }

      const totalToProcess = text.length;

      // Use the plugin's set_multiple_text_contents function with chunking
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      // Cast the result to a specific type to work with it safely
      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }: any) => {
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
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_padding",
  "Set padding values for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    paddingTop: z.number().optional().describe("Top padding value"),
    paddingRight: z.number().optional().describe("Right padding value"),
    paddingBottom: z.number().optional().describe("Bottom padding value"),
    paddingLeft: z.number().optional().describe("Left padding value"),
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }: any) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "BASELINE"])
      .optional()
      .describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }: any) => {
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
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }: any) => {
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
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_item_spacing",
  "Set distance between children in an auto-layout frame",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    itemSpacing: z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing}: any) => {
    try {
      const params: any = { nodeId };
      if (itemSpacing !== undefined) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== undefined) params.counterAxisSpacing = counterAxisSpacing;

      const result = await sendCommandToFigma("set_item_spacing", params);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
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

registerTool(server,
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
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

registerTool(server,
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

registerTool(server,
  "create_component",
  "Create a new Component (not an instance) in Figma. This is the foundation for building a component library.",
  {
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width"),
    height: z.number().optional().describe("Height"),
    name: z.string().describe("Component name (use / for grouping, e.g. 'Icon/Navigation/ArrowBack')"),
    parentId: z.string().optional().describe("Parent node ID"),
    fillColor: z.object({
      r: z.number().min(0).max(1), g: z.number().min(0).max(1),
      b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional()
    }).optional().describe("Fill color in RGBA (0-1)"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode"),
    paddingTop: z.number().optional(), paddingRight: z.number().optional(),
    paddingBottom: z.number().optional(), paddingLeft: z.number().optional(),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    itemSpacing: z.number().optional(),
    description: z.string().optional().describe("Component description"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_component", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_component_set",
  "Combine multiple Component variants into a ComponentSet. Each component must have variant-style naming like 'Property=Value'.",
  {
    componentIds: z.array(z.string()).describe("Array of Component IDs to combine as variants"),
    name: z.string().optional().describe("Name for the ComponentSet"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_component_set", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "insert_svg",
  "Insert an SVG string into Figma. Use this to create icons from SVG markup. The SVG will be converted to Figma vector nodes.",
  {
    svgString: z.string().describe("The SVG markup string to insert"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    name: z.string().optional().describe("Name for the inserted node"),
    parentId: z.string().optional().describe("Parent node ID to insert into"),
    size: z.number().optional().describe("Target size to scale the SVG to (both width and height)"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("insert_svg", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_component_property",
  "Add a Component Property (Boolean, Text, Instance Swap, or Variant) to a Component or ComponentSet. For INSTANCE_SWAP: defaultValue must be the component KEY (not node ID), and targetChildId should be the child Instance node whose mainComponent will be linked.",
  {
    nodeId: z.string().describe("Component or ComponentSet node ID"),
    propertyName: z.string().describe("Property name (e.g. 'Show Icon', 'Label', 'icon')"),
    propertyType: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]).describe("Property type"),
    defaultValue: z.any().optional().describe("Default value. For INSTANCE_SWAP: use component KEY string (not node ID)"),
    targetChildId: z.string().optional().describe("For INSTANCE_SWAP: the child Instance node ID to link. Sets componentPropertyReferences.mainComponent automatically"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_component_property", params);
      const r = result as any;
      let msg = `Set property on "${r.name}": ${r.properties.map((p:any) => `${p.key}(${p.type})`).join(', ')}`;
      if (r.fullPropertyName) msg += ` | fullName: ${r.fullPropertyName}`;
      if (r.linkedChildId) msg += ` | linked child: ${r.linkedChildId}`;
      return { content: [{ type: "text", text: msg }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_component_property_references",
  "Set componentPropertyReferences on a sublayer within a Component. Links a child node's property to an existing component property. Keys: 'visible'|'characters'|'mainComponent'.",
  {
    nodeId: z.string().describe("The sublayer node ID (e.g. a child Instance or Text node)"),
    references: z.record(z.string()).describe("Object mapping property keys to component property names, e.g. { mainComponent: 'icon#10:0' }"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_component_property_references", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_variable_collection",
  "Create a new Variable Collection with modes. Use this to set up the theming system (Colors, Spacing, Radius, Typography, Font collections).",
  {
    name: z.string().describe("Collection name (e.g. 'FigmaExporter Colors')"),
    modes: z.array(z.string()).optional().describe("Mode names (e.g. ['Default-Light', 'Default-Dark', 'CW-Light', 'MP-Dark'])"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_variable_collection", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_variable",
  "Create a new Variable in an existing Variable Collection.",
  {
    collectionId: z.string().describe("Variable Collection ID"),
    name: z.string().describe("Variable name (use / for grouping, e.g. 'color/primary')"),
    resolvedType: z.enum(["BOOLEAN", "FLOAT", "STRING", "COLOR"]).describe("Variable type"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_variable", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_variable_value",
  "Set the value of a Variable for a specific mode. For COLOR type, pass hex string like '#FF0000'.",
  {
    variableId: z.string().describe("Variable ID"),
    modeId: z.string().describe("Mode ID to set the value for"),
    value: z.any().describe("Value to set. For COLOR: hex string. For FLOAT: number. For STRING: string. For BOOLEAN: boolean."),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_variable_value", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_variable_mode_name",
  "Rename a mode in a Variable Collection.",
  {
    collectionId: z.string().describe("Variable Collection ID"),
    modeId: z.string().describe("Mode ID to rename"),
    name: z.string().describe("New name for the mode"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_variable_mode_name", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "bind_variable",
  "Bind a Variable to a node property. This connects component properties to the theming system.",
  {
    nodeId: z.string().describe("Node ID to bind the variable to"),
    field: z.string().describe("Property field to bind. Examples: 'fills/0/color', 'cornerRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'fontSize', 'lineHeight', 'letterSpacing'"),
    variableId: z.string().describe("Variable ID to bind"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("bind_variable", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_opacity",
  "Set the opacity of a node (0 to 1).",
  {
    nodeId: z.string().describe("Node ID"),
    opacity: z.number().min(0).max(1).describe("Opacity value (0-1)"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_opacity", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_visibility",
  "Show or hide a node.",
  {
    nodeId: z.string().describe("Node ID"),
    visible: z.boolean().describe("Whether the node should be visible"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_visibility", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_text_style",
  "Set text style properties: font family, size, weight, line height, letter spacing, alignment, decoration, case.",
  {
    nodeId: z.string().describe("Text node ID"),
    fontFamily: z.string().optional().describe("Font family name (e.g. 'Inter')"),
    fontStyle: z.string().optional().describe("Font style (e.g. 'Regular', 'Bold', 'Medium')"),
    fontSize: z.number().optional().describe("Font size in pixels"),
    fontWeight: z.number().optional().describe("Font weight (100-900)"),
    lineHeight: z.number().optional().describe("Line height in pixels"),
    letterSpacing: z.number().optional().describe("Letter spacing in pixels"),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_text_style", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_effects",
  "Set effects on a node: drop shadow, inner shadow, layer blur, background blur.",
  {
    nodeId: z.string().describe("Node ID"),
    effects: z.array(z.object({
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
      visible: z.boolean().optional(),
      color: z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }).optional(),
      offset: z.object({ x: z.number(), y: z.number() }).optional(),
      radius: z.number().optional(),
      spread: z.number().optional(),
    })).describe("Array of effects to apply"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_effects", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_ellipse",
  "Create an ellipse/circle in Figma. Useful for avatars, radio buttons, status indicators.",
  {
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    width: z.number().optional().describe("Width (default 24)"),
    height: z.number().optional().describe("Height (default 24)"),
    name: z.string().optional().describe("Node name"),
    parentId: z.string().optional().describe("Parent node ID"),
    fillColor: z.object({
      r: z.number().min(0).max(1), g: z.number().min(0).max(1),
      b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional()
    }).optional().describe("Fill color"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_ellipse", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_line",
  "Create a line in Figma. Useful for dividers.",
  {
    x: z.number().optional(), y: z.number().optional(),
    length: z.number().optional().describe("Line length in pixels"),
    direction: z.enum(["horizontal", "vertical"]).optional().describe("Line direction"),
    name: z.string().optional(),
    parentId: z.string().optional(),
    strokeColor: z.object({
      r: z.number().min(0).max(1), g: z.number().min(0).max(1),
      b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional()
    }).optional(),
    strokeWeight: z.number().optional(),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_line", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "flatten_node",
  "Flatten a node (or group) into a single vector. Useful for cleaning up imported SVG icons.",
  {
    nodeId: z.string().describe("Node ID to flatten"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("flatten_node", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_boolean_operation",
  "Create a boolean operation (union, subtract, intersect, exclude) from multiple nodes. Useful for complex icon shapes.",
  {
    nodeIds: z.array(z.string()).describe("Node IDs to combine"),
    operation: z.enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]).optional().describe("Boolean operation type"),
    name: z.string().optional().describe("Name for the result"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_boolean_operation", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "batch_create",
  "Execute multiple Figma commands in a single batch call. Dramatically improves performance for bulk operations like creating many icons or setting up variables.",
  {
    operations: z.array(z.object({
      command: z.string().describe("Command name (any valid command like create_frame, create_text, set_fill_color, etc.)"),
      params: z.any().describe("Parameters for the command"),
    })).describe("Array of operations to execute sequentially"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("batch_create", params, 120000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "set_node_name",
  "Rename a node in Figma.",
  {
    nodeId: z.string().describe("Node ID"),
    name: z.string().describe("New name"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_node_name", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "group_nodes",
  "Group multiple nodes together.",
  {
    nodeIds: z.array(z.string()).describe("Node IDs to group"),
    name: z.string().optional().describe("Group name"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("group_nodes", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "convert_to_component",
  "Convert an existing Frame or Group into a Component. Preserves all children and properties.",
  {
    nodeId: z.string().describe("Frame or Group node ID to convert"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("convert_to_component", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

registerTool(server,
  "create_icon_component",
  "Create an icon component from SVG content. Inserts SVG, flattens vectors, resizes to standard size, sets fill color, and converts to a Component. Returns component ID and key.",
  {
    svgContent: z.string().describe("SVG markup string"),
    name: z.string().optional().describe("Component name, e.g. Icon/Navigation/ArrowBack"),
    x: z.number().optional().describe("X position"),
    y: z.number().optional().describe("Y position"),
    parentId: z.string().optional().describe("Parent frame ID"),
    size: z.number().optional().describe("Icon size in px (default 24)"),
    fillColor: z.string().optional().describe("Fill color hex, e.g. #1C1C1C"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_icon_component", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);
}
