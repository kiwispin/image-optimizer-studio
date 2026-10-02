import archiver from "archiver";
import express from "express";
import multer from "multer";
import path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { NextFunction, Request, Response } from "express";
import type { ProcessOptions } from "../shared/types.js";
import type { OutputFormat } from "../shared/types.js";
import { processUpload } from "./processor.js";
import { detectMime, extensionForMime } from "./format.js";
import { specialistToolStatus } from "./external-tools.js";
import { ensureStore, incomingDir, originalPath, outputsDir, sweepStore } from "./store.js";
import {
  allowUrlImport,
  isHostedDeployment,
  maxAvifPixels,
  maxInputPixels,
  maxUploadBytes,
  processConcurrency,
  retentionMs
} from "./config.js";

const sweepIntervalMs = Math.min(retentionMs, 10 * 60 * 1000);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => {
      ensureStore().then(() => callback(null, incomingDir), (error) => callback(error, incomingDir));
    },
    filename: (_request, _file, callback) => callback(null, `${nanoid(12)}.upload`)
  }),
  limits: {
    fileSize: maxUploadBytes,
    files: 500
  }
});

interface StoredOutput {
  path: string;
  filename: string;
  type: string;
  sourcePath?: string;
  sourceName?: string;
}

interface StoredSource {
  path: string;
  filename: string;
  type: string;
}

// Only file paths are kept in memory now. Previously every uploaded image buffer was held here
// (twice) for the life of the process, which is what exhausted memory on small hosts.
const resultByOutputId = new Map<string, StoredOutput>();
const sourceByJobId = new Map<string, StoredSource>();

/** Simple FIFO limiter so concurrent uploads can't multiply peak memory. */
let activeJobs = 0;
const waiting: Array<() => void> = [];

async function withProcessingSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeJobs >= processConcurrency) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeJobs += 1;
  try {
    return await task();
  } finally {
    activeJobs -= 1;
    waiting.shift()?.();
  }
}

function parseOptions(raw: unknown): Partial<ProcessOptions> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Partial<ProcessOptions>;
    } catch {
      return {};
    }
  }
  return raw as Partial<ProcessOptions>;
}

function dispositionHeader(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const maxRemoteBytes = 100 * 1024 * 1024;

async function fetchSource(url: string): Promise<{ buffer: Buffer; filename: string; type: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https source URLs are supported.");
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`Could not fetch source URL: ${response.status} ${response.statusText}`);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxRemoteBytes) {
    throw new Error("Source image is too large.");
  }
  // Stream with a byte counter so a response without Content-Length can't fill memory.
  const chunks: Buffer[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxRemoteBytes) {
      await reader.cancel();
      throw new Error("Source image is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks);
  const type = response.headers.get("content-type")?.split(";")[0] || (await detectMime(buffer, url));
  const filename = path.basename(parsed.pathname) || `remote.${extensionForMime(type)}`;
  return { buffer, filename, type };
}

const extensionTypes: Record<string, string> = {
  avif: "image/avif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jxl: "image/jxl",
  png: "image/png",
  webp: "image/webp"
};

async function indexOutputFiles(): Promise<void> {
  if (!existsSync(outputsDir)) return;
  // Uses the file extension instead of reading every output into memory on startup.
  for (const file of await readdir(outputsDir)) {
    // Output files are "<12-char nanoid>-<filename>"; nanoid ids can themselves contain "-".
    if (file.length < 14 || file[12] !== "-") continue;
    const outputId = file.slice(0, 12);
    const extension = file.split(".").pop()?.toLowerCase() || "";
    resultByOutputId.set(outputId, {
      path: path.join(outputsDir, file),
      filename: file.slice(13),
      type: extensionTypes[extension] || "application/octet-stream"
    });
  }
}

async function sweep(): Promise<void> {
  const removed = new Set(await sweepStore(retentionMs));
  if (!removed.size) return;
  for (const [id, item] of resultByOutputId) {
    if (removed.has(item.path)) resultByOutputId.delete(id);
  }
  for (const [id, item] of sourceByJobId) {
    if (removed.has(item.path)) sourceByJobId.delete(id);
  }
}

function registerJobOutputs(job: Awaited<ReturnType<typeof processUpload>>, sourceName?: string) {
  const sourcePath = originalPath(job.id);
  sourceByJobId.set(job.id, {
    path: sourcePath,
    filename: sourceName || job.originalFilename,
    type: job.input.type
  });

  for (const variant of job.variants) {
    resultByOutputId.set(variant.id, {
      path: path.join(outputsDir, `${variant.id}-${variant.filename}`),
      filename: variant.filename,
      type: variant.type,
      sourcePath,
      sourceName
    });
  }
}

async function readSource(item: { path: string } | undefined): Promise<Buffer | undefined> {
  if (!item) return undefined;
  try {
    return await readFile(item.path);
  } catch {
    return undefined;
  }
}

let sweepTimer: NodeJS.Timeout | undefined;

export async function createApp() {
  await ensureStore();
  await sweep();
  await indexOutputFiles();
  if (!sweepTimer) {
    sweepTimer = setInterval(() => void sweep().catch(() => undefined), sweepIntervalMs);
    sweepTimer.unref();
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));
  app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: maxUploadBytes }));

  app.get("/api/health", async (_request, response) => {
    response.json({
      ok: true,
      localOnly: !isHostedDeployment,
      limits: {
        maxUploadMb: Math.round(maxUploadBytes / 1024 / 1024),
        maxMegapixels: Number.isFinite(maxInputPixels) ? Math.round(maxInputPixels / 1e6) : null,
        avifMaxMegapixels: Number.isFinite(maxAvifPixels) ? Math.round(maxAvifPixels / 1e6) : null,
        retentionHours: Number((retentionMs / 3600000).toFixed(2)),
        concurrency: processConcurrency
      },
      codecs: ["auto", "png", "jpeg", "webp", "avif", "jxl", "heic-input-if-supported"],
      bundledEngines: [
        {
          name: "jxl-wasm",
          available: true,
          description: "JPEG XL encoder from @jsquash/jxl"
        }
      ],
      specialistTools: await specialistToolStatus()
    });
  });

  app.post("/api/jobs", upload.array("images"), async (request, response) => {
    const files = (request.files || []) as Express.Multer.File[];
    const options = parseOptions(request.body.options);
    const jobs = [];

    try {
      // One image at a time: each file is read from disk, processed, and its buffer released.
      for (const file of files) {
        const job = await withProcessingSlot(async () => {
          const buffer = await readFile(file.path);
          return processUpload(buffer, file.originalname, options, file.path);
        });
        registerJobOutputs(job, file.originalname);
        jobs.push(job);
      }
    } finally {
      await Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
    }

    response.json({
      jobs,
      zipUrl: jobs.some((job) => job.variants.length) ? zipUrlFor(jobs.flatMap((job) => job.variants.map((variant) => variant.id))) : undefined
    });
  });

  app.post("/api/jobs/:id/reprocess", async (request, response) => {
    const source = sourceByJobId.get(request.params.id);
    const buffer = await readSource(source);
    if (!source || !buffer) {
      response.status(404).json({ error: "The original file has expired. Add the image again to re-optimize it." });
      return;
    }

    const options = parseOptions(request.body?.options || request.body);
    const job = await withProcessingSlot(() => processUpload(buffer, source.filename, options));
    registerJobOutputs(job, source.filename);
    response.json(job);
  });

  app.get("/api/download.zip", async (request, response) => {
    // Only the outputs the caller asks for. Previously this zipped every file ever processed,
    // which on a public host meant anyone could download everyone else's images.
    const ids = String(request.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const items = ids.map((id) => resultByOutputId.get(id)).filter((item): item is StoredOutput => Boolean(item && existsSync(item.path)));
    if (!items.length) {
      response.status(404).json({ error: "No downloadable outputs were found. They may have expired." });
      return;
    }

    response.attachment("optimized-images.zip");
    // Images are already compressed; "store" avoids burning CPU on zlib level 9 for ~0% gain.
    const archive = archiver("zip", { store: true });
    archive.on("error", (error) => response.destroy(error));
    archive.pipe(response);
    const usedNames = new Set<string>();
    for (const item of items) {
      let name = item.filename;
      for (let index = 2; usedNames.has(name.toLowerCase()); index += 1) {
        name = item.filename.replace(/(\.[^.]+)?$/, `-${index}$1`);
      }
      usedNames.add(name.toLowerCase());
      archive.file(item.path, { name });
    }
    await archive.finalize();
  });

  app.post("/shrink", async (request, response) => {
    try {
      let source: { buffer: Buffer; filename: string; type: string };
      if (request.is("application/json")) {
        const url = request.body?.source?.url;
        if (!url || typeof url !== "string") {
          response.status(400).json({ error: "JSON shrink requests require source.url." });
          return;
        }
        if (!allowUrlImport) {
          response.status(403).json({ error: "URL import is disabled on this server. Upload the image data instead." });
          return;
        }
        source = await fetchSource(url);
      } else {
        const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        if (!buffer.byteLength) {
          response.status(400).json({ error: "No image data was provided." });
          return;
        }
        const type = await detectMime(buffer, "upload");
        source = { buffer, filename: `upload.${extensionForMime(type)}`, type };
      }

      const job = await withProcessingSlot(() => processUpload(source.buffer, source.filename, { preset: "balanced", formats: ["original"] }));
      registerJobOutputs(job, source.filename);
      const variant = job.variants[0];
      response
        .status(201)
        .setHeader("Location", variant?.downloadUrl || "")
        .setHeader("Compression-Count", "1")
        .json({
          input: job.input,
          output: variant
            ? {
                size: variant.size,
                type: variant.type,
                width: variant.width,
                height: variant.height,
                url: variant.downloadUrl
              }
            : undefined,
          error: job.error
        });
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : "Could not shrink image." });
    }
  });

  app.post("/output/:id", async (request, response) => {
    const previous = resultByOutputId.get(request.params.id);
    const source = await readSource(previous?.sourcePath ? { path: previous.sourcePath } : undefined);
    if (!previous || !source) {
      response.status(404).json({ error: "Output source is not available for transformation." });
      return;
    }

    const body = request.body || {};
    const convert = body.convert;
    const formats = (Array.isArray(convert)
      ? convert.map((mime: string) => mime.split("/")[1] || "original")
      : typeof convert === "string"
        ? [convert.split("/")[1] || "original"]
        : ["original"]) as OutputFormat[];

    const sourceName = previous.sourceName || previous.filename;
    const job = await withProcessingSlot(() =>
      processUpload(source, sourceName, {
        preset: "balanced",
        formats,
        resize: body.resize,
        preserve: body.preserve,
        transform: body.transform,
        enhance: body.enhance
      })
    );
    registerJobOutputs(job, sourceName);
    const variant = [...job.variants].sort((a, b) => a.size - b.size)[0];
    if (!variant) {
      response.status(422).json({ error: job.error || "Could not transform image." });
      return;
    }

    const file = resultByOutputId.get(variant.id);
    response
      .setHeader("Compression-Count", "1")
      .setHeader("Image-Width", String(variant.width || ""))
      .setHeader("Image-Height", String(variant.height || ""))
      .type(variant.type);
    createReadStream(file!.path).pipe(response);
  });

  async function sendStoredFile(response: Response, item: { path: string; filename: string; type: string } | undefined, kind: "inline" | "attachment") {
    if (!item) {
      response.status(404).json({ error: "File was not found. It may have expired." });
      return;
    }
    let size: number;
    try {
      size = (await stat(item.path)).size;
    } catch {
      response.status(404).json({ error: "File was not found. It may have expired." });
      return;
    }
    // Only raster image types are ever shown inline; anything else (e.g. an uploaded XHTML/SVG file)
    // is forced to download so it can't run script on this origin.
    const safeInline = /^image\/(png|jpeg|webp|avif|gif|jxl|heic|heif|bmp|tiff)$/i.test(item.type);
    response
      .setHeader("Content-Length", String(size))
      .setHeader("Content-Disposition", dispositionHeader(kind === "inline" && safeInline ? "inline" : "attachment", item.filename))
      .setHeader("Cache-Control", "private, max-age=3600")
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .type(safeInline || kind === "attachment" ? item.type : "application/octet-stream");
    createReadStream(item.path).pipe(response);
  }

  app.get("/output/:id", (request, response) => sendStoredFile(response, resultByOutputId.get(request.params.id), "attachment"));
  app.get("/preview/:id", (request, response) => sendStoredFile(response, resultByOutputId.get(request.params.id), "inline"));
  app.get("/input/:id", (request, response) => sendStoredFile(response, sourceByJobId.get(request.params.id), "inline"));

  const clientDist = path.resolve(process.cwd(), "dist", "client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: "index.html" }));
    app.use((_request, response) => {
      response.sendFile(path.join(clientDist, "index.html"));
    });
  }

  // Friendly JSON errors (e.g. oversized uploads) instead of Express' default HTML page.
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? `This image is larger than the ${Math.round(maxUploadBytes / 1024 / 1024)} MB limit for this server.`
          : error.message;
      response.status(status).json({ error: message });
      return;
    }
    const message = error instanceof Error ? error.message : "Something went wrong.";
    response.status(500).json({ error: message });
  });

  return app;
}

export function zipUrlFor(variantIds: string[]): string {
  return `/api/download.zip?ids=${variantIds.map(encodeURIComponent).join(",")}`;
}
