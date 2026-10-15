import { z } from "zod";
export const nodeFilterOptionsSchema = z.object({
  includeChildren: z.boolean().optional().describe("Include recursive child nodes. Defaults to true."),
  includeVectors: z.boolean().optional().describe("Include VECTOR nodes. Defaults to true."),
  includeText: z.boolean().optional().describe("Include TEXT nodes and characters. Defaults to true."),
  includeInvisible: z.boolean().optional().describe("Deprecated and ignored. Hidden nodes and hidden ancestor branches are always excluded."),
  includeFills: z.boolean().optional().describe("Include fill/stroke metadata. Defaults to true."),
  includeEffects: z.boolean().optional().describe("Include effect metadata. Defaults to true."),
  includeTextSegments: z.boolean().optional().describe("Include mixed-style text runs. Defaults to true."),
  includeComponentMetadata: z.boolean().optional().describe("Include component, instance, variant, and bound-variable metadata. Defaults to true."),
  includeReactions: z.boolean().optional().describe("Include prototype reactions. Defaults to false."),
  maxDepth: z.number().int().min(0).max(1000).optional().describe("Maximum child depth. Omit to read the complete hierarchy."),
  assetOnly: z.boolean().optional().describe("Return only export/image/vector-like asset nodes and ancestors."),
}).optional();

export const readScopeSchema = z.enum(["selection", "current_page", "all_pages"]);

export const assetKindSchema = z.enum(["screen", "image", "media", "vector", "slice", "configured", "asset"]);
