import archiver from "archiver";
import express from "express";
import multer from "multer";
import path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { ProcessOptions } from "../shared/types.js";
import type { OutputFormat } from "../shared/types.js";
import { processUpload } from "./processor.js";
import { detectMime, extensionForMime } from "./format.js";
import { specialistToolStatus } from "./external-tools.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 500
  }
});

const outputsRoot = path.resolve(process.cwd(), ".local-tinypng", "outputs");
const resultByOutputId = new Map<string, { path: string; filename: string; type: string; source?: Buffer; sourceName?: string }>();
const sourceByJobId = new Map<string, { buffer: Buffer; filename: string; type: string }>();

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

async function fetchSource(url: string): Promise<{ buffer: Buffer; filename: string; type: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch source URL: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const type = response.headers.get("content-type")?.split(";")[0] || (await detectMime(buffer, url));
  const parsed = new URL(url);
  const filename = path.basename(parsed.pathname) || `remote.${extensionForMime(type)}`;
  return { buffer, filename, type };
}

async function indexOutputFiles(): Promise<void> {
  if (!existsSync(outputsRoot)) return;
  const files = await readdir(outputsRoot);
  for (const file of files) {
    const outputId = file.split("-")[0];
    const filePath = path.join(outputsRoot, file);
    const buffer = await readFile(filePath);
    const type = await detectMime(buffer, file);
    resultByOutputId.set(outputId, { path: filePath, filename: file.replace(`${outputId}-`, ""), type });
  }
}

async function registerJobOutputs(job: Awaited<ReturnType<typeof processUpload>>, source?: Buffer, sourceName?: string) {
  if (source) {
    sourceByJobId.set(job.id, {
      buffer: source,
      filename: sourceName || job.originalFilename,
      type: job.input.type
    });
  }

  for (const variant of job.variants) {
    const filePath = path.join(outputsRoot, `${variant.id}-${variant.filename}`);
    resultByOutputId.set(variant.id, {
      path: filePath,
      filename: variant.filename,
      type: variant.type,
      source,
      sourceName
    });
  }
}

export async function createApp() {
  await indexOutputFiles();
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "1024mb" }));

  app.get("/api/health", async (_request, response) => {
    response.json({
      ok: true,
      localOnly: true,
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

    for (const file of files) {
      const job = await processUpload(file.buffer, file.originalname, options);
      await registerJobOutputs(job, file.buffer, file.originalname);
      jobs.push(job);
    }

    response.json({
      jobs,
      zipUrl: jobs.some((job) => job.variants.length) ? "/api/download.zip" : undefined
    });
  });

  app.post("/api/jobs/:id/reprocess", async (request, response) => {
    const source = sourceByJobId.get(request.params.id);
    if (!source) {
      response.status(404).json({ error: "Original source is no longer available for this job." });
      return;
    }

    const options = parseOptions(request.body?.options || request.body);
    const job = await processUpload(source.buffer, source.filename, options);
    await registerJobOutputs(job, source.buffer, source.filename);
    response.json(job);
  });

  app.get("/api/download.zip", async (_request, response) => {
    response.attachment("optimized-images.zip");
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (error) => response.status(500).json({ error: error.message }));
    archive.pipe(response);
    for (const item of resultByOutputId.values()) {
      archive.file(item.path, { name: item.filename });
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

      const job = await processUpload(source.buffer, source.filename, { preset: "balanced", formats: ["original"] });
      await registerJobOutputs(job, source.buffer, source.filename);
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
    if (!previous?.source) {
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

    const job = await processUpload(previous.source, previous.sourceName || previous.filename, {
      preset: "balanced",
      formats,
      resize: body.resize,
      preserve: body.preserve,
      transform: body.transform,
      enhance: body.enhance
    });
    await registerJobOutputs(job, previous.source, previous.sourceName);
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

  app.get("/output/:id", async (request, response) => {
    const item = resultByOutputId.get(request.params.id);
    if (!item) {
      response.status(404).json({ error: "Output was not found." });
      return;
    }
    const info = await stat(item.path);
    response
      .setHeader("Content-Length", String(info.size))
      .setHeader("Content-Disposition", `attachment; filename="${item.filename}"`)
      .type(item.type);
    createReadStream(item.path).pipe(response);
  });

  app.get("/preview/:id", (request, response) => {
    const item = resultByOutputId.get(request.params.id);
    if (!item) {
      response.status(404).json({ error: "Preview was not found." });
      return;
    }
    response
      .setHeader("Content-Disposition", `inline; filename="${item.filename}"`)
      .type(item.type);
    createReadStream(item.path).pipe(response);
  });

  app.get("/input/:id", (request, response) => {
    const item = sourceByJobId.get(request.params.id);
    if (!item) {
      response.status(404).json({ error: "Original preview was not found." });
      return;
    }
    response
      .setHeader("Content-Disposition", `inline; filename="${item.filename}"`)
      .type(item.type)
      .send(item.buffer);
  });

  const clientDist = path.resolve(process.cwd(), "dist", "client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((_request, response) => {
      response.sendFile(path.join(clientDist, "index.html"));
    });
  }

  return app;
}
