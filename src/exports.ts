import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
export function sanitizeFileSegment(value: string, fallback: string = "unnamed"): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  return sanitized || fallback;
}

export function resolveExportDirectory(customDirectory?: string): string {
  return path.resolve(customDirectory || process.env.FIGMA_EXPORTER_EXPORT_DIR || path.join(process.cwd(), "exports"));
}

export function saveBase64Export(imageData: string, targetPath: string): number {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const buffer = Buffer.from(imageData, "base64");
  fs.writeFileSync(targetPath, buffer);
  return buffer.length;
}

export function choosePngExportScale(asset: { width?: number; height?: number }, platform: "android" | "web"): number {
  if (platform === "android") return 4;

  const width = Number.isFinite(Number(asset.width)) ? Math.max(0, Number(asset.width)) : 0;
  const height = Number.isFinite(Number(asset.height)) ? Math.max(0, Number(asset.height)) : 0;
  const maxDimension = Math.max(width, height);
  if (maxDimension <= 0) return 2;

  // Small web assets need more density; large screenshots are capped to avoid wasteful files.
  const desiredScale = maxDimension <= 128 ? 4 : maxDimension <= 768 ? 3 : 2;
  const dimensionCap = 4096 / maxDimension;
  const areaCap = width > 0 && height > 0
    ? Math.sqrt(16_000_000 / (width * height))
    : desiredScale;
  const cappedScale = Math.min(desiredScale, dimensionCap, areaCap);
  return cappedScale >= 0.25 ? Math.floor(cappedScale * 4) / 4 : cappedScale;
}


export function exportFileSegment(file: { fileName?: string; fileKey?: string; channel?: string }) {
  const identity = file.fileKey || file.channel;
  if (!identity) throw new Error("Cannot export without an identified connected file.");
  return `${sanitizeFileSegment(file.fileName || "figma")}__${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}
