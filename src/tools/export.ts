import { registerTool } from "./register.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { logger } from "../logger.js";
import { sendCommandToFigma, getOperationFile } from "../relay.js";
import { sanitizeFileSegment, resolveExportDirectory, saveBase64Export, choosePngExportScale, exportFileSegment } from "../exports.js";
import { readScopeSchema, assetKindSchema } from "../design.js";

export function registerExportTools(server: McpServer) {
registerTool(server,
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
      const activeFile = await getOperationFile();
      if (!activeFile) throw new Error("Select a connected Figma file before exporting.");
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };
      if (!typedResult?.imageData) throw new Error("Figma returned no export data");

      // Side-effect: also write to disk. Default dir can be overridden with FIGMA_EXPORTER_EXPORT_DIR.
      const exportDir = path.join(resolveExportDirectory(), exportFileSegment(activeFile));
      let savedPath: string | null = null;
      if (typedResult.imageData) {
        try {
          const ext = (format || "PNG").toLowerCase();
          const safeId = nodeId.replace(/[^A-Za-z0-9_-]/g, "_");
          savedPath = path.join(exportDir, `node_${safeId}.${ext}`);
          const byteLength = saveBase64Export(typedResult.imageData, savedPath);
          logger.info(`Exported node ${nodeId} to ${savedPath} (${byteLength} bytes)`);
        } catch (e) {
          logger.warn(`Failed to save export to disk: ${e instanceof Error ? e.message : String(e)}`);
          savedPath = null;
        }
      }

      const content: any[] = [
        (format === "SVG" || format === "PDF") ? {
          type: "resource",
          resource: {
            uri: `figma-export://${encodeURIComponent(activeFile.channel)}/${encodeURIComponent(nodeId)}.${format.toLowerCase()}`,
            mimeType: typedResult.mimeType || (format === "SVG" ? "image/svg+xml" : "application/pdf"),
            blob: typedResult.imageData,
          },
        } : {
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

registerTool(server,
  "export_design_assets",
  "Export every visible recognized asset or screen as PNG. Android always exports at 4x; web chooses a clear scale from the source dimensions while capping oversized output.",
  {
    scope: readScopeSchema.optional().describe("Defaults to all_pages."),
    pageIds: z.array(z.string()).optional().describe("Optional page IDs to export from."),
    nodeIds: z.array(z.string()).optional().describe("Optional subset of recognized asset node IDs."),
    kinds: z.array(assetKindSchema).optional().describe("Optional asset-kind filter."),
    platform: z.enum(["android", "web"]).optional().describe("Android exports PNG at 4x. Web selects an adaptive PNG scale. Defaults to web."),
    outputDirectory: z.string().optional().describe("Local output directory. Defaults to FIGMA_EXPORTER_EXPORT_DIR or ./exports."),
    concurrency: z.number().int().min(1).max(6).optional().describe("Parallel Figma exports. Defaults to 3."),
  },
  async ({ scope, pageIds, nodeIds, kinds, platform, outputDirectory, concurrency }: any) => {
    try {
      const activeFile = await getOperationFile();
      if (!activeFile) throw new Error("Select a connected Figma file before exporting.");
      const exportPlatform: "android" | "web" = platform || "web";
      const listed = await sendCommandToFigma("list_design_assets", {
        scope: scope || "all_pages",
        pageIds,
        kinds,
      }, 120000) as { file?: { name?: string }; assets?: any[] };

      const requestedIds = Array.isArray(nodeIds) ? new Set(nodeIds) : null;
      const deduplicated = new Map<string, any>();
      for (const asset of listed.assets || []) {
        if ((!requestedIds || requestedIds.has(asset.id)) && !deduplicated.has(asset.id)) {
          deduplicated.set(asset.id, asset);
        }
      }
      const assets = [...deduplicated.values()];
      const rootDirectory = resolveExportDirectory(outputDirectory);
      const fileDirectory = path.join(
        rootDirectory,
        exportFileSegment(activeFile),
        exportPlatform
      );
      const exported: any[] = [];
      const failed: any[] = [];
      let nextIndex = 0;

      const worker = async () => {
        while (nextIndex < assets.length) {
          const asset = assets[nextIndex++];
          const exportScale = choosePngExportScale(asset, exportPlatform);
          try {
            const result = await sendCommandToFigma("export_node_as_image", {
              nodeId: asset.id,
              format: "PNG",
              scale: exportScale,
            }, 120000) as { imageData?: string; mimeType?: string };
            if (!result.imageData) throw new Error("Figma returned no image data");

            const safeId = String(asset.id).replace(/[^A-Za-z0-9_-]/g, "_");
            const pageDirectory = path.join(fileDirectory, sanitizeFileSegment(asset.pageName || "page"));
            const targetPath = path.join(
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
              outputWidth: typeof asset.width === "number" ? Math.round(asset.width * exportScale) : undefined,
              outputHeight: typeof asset.height === "number" ? Math.round(asset.height * exportScale) : undefined,
              byteLength,
              path: targetPath,
            });
          } catch (error) {
            failed.push({
              nodeId: asset.id,
              name: asset.name,
              kind: asset.kind,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };

      await Promise.all(Array.from(
        { length: Math.min(concurrency || 3, Math.max(assets.length, 1)) },
        () => worker()
      ));

      const missingNodeIds = requestedIds
        ? [...requestedIds].filter((nodeId) => !deduplicated.has(nodeId))
        : [];
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
            failed,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error exporting design assets: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }
);
}
