import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectMime, sanitizeFilename } from "../src/server/format.js";
import { processUpload } from "../src/server/processor.js";

async function samplePng() {
  return sharp({
    create: {
      width: 96,
      height: 64,
      channels: 4,
      background: { r: 37, g: 122, b: 94, alpha: 0.8 }
    }
  })
    .png()
    .toBuffer();
}

async function complexTransparentPng() {
  const raw = Buffer.alloc(160 * 120 * 4);
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < 160; x += 1) {
      const offset = (y * 160 + x) * 4;
      raw[offset] = (x * 5 + y * 3) % 255;
      raw[offset + 1] = (x * 2 + y * 7) % 255;
      raw[offset + 2] = (x * 11 + y) % 255;
      raw[offset + 3] = x < 40 ? 0 : 255;
    }
  }

  return sharp(raw, { raw: { width: 160, height: 120, channels: 4 } }).png().toBuffer();
}

describe("format helpers", () => {
  it("detects image mime types from binary data", async () => {
    const buffer = await samplePng();
    await expect(detectMime(buffer, "sample.png")).resolves.toBe("image/png");
  });

  it("sanitizes output filenames", () => {
    expect(sanitizeFilename("My large image @ 2x.png")).toBe("My-large-image-2x");
  });
});

describe("processor", () => {
  it("optimizes an uploaded image and returns TinyPNG-style metrics", async () => {
    const buffer = await samplePng();
    const job = await processUpload(buffer, "fixture.png", { preset: "balanced", formats: ["original", "webp"] });

    expect(job.status).toBe("done");
    expect(job.input.type).toBe("image/png");
    expect(job.variants.length).toBe(2);
    expect(job.variants[0].downloadUrl).toMatch(/^\/output\//);
    expect(job.variants.every((variant) => variant.metrics?.sizeRatio)).toBe(true);
    expect(job.variants.every((variant) => variant.metrics?.ssim)).toBe(true);
    expect(job.variants.every((variant) => variant.metrics?.candidateCount)).toBe(true);
  });

  it("uses the ultra candidate race for best-in-class mode", async () => {
    const buffer = await samplePng();
    const job = await processUpload(buffer, "fixture.png", { preset: "ultra", formats: ["webp"] });

    expect(job.status).toBe("done");
    expect(job.variants[0].metrics?.candidateCount).toBeGreaterThan(4);
    expect(job.variants[0].metrics?.targetSsim).toBeGreaterThan(0.98);
    expect(job.variants[0].metrics?.selectedQuality).toBeTruthy();
  });

  it("auto-selects the best safe output format", async () => {
    const buffer = await sharp({
      create: {
        width: 120,
        height: 90,
        channels: 3,
        background: { r: 87, g: 140, b: 210 }
      }
    })
      .jpeg()
      .toBuffer();
    const job = await processUpload(buffer, "photo.jpg", { preset: "balanced", formats: ["auto"] });

    expect(job.status).toBe("done");
    expect(job.variants).toHaveLength(1);
    expect(job.variants[0].metrics?.autoSelected).toBe(true);
    expect(job.variants[0].metrics?.autoCandidateFormats?.length).toBeGreaterThan(1);
    expect(["image/avif", "image/webp", "image/jpeg", "image/png"]).toContain(job.variants[0].type);
  });

  it("does not auto-select JPEG for transparent images", async () => {
    const buffer = await complexTransparentPng();
    const job = await processUpload(buffer, "transparent.png", { preset: "balanced", formats: ["auto"] });

    expect(job.status).toBe("done");
    expect(job.variants[0].metrics?.autoSelected).toBe(true);
    expect(job.variants[0].metrics?.autoCandidateFormats).toEqual(["webp", "avif", "png"]);
    expect(job.variants[0].type).not.toBe("image/jpeg");
  });

  it("rejects color-shifted palette PNG candidates for complex transparent images", async () => {
    const buffer = await complexTransparentPng();
    const job = await processUpload(buffer, "transparent-photo.png", { preset: "ultra", formats: ["png"] });

    expect(job.status).toBe("done");
    expect(job.variants[0].type).toBe("image/png");
    expect(job.variants[0].metrics?.colorDelta).toBeLessThanOrEqual(0.014);
    expect(job.variants[0].metrics?.ssim).toBeGreaterThanOrEqual(0.99);
  });

  it("applies resize quality, denoise, and sharpening options", async () => {
    const buffer = await complexTransparentPng();
    const job = await processUpload(buffer, "enhanced.png", {
      preset: "balanced",
      formats: ["webp"],
      resize: {
        method: "fit",
        width: 80,
        height: 60,
        kernel: "mitchell"
      },
      enhance: {
        denoise: 2,
        sharpen: 4,
        brightness: 5,
        contrast: 10
      }
    });

    expect(job.status).toBe("done");
    expect(job.variants[0].width).toBe(80);
    expect(job.variants[0].height).toBe(60);
    expect(job.variants[0].type).toBe("image/webp");
    expect(job.variants[0].metrics?.contrastRatio).toBeGreaterThan(0.9);
    expect(job.variants[0].metrics?.saturationRatio).toBeGreaterThan(0.9);
  });

  it("honors EXIF orientation before resizing camera JPEGs", async () => {
    const buffer = await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 3,
        background: { r: 210, g: 80, b: 40 }
      }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const job = await processUpload(buffer, "portrait-camera.jpg", {
      preset: "fidelity",
      formats: ["jpeg"],
      resize: {
        method: "fit",
        width: 80,
        height: 120
      }
    });

    expect(job.status).toBe("done");
    expect(job.input.width).toBe(80);
    expect(job.input.height).toBe(120);
    expect(job.variants[0].width).toBe(80);
    expect(job.variants[0].height).toBe(120);
  });

  it("preserves ICC color profiles without preserving private metadata", async () => {
    const buffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 120, g: 70, b: 190 }
      }
    })
      .jpeg()
      .withIccProfile("p3")
      .toBuffer();
    const job = await processUpload(buffer, "profiled.jpg", { preset: "fidelity", formats: ["jpeg"] });
    const variant = job.variants[0];
    const output = await readFile(path.resolve(process.cwd(), ".local-tinypng", "outputs", `${variant.id}-${variant.filename}`));
    const metadata = await sharp(output).metadata();

    expect(job.status).toBe("done");
    expect(metadata.hasProfile).toBe(true);
    expect(metadata.exif).toBeUndefined();
  });

  it("falls back to full-color PNG when enhanced palette candidates fail quality gates", async () => {
    const buffer = await complexTransparentPng();
    const job = await processUpload(buffer, "enhanced-transparent.png", {
      preset: "balanced",
      formats: ["png"],
      enhance: {
        denoise: 6,
        sharpen: 0
      }
    });

    expect(job.status).toBe("done");
    expect(job.variants[0].metrics?.losslessFallback).toBe(true);
    expect(job.variants[0].metrics?.selectedQuality).toBe(0);
  });

  it("encodes JPEG XL output through the local WASM encoder", async () => {
    const buffer = await samplePng();
    const job = await processUpload(buffer, "fixture.png", { preset: "balanced", formats: ["jxl"] });

    expect(job.status).toBe("done");
    expect(job.variants[0].type).toBe("image/jxl");
    expect(job.variants[0].filename).toContain(".jxl");
  });
});
