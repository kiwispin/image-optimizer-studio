import { fileTypeFromBuffer } from "file-type";
import type { OutputFormat } from "../shared/types.js";

const extensionToMime = new Map<string, string>([
  ["avif", "image/avif"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jxl", "image/jxl"],
  ["png", "image/png"],
  ["webp", "image/webp"]
]);

const mimeToExtension = new Map<string, string>([
  ["image/avif", "avif"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/jpeg", "jpg"],
  ["image/jxl", "jxl"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

export async function detectMime(buffer: Buffer, filename = ""): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected?.mime) {
    return detected.mime;
  }

  const ext = filename.split(".").pop()?.toLowerCase();
  return (ext && extensionToMime.get(ext)) || "application/octet-stream";
}

export function normalizeSharpFormat(format?: string): OutputFormat {
  if (format === "jpg") return "jpeg";
  if (format === "jpeg" || format === "png" || format === "webp" || format === "avif" || format === "jxl") {
    return format;
  }
  return "jpeg";
}

export function extensionForMime(mime: string): string {
  return mimeToExtension.get(mime) || "bin";
}

export function mimeForOutput(format: OutputFormat): string {
  if (format === "auto" || format === "original") return "application/octet-stream";
  if (format === "jpeg") return "image/jpeg";
  return `image/${format}`;
}

export function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return base.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "image";
}
