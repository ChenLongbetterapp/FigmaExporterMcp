#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket, { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import http from "http";
import fs from "fs";
import path from "path";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// ===== Embedded Relay: Connected Figma files =====
interface FigmaFile {
  ws: WebSocket;
  channel: string;
  fileName: string;
  fileKey: string;
  connectedAt: number;
}
const connectedFiles = new Map<string, FigmaFile>();
let activeFileChannel: string | null = null;
const activeFileBySession = new Map<string, string>();

// Pending request tracking
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number;
}>();

// Create MCP server
const server = new McpServer({
  name: "FigmaExporterMCP",
  version: "2.0.0",
});

// Config
const RELAY_PORT = parseInt(process.env.FIGMA_EXPORTER_RELAY_PORT || "3066", 10);
const DEFAULT_SESSION_ID = "default";
const MCP_SESSION_ID = process.env.FIGMA_EXPORTER_SESSION_ID || `mcp-${uuidv4()}`;
let relayActive = false;  // true when this instance owns the relay

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
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

// Selection Tool
server.tool(
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

type FigmaNodeFilterOptions = {
  includeChildren?: boolean;
  includeVectors?: boolean;
  includeText?: boolean;
  includeInvisible?: boolean;
  includeFills?: boolean;
  includeEffects?: boolean;
  maxDepth?: number;
  assetOnly?: boolean;
};

const nodeFilterOptionsSchema = z.object({
  includeChildren: z.boolean().optional().describe("Include recursive child nodes. Defaults to true."),
  includeVectors: z.boolean().optional().describe("Include VECTOR nodes. Defaults to true."),
  includeText: z.boolean().optional().describe("Include TEXT nodes and characters. Defaults to true."),
  includeInvisible: z.boolean().optional().describe("Include hidden nodes. Defaults to true."),
  includeFills: z.boolean().optional().describe("Include fill/stroke metadata. Defaults to true."),
  includeEffects: z.boolean().optional().describe("Include effect metadata. Defaults to true."),
  maxDepth: z.number().int().min(0).max(50).optional().describe("Maximum child depth to return."),
  assetOnly: z.boolean().optional().describe("Return only export/image/vector-like asset nodes and ancestors."),
}).optional();

// Read My Design Tool
server.tool(
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
            text: JSON.stringify(filterFigmaNodeResult(result, options))
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

// Node Info Tool
server.tool(
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
            text: JSON.stringify(filterFigmaNode(result, options))
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

function rgbaToHex(color: any): string {
  if (!color) return color;
  if (typeof color === "string") return color;

  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const alpha = color.a === undefined ? 1 : color.a;
  const a = Math.round(alpha * 255);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a === 255 ? "" : a.toString(16).padStart(2, "0")}`;
}

function normalizeNodeFilterOptions(options: FigmaNodeFilterOptions = {}): Required<FigmaNodeFilterOptions> {
  return {
    includeChildren: options.includeChildren !== false,
    includeVectors: options.includeVectors !== false,
    includeText: options.includeText !== false,
    includeInvisible: options.includeInvisible !== false,
    includeFills: options.includeFills !== false,
    includeEffects: options.includeEffects !== false,
    maxDepth: typeof options.maxDepth === "number" ? options.maxDepth : 20,
    assetOnly: options.assetOnly === true,
  };
}

function simplifyPaint(paint: any) {
  const out: any = {
    type: paint.type,
    visible: paint.visible !== false,
    opacity: typeof paint.opacity === "number" ? paint.opacity : 1,
  };
  if (paint.color) out.color = rgbaToHex(paint.color);
  if (typeof paint.imageRef === "string") out.imageRef = paint.imageRef;
  if (typeof paint.imageHash === "string") out.imageHash = paint.imageHash;
  if (paint.scaleMode) out.scaleMode = paint.scaleMode;
  if (Array.isArray(paint.gradientStops)) {
    out.gradientStops = paint.gradientStops.map((stop: any) => ({
      position: stop.position,
      color: stop.color ? rgbaToHex(stop.color) : undefined,
    }));
  }
  return out;
}

function isAssetLikeNode(node: any): boolean {
  const width = node.absoluteBoundingBox?.width ?? node.width ?? 0;
  const height = node.absoluteBoundingBox?.height ?? node.height ?? 0;
  const name = String(node.name || "").toLowerCase();
  const hasImageFill = Array.isArray(node.fills) && node.fills.some((fill: any) => fill.type === "IMAGE" && (fill.imageRef || fill.imageHash));
  const hasExport = Array.isArray(node.exportSettings) && node.exportSettings.length > 0;
  const assetName = /illustration|icon|mockup|phone|card|badge|logo|avatar|widget|theme|image|picture|photo|reminder|streak|completed/.test(name);

  if (width < 2 || height < 2 || width > 2500 || height > 3000) return false;
  return node.type === "SLICE" || hasImageFill || hasExport || (node.type === "VECTOR" && width <= 1000 && height <= 1000) || assetName;
}

function filterFigmaNode(node: any, options: FigmaNodeFilterOptions = {}, depth = 0): any {
  if (!node) return null;
  const opts = normalizeNodeFilterOptions(options);

  if (!opts.includeInvisible && node.visible === false) return null;
  if (!opts.includeVectors && node.type === "VECTOR") return null;
  if (!opts.includeText && node.type === "TEXT") return null;

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = {
      x: node.absoluteBoundingBox.x,
      y: node.absoluteBoundingBox.y,
      width: node.absoluteBoundingBox.width,
      height: node.absoluteBoundingBox.height,
    };
  }
  if (typeof node.width === "number") filtered.width = node.width;
  if (typeof node.height === "number") filtered.height = node.height;

  if (opts.includeFills && Array.isArray(node.fills) && node.fills.length > 0) {
    filtered.fills = node.fills.map(simplifyPaint);
    filtered.hasImageFill = node.fills.some((fill: any) => fill.type === "IMAGE" && (fill.imageRef || fill.imageHash));
  }

  if (opts.includeFills && Array.isArray(node.strokes) && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map(simplifyPaint);
  }

  if (typeof node.cornerRadius === "number") filtered.cornerRadius = node.cornerRadius;
  if (opts.includeText && typeof node.characters === "string") filtered.characters = node.characters;
  if (opts.includeText && node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
      textCase: node.textCase,
      textDecoration: node.textDecoration,
    };
  }

  if (Array.isArray(node.exportSettings) && node.exportSettings.length > 0) {
    filtered.exportSettings = node.exportSettings.map((setting: any) => ({
      format: setting.format,
      suffix: setting.suffix,
      constraint: setting.constraint ? {
        type: setting.constraint.type,
        value: setting.constraint.value,
      } : undefined,
    }));
  }

  if (opts.includeEffects && Array.isArray(node.effects) && node.effects.length > 0) {
    filtered.effects = node.effects.map((effect: any) => ({
      type: effect.type,
      visible: effect.visible !== false,
      radius: effect.radius,
      color: effect.color ? rgbaToHex(effect.color) : undefined,
      offset: effect.offset,
      spread: effect.spread,
    }));
  }

  if (typeof node.layoutMode === "string" && node.layoutMode !== "NONE") filtered.layoutMode = node.layoutMode;
  if (typeof node.itemSpacing === "number") filtered.itemSpacing = node.itemSpacing;
  if (typeof node.paddingLeft === "number") filtered.paddingLeft = node.paddingLeft;
  if (typeof node.paddingRight === "number") filtered.paddingRight = node.paddingRight;
  if (typeof node.paddingTop === "number") filtered.paddingTop = node.paddingTop;
  if (typeof node.paddingBottom === "number") filtered.paddingBottom = node.paddingBottom;
  if (typeof node.opacity === "number" && node.opacity !== 1) filtered.opacity = node.opacity;
  if (node.visible === false) filtered.visible = false;

  if (opts.includeChildren && depth < opts.maxDepth && Array.isArray(node.children)) {
    filtered.children = node.children
      .map((child: any) => filterFigmaNode(child, opts, depth + 1))
      .filter((child: any) => child !== null);
  }

  if (opts.assetOnly && !isAssetLikeNode(filtered) && (!filtered.children || filtered.children.length === 0)) {
    return null;
  }

  return filtered;
}

function filterFigmaNodeResult(result: any, options: FigmaNodeFilterOptions = {}): any {
  if (Array.isArray(result)) {
    return result
      .map((item: any) => {
        if (item && typeof item === "object" && "document" in item) {
          const document = filterFigmaNode(item.document, options);
          return document ? { ...item, document } : null;
        }
        return filterFigmaNode(item, options);
      })
      .filter((item: any) => item !== null);
  }

  if (result && typeof result === "object" && "document" in result) {
    const document = filterFigmaNode(result.document, options);
    return document ? { ...result, document } : null;
  }

  return filterFigmaNode(result, options);
}

// Nodes Info Tool
server.tool(
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
            text: JSON.stringify(results.map((result) => filterFigmaNode(result.info, options)))
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


// Create Rectangle Tool
server.tool(
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
            text: `Created rectangle "${JSON.stringify(result)}"`,
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

// Create Frame Tool
server.tool(
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
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
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

// Create Text Tool
server.tool(
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
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
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

// Set Fill Color Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
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

// Set Stroke Color Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
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

// Move Node Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
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

// Clone Node Tool
server.tool(
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
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
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

// Resize Node Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
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

// Delete Node Tool
server.tool(
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

// Delete Multiple Nodes Tool
server.tool(
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

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export a node as an image from Figma",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format"),
    scale: z.number().positive().optional().describe("Export scale"),
  },
  async ({ nodeId, format, scale }: any) => {
    try {
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };

      // Side-effect: also write to disk. Default dir can be overridden with FIGMA_EXPORTER_EXPORT_DIR.
      const exportDir = process.env.FIGMA_EXPORTER_EXPORT_DIR || "/tmp/figma_exports";
      let savedPath: string | null = null;
      if (typedResult.imageData) {
        try {
          fs.mkdirSync(exportDir, { recursive: true });
          const ext = (format || "PNG").toLowerCase();
          const safeId = nodeId.replace(/[^A-Za-z0-9_-]/g, "_");
          savedPath = path.join(exportDir, `node_${safeId}.${ext}`);
          const buf = Buffer.from(typedResult.imageData, "base64");
          fs.writeFileSync(savedPath, buf);
          logger.info(`Exported node ${nodeId} to ${savedPath} (${buf.length} bytes)`);
        } catch (e) {
          logger.warn(`Failed to save export to disk: ${e instanceof Error ? e.message : String(e)}`);
          savedPath = null;
        }
      }

      const content: any[] = [
        {
          type: "image",
          data: typedResult.imageData,
          mimeType: typedResult.mimeType || "image/png",
        },
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
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Text Content Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
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

// Get Styles Tool
server.tool(
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

// Get Local Components Tool
server.tool(
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

// Get Annotations Tool
server.tool(
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

// Set Annotation Tool
server.tool(
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

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
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

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
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

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
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
          initialStatus,
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

// Create Component Instance Tool
server.tool(
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

// Copy Instance Overrides Tool
server.tool(
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
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
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

// Set Instance Overrides Tool
server.tool(
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
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
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


// Set Corner Radius Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`,
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

// Define design strategy prompt
server.prompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
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
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
    };
  }
);

server.prompt(
  "read_design_strategy",
  "Best practices for reading Figma designs",
  (extra) => {
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
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Node Scanning Tool
server.tool(
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

// Node Type Scanning Tool
server.tool(
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

// Text Replacement Strategy Prompt
server.prompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
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

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Set Multiple Text Contents Tool
server.tool(
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

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
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

      // Format the results for display
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
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
          initialStatus,
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

// Annotation Conversion Strategy Prompt
server.prompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
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
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
server.prompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
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
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// Set Layout Mode Tool
server.tool(
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
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ''}`,
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

// Set Padding Tool
server.tool(
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
      const typedResult = result as { name: string };

      // Create a message about which padding values were set
      const paddingMessages = [];
      if (paddingTop !== undefined) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== undefined) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== undefined) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== undefined) paddingMessages.push(`left: ${paddingLeft}`);

      const paddingText = paddingMessages.length > 0
        ? `padding (${paddingMessages.join(', ')})`
        : "padding";

      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`,
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

// Set Axis Align Tool
server.tool(
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
      const typedResult = result as { name: string };

      // Create a message about which alignments were set
      const alignMessages = [];
      if (primaryAxisAlignItems !== undefined) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== undefined) alignMessages.push(`counter: ${counterAxisAlignItems}`);

      const alignText = alignMessages.length > 0
        ? `axis alignment (${alignMessages.join(', ')})`
        : "axis alignment";

      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`,
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

// Set Layout Sizing Tool
server.tool(
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
      const typedResult = result as { name: string };

      // Create a message about which sizing modes were set
      const sizingMessages = [];
      if (layoutSizingHorizontal !== undefined) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== undefined) sizingMessages.push(`vertical: ${layoutSizingVertical}`);

      const sizingText = sizingMessages.length > 0
        ? `layout sizing (${sizingMessages.join(', ')})`
        : "layout sizing";

      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`,
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

// Set Item Spacing Tool
server.tool(
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
      const typedResult = result as { name: string, itemSpacing?: number, counterAxisSpacing?: number };

      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== undefined) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== undefined) message += ` counterAxisSpacing=${counterAxisSpacing}`;

      return {
        content: [
          {
            type: "text",
            text: message,
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

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
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

// Create Connectors Tool
server.tool(
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
            text: `Default connector set: ${JSON.stringify(result)}`
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

// Connect Nodes Tool
server.tool(
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
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
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

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
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

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
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

// ═══════════════════════════════════════════════════════════════════════════════
// FIGMA_EXPORTER CUSTOM TOOLS — Component Library Building
// ═══════════════════════════════════════════════════════════════════════════════

// Create Component Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Created component "${r.name}" (ID: ${r.id}, Key: ${r.key})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Component Set (Variants)
server.tool(
  "create_component_set",
  "Combine multiple Component variants into a ComponentSet. Each component must have variant-style naming like 'Property=Value'.",
  {
    componentIds: z.array(z.string()).describe("Array of Component IDs to combine as variants"),
    name: z.string().optional().describe("Name for the ComponentSet"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_component_set", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Created ComponentSet "${r.name}" (ID: ${r.id}) with ${r.childCount} variants: ${r.children.map((c:any) => c.name).join(', ')}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Insert SVG Tool — Critical for building icon library
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Inserted SVG "${r.name}" (ID: ${r.id}, ${r.width}×${r.height})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Component Property Tool
server.tool(
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

// Set Component Property References Tool
server.tool(
  "set_component_property_references",
  "Set componentPropertyReferences on a sublayer within a Component. Links a child node's property to an existing component property. Keys: 'visible'|'characters'|'mainComponent'.",
  {
    nodeId: z.string().describe("The sublayer node ID (e.g. a child Instance or Text node)"),
    references: z.record(z.string()).describe("Object mapping property keys to component property names, e.g. { mainComponent: 'icon#10:0' }"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_component_property_references", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Set componentPropertyReferences on "${r.name}" (${r.id}): ${JSON.stringify(r.componentPropertyReferences)}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Variable Collection Tool
server.tool(
  "create_variable_collection",
  "Create a new Variable Collection with modes. Use this to set up the theming system (Colors, Spacing, Radius, Typography, Font collections).",
  {
    name: z.string().describe("Collection name (e.g. 'FigmaExporter Colors')"),
    modes: z.array(z.string()).optional().describe("Mode names (e.g. ['Default-Light', 'Default-Dark', 'CW-Light', 'MP-Dark'])"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("create_variable_collection", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Created collection "${r.name}" (ID: ${r.id}) with modes: ${r.modes.map((m:any) => `${m.name}(${m.modeId})`).join(', ')}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Variable Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Created variable "${r.name}" (ID: ${r.id}, type: ${r.resolvedType})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Variable Value Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Set variable "${r.name}" for mode ${r.modeId} = ${JSON.stringify(r.value)}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Variable Mode Name Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Renamed mode. Modes: ${r.modes.map((m:any) => `${m.name}(${m.modeId})`).join(', ')}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Bind Variable Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Bound variable "${r.variableName}" to node ${r.nodeId} field "${r.field}"` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Opacity Tool
server.tool(
  "set_opacity",
  "Set the opacity of a node (0 to 1).",
  {
    nodeId: z.string().describe("Node ID"),
    opacity: z.number().min(0).max(1).describe("Opacity value (0-1)"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_opacity", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Set opacity of ${r.id} to ${r.opacity}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Visibility Tool
server.tool(
  "set_visibility",
  "Show or hide a node.",
  {
    nodeId: z.string().describe("Node ID"),
    visible: z.boolean().describe("Whether the node should be visible"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_visibility", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Set visibility of ${r.id} to ${r.visible}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Text Style Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Set text style on ${r.id}: fontSize=${r.fontSize}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Set Effects Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Set ${r.effects.length} effects on node ${r.id}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Ellipse Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Created ellipse "${r.name}" (ID: ${r.id}, ${r.width}×${r.height})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Line Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Created line "${r.name}" (ID: ${r.id})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Flatten Node Tool
server.tool(
  "flatten_node",
  "Flatten a node (or group) into a single vector. Useful for cleaning up imported SVG icons.",
  {
    nodeId: z.string().describe("Node ID to flatten"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("flatten_node", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Flattened to "${r.name}" (ID: ${r.id}, type: ${r.type})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Boolean Operation Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Created ${r.operation} "${r.name}" (ID: ${r.id})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Batch Create Tool
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Batch complete: ${r.succeeded}/${r.total} succeeded, ${r.failed} failed.\n${JSON.stringify(r.results.map((res:any) => ({ cmd: res.command, ok: res.success, id: res.result?.id, err: res.error })))}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Get Local Variables Tool
server.tool(
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

// Set Node Name Tool
server.tool(
  "set_node_name",
  "Rename a node in Figma.",
  {
    nodeId: z.string().describe("Node ID"),
    name: z.string().describe("New name"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("set_node_name", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Renamed to "${r.name}" (ID: ${r.id})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Group Nodes Tool
server.tool(
  "group_nodes",
  "Group multiple nodes together.",
  {
    nodeIds: z.array(z.string()).describe("Node IDs to group"),
    name: z.string().optional().describe("Group name"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("group_nodes", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Created group "${r.name}" (ID: ${r.id}) with ${r.childCount} children` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Convert To Component Tool
server.tool(
  "convert_to_component",
  "Convert an existing Frame or Group into a Component. Preserves all children and properties.",
  {
    nodeId: z.string().describe("Frame or Group node ID to convert"),
  },
  async (params: any) => {
    try {
      const result = await sendCommandToFigma("convert_to_component", params);
      const r = result as any;
      return { content: [{ type: "text", text: `Converted to component "${r.name}" (ID: ${r.id}, Key: ${r.key})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Create Icon Component Tool - Insert SVG + flatten + convert to component in one step
server.tool(
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
      const r = result as any;
      return { content: [{ type: "text", text: `Created icon component "${r.name}" (ID: ${r.id}, Key: ${r.key}, ${r.width}×${r.height})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
server.prompt(
  "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
  (extra) => {
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
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
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
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);


// Define command types and parameters
type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  | "create_component"
  | "create_component_set"
  | "insert_svg"
  | "set_component_property"
  | "set_component_property_references"
  | "create_variable_collection"
  | "create_variable"
  | "set_variable_value"
  | "set_variable_mode_name"
  | "bind_variable"
  | "set_opacity"
  | "set_visibility"
  | "set_text_style"
  | "set_effects"
  | "create_ellipse"
  | "create_line"
  | "flatten_node"
  | "create_boolean_operation"
  | "batch_create"
  | "get_local_variables"
  | "set_node_name"
  | "group_nodes"
  | "convert_to_component"
  | "create_icon_component";

type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string; options?: FigmaNodeFilterOptions };
  get_nodes_info: { nodeIds: string[]; options?: FigmaNodeFilterOptions };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  move_node: {
    nodeId: string;
    x: number;
    y: number;
  };
  resize_node: {
    nodeId: string;
    width: number;
    height: number;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
    parentId?: string;
  };
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number;
  };
  execute_code: {
    code: string;
  };
  set_corner_radius: {
    nodeId: string;
    radius: number;
    corners?: boolean[];
  };
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  set_text_content: {
    nodeId: string;
    text: string;
  };
  scan_text_nodes: {
    nodeId: string;
    useChunking: boolean;
    chunkSize: number;
  };
  set_multiple_text_contents: {
    nodeId: string;
    text: Array<{ nodeId: string; text: string }>;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
  scan_nodes_by_types: {
    nodeId: string;
    types: Array<string>;
  };
  get_reactions: { nodeIds: string[] };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };
  // ---- FIGMA_EXPORTER CUSTOM COMMAND PARAMS ----
  create_component: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
  };
  create_component_set: {
    componentIds: string[];
    name?: string;
  };
  insert_svg: {
    svgContent: string;
    x?: number;
    y?: number;
    parentId?: string;
    name?: string;
  };
  set_component_property: {
    nodeId: string;
    propertyName: string;
    propertyType: string;
    defaultValue: string | boolean | Record<string, unknown>;
    preferredValues?: Array<{ type: string; key: string }>;
    targetChildId?: string;
  };
  set_component_property_references: {
    nodeId: string;
    references: Record<string, string>;
  };
  create_variable_collection: {
    name: string;
    modes?: string[];
    variables?: Array<{ name: string; type: string; values: Record<string, unknown> }>;
  };
  create_variable: {
    collectionId: string;
    name: string;
    type: string;
    value?: unknown;
  };
  set_variable_value: {
    variableId: string;
    modeId: string;
    value: unknown;
  };
  set_variable_mode_name: {
    collectionId: string;
    modeId: string;
    name: string;
  };
  bind_variable: {
    nodeId: string;
    property: string;
    variableId: string;
  };
  set_opacity: {
    nodeId: string;
    opacity: number;
  };
  set_visibility: {
    nodeId: string;
    visible: boolean;
  };
  set_text_style: {
    nodeId: string;
    fontSize?: number;
    fontFamily?: string;
    fontStyle?: string;
    letterSpacing?: number;
    lineHeight?: number | string;
    textAlign?: string;
    textDecoration?: string;
  };
  set_effects: {
    nodeId: string;
    effects: Array<{
      type: string;
      color?: { r: number; g: number; b: number; a?: number };
      offset?: { x: number; y: number };
      radius?: number;
      spread?: number;
      visible?: boolean;
    }>;
  };
  create_ellipse: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    arcStartAngle?: number;
    arcEndAngle?: number;
    arcSweepAngle?: number;
  };
  create_line: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    name?: string;
    parentId?: string;
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  flatten_node: {
    nodeId: string;
  };
  create_boolean_operation: {
    nodeIds: string[];
    operation: string;
    name?: string;
  };
  batch_create: {
    commands: Array<{ type: string; params: Record<string, unknown> }>;
  };
  get_local_variables: Record<string, never>;
  set_node_name: {
    nodeId: string;
    name: string;
  };
  group_nodes: {
    nodeIds: string[];
    name?: string;
  };
  convert_to_component: {
    nodeId: string;
  };
  create_icon_component: {
    svgContent: string;
    name?: string;
    x?: number;
    y?: number;
    parentId?: string;
    size?: number;
    fillColor?: string | { r: number; g: number; b: number; a?: number };
  };
};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

// ===== Embedded WebSocket Relay =====
// The MCP server IS the relay. Figma plugins connect directly to it.

function normalizeSessionId(sessionId?: string | null): string {
  const normalized = (sessionId || "").trim();
  return normalized || DEFAULT_SESSION_ID;
}

function getFallbackFile(): FigmaFile | null {
  if (connectedFiles.size === 0) {
    return null;
  }
  return connectedFiles.values().next().value!;
}

function getActiveChannelForSession(sessionId: string): string | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const sessionChannel = activeFileBySession.get(normalizedSessionId);
  if (sessionChannel && connectedFiles.has(sessionChannel)) {
    return sessionChannel;
  }
  if (activeFileChannel && connectedFiles.has(activeFileChannel)) {
    return activeFileChannel;
  }
  return getFallbackFile()?.channel || null;
}

function getActiveFile(sessionId: string = MCP_SESSION_ID): FigmaFile | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const activeChannel = getActiveChannelForSession(normalizedSessionId);
  if (activeChannel && connectedFiles.has(activeChannel)) {
    activeFileBySession.set(normalizedSessionId, activeChannel);
    activeFileChannel = activeChannel;
    return connectedFiles.get(activeChannel)!;
  }
  return null;
}

function setActiveFileForSession(
  keyword: string,
  sessionId: string = MCP_SESSION_ID
): { matched: boolean; activeFileChannel: string | null; file?: FigmaFile } {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const kw = (keyword || "").toLowerCase();
  let matchedChannel: string | null = null;

  if (connectedFiles.has(keyword)) {
    matchedChannel = keyword;
  } else {
    for (const [channel, file] of connectedFiles.entries()) {
      if (
        file.fileName.toLowerCase().includes(kw) ||
        channel.toLowerCase().includes(kw)
      ) {
        matchedChannel = channel;
        break;
      }
    }
  }

  if (!matchedChannel) {
    return { matched: false, activeFileChannel: getActiveChannelForSession(normalizedSessionId) };
  }

  activeFileBySession.set(normalizedSessionId, matchedChannel);
  activeFileChannel = matchedChannel;
  return {
    matched: true,
    activeFileChannel: matchedChannel,
    file: connectedFiles.get(matchedChannel),
  };
}

function startRelay(port: number = RELAY_PORT): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /channels — list active files (backward compat for external tools)
    if (req.url === "/channels" && req.method === "GET") {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
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
    if (req.url === "/api/command" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { command, params, timeoutMs, sessionId } = JSON.parse(body);
          const result = await sendCommandToFigma(
            command as FigmaCommand,
            params,
            timeoutMs || 30000,
            normalizeSessionId(sessionId)
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
    if (req.url === "/api/set_active_file" && req.method === "POST") {
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

          // If this is the first file, make it active
          if (!activeFileChannel || !connectedFiles.has(activeFileChannel)) {
            activeFileChannel = channelName;
          }
          if (!activeFileBySession.has(DEFAULT_SESSION_ID)) {
            activeFileBySession.set(DEFAULT_SESSION_ID, channelName);
          }

          logger.info(`Figma file registered: "${data.fileName || channelName}" (channel: ${channelName})`);
          logger.info(`Total connected files: ${connectedFiles.size}, active: ${activeFileChannel}`);

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
        if (data.type === "message" && data.message) {
          const msg = data.message;

          // Handle progress updates
          if (msg.type === "progress_update") {
            const progressData = msg.data as CommandProgressUpdate;
            const requestId = data.id || msg.id || "";

            if (requestId && pendingRequests.has(requestId)) {
              const request = pendingRequests.get(requestId)!;
              request.lastActivity = Date.now();
              clearTimeout(request.timeout);
              request.timeout = setTimeout(() => {
                if (pendingRequests.has(requestId)) {
                  pendingRequests.delete(requestId);
                  request.reject(new Error("Request to Figma timed out"));
                }
              }, 60000);
              logger.info(`Progress: ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
            }
            return;
          }

          // Handle command result
          if (msg.id && pendingRequests.has(msg.id)) {
            const request = pendingRequests.get(msg.id)!;
            clearTimeout(request.timeout);

            if (msg.error) {
              request.reject(new Error(msg.error));
            } else if (msg.result) {
              request.resolve(msg.result);
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
      if (pluginChannel) {
        logger.info(`Figma file disconnected: ${pluginChannel}`);
        connectedFiles.delete(pluginChannel);

        // If active file disconnected, switch to another
        if (activeFileChannel === pluginChannel) {
          if (connectedFiles.size > 0) {
            activeFileChannel = connectedFiles.keys().next().value!;
            logger.info(`Switched active file to: ${activeFileChannel}`);
          } else {
            activeFileChannel = null;
            logger.info("No Figma files connected");
          }
        }
        for (const [sessionId, channel] of activeFileBySession.entries()) {
          if (channel === pluginChannel) {
            activeFileBySession.delete(sessionId);
          }
        }
      }
    });

    pluginWs.on("error", (err: Error) => {
      logger.error(`Plugin WebSocket error: ${err.message}`);
    });
  });

  return new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      relayActive = true;
      logger.info(`FigmaExporter relay listening on port ${port}`);
      resolve();
    });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        relayActive = false;
        logger.warn(`Port ${port} already in use. Running in proxy mode — commands will be forwarded to the existing relay.`);
      } else {
        relayActive = false;
        logger.error(`Relay server error: ${err.message}`);
      }
      resolve(); // always resolve so MCP server still starts
    });
  });
}

// Function to send commands to Figma (supports relay mode and proxy mode)
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000,
  sessionId: string = MCP_SESSION_ID
): Promise<unknown> {
  // Proxy mode: forward via HTTP to the instance that owns the relay
  if (!relayActive) {
    return proxyCommandViaHttp(command, params, timeoutMs, sessionId);
  }

  // Relay mode: send directly via WebSocket
  return new Promise((resolve, reject) => {
    const file = getActiveFile(sessionId);
    if (!file) {
      reject(new Error("No Figma file connected. Open a Figma file and start the FigmaExporter plugin."));
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
    });

    logger.info(`→ ${command} → ${file.fileName}`);
    file.ws.send(JSON.stringify(request));
  });
}

// Proxy a command through HTTP to the relay-owning instance
async function proxyCommandViaHttp(
  command: FigmaCommand,
  params: unknown,
  timeoutMs: number,
  sessionId: string
): Promise<unknown> {
  const url = `http://127.0.0.1:${RELAY_PORT}/api/command`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, params, timeoutMs, sessionId: normalizeSessionId(sessionId) }),
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
async function proxyGetConnectedFiles(sessionId: string = MCP_SESSION_ID): Promise<Array<{ channel: string; fileName: string; fileKey: string; clients: number; joinedAt: number; active?: boolean }>> {
  const url = `http://127.0.0.1:${RELAY_PORT}/channels?sessionId=${encodeURIComponent(normalizeSessionId(sessionId))}`;
  try {
    const res = await fetch(url);
    return await res.json() as any[];
  } catch {
    return [];
  }
}

// ===== File management tools =====

server.tool(
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
  }
);

server.tool(
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
        });
        const data = await res.json() as { matched?: boolean; activeFileChannel?: string; fileName?: string; error?: string };
        if (data.error) throw new Error(data.error);
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

    if (connectedFiles.size === 0) {
      return {
        content: [{
          type: "text",
          text: "No Figma files connected.",
        }],
      };
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
  }
);

// Start the server
async function main() {
  // Start the embedded relay (WebSocket + HTTP server)
  await startRelay(RELAY_PORT);
  logger.info(relayActive ? "Relay mode: this instance owns the relay" : "Proxy mode: forwarding commands to existing relay");

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("FigmaExporter MCP server running on stdio");
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaExporter MCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
