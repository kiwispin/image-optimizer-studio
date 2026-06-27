import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { processUpload } from "../src/server/processor.js";
import type { OutputFormat, Preset } from "../src/shared/types.js";

interface BenchmarkCase {
  name: string;
  filename: string;
  buffer: Buffer;
  formats: OutputFormat[];
}

function deterministicNoise(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(width * height * 3);
  for (let index = 0; index < buffer.length; index += 3) {
    const value = (index * 37 + Math.floor(index / 11) * 17) % 255;
    buffer[index] = value;
    buffer[index + 1] = (value * 3) % 255;
    buffer[index + 2] = (value * 7) % 255;
  }
  return buffer;
}

async function makeCorpus(): Promise<BenchmarkCase[]> {
  const photo = await sharp(deterministicNoise(640, 420), { raw: { width: 640, height: 420, channels: 3 } })
    .blur(1.2)
    .jpeg({ quality: 92 })
    .toBuffer();

  const flatGraphic = await sharp({
    create: {
      width: 480,
      height: 320,
      channels: 4,
      background: { r: 42, g: 122, b: 94, alpha: 1 }
    }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="480" height="320" xmlns="http://www.w3.org/2000/svg"><rect x="56" y="58" width="370" height="74" rx="6" fill="#fff"/><circle cx="155" cy="214" r="62" fill="#d94f45"/><rect x="236" y="174" width="152" height="82" rx="4" fill="#2b5b82"/></svg>`
        )
      }
    ])
    .png()
    .toBuffer();

  const transparent = await sharp({
    create: {
      width: 360,
      height: 360,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="360" height="360" xmlns="http://www.w3.org/2000/svg"><path d="M180 24 332 288H28Z" fill="#217a5e" fill-opacity=".84"/><circle cx="180" cy="188" r="78" fill="#fff" fill-opacity=".62"/></svg>`
        )
      }
    ])
    .png()
    .toBuffer();

  const screenshot = await sharp({
    create: {
      width: 900,
      height: 520,
      channels: 3,
      background: "#f6f7f4"
    }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="900" height="520" xmlns="http://www.w3.org/2000/svg"><rect x="40" y="40" width="820" height="440" rx="8" fill="#fff" stroke="#d5ddd8"/><rect x="72" y="78" width="220" height="22" fill="#217a5e"/><rect x="72" y="130" width="756" height="1" fill="#d5ddd8"/><g fill="#e8eeeb">${Array.from({ length: 9 }, (_, i) => `<rect x="72" y="${166 + i * 32}" width="${520 + (i % 3) * 80}" height="14" rx="3"/>`).join("")}</g></svg>`
        )
      }
    ])
    .png()
    .toBuffer();

  return [
    { name: "photo", filename: "photo.jpg", buffer: photo, formats: ["auto", "original", "webp", "avif"] },
    { name: "flat-graphic", filename: "flat-graphic.png", buffer: flatGraphic, formats: ["auto", "original", "webp"] },
    { name: "transparent", filename: "transparent.png", buffer: transparent, formats: ["auto", "original", "webp"] },
    { name: "screenshot", filename: "screenshot.png", buffer: screenshot, formats: ["auto", "original", "webp", "avif"] }
  ];
}

async function run() {
  const preset = (process.argv[2] as Preset | undefined) || "balanced";
  const corpus = await makeCorpus();
  const report = [];

  for (const item of corpus) {
    const job = await processUpload(item.buffer, item.filename, { preset, formats: item.formats });
    report.push({
      name: item.name,
      input: job.input,
      status: job.status,
      error: job.error,
      variants: job.variants.map((variant) => ({
        format: variant.format,
        size: variant.size,
        savings: Number((variant.savings * 100).toFixed(2)),
        psnr: variant.metrics?.psnr,
        ssim: variant.metrics?.ssim,
        colorDelta: variant.metrics?.colorDelta,
        sizeRatio: variant.metrics?.sizeRatio,
        autoSelected: variant.metrics?.autoSelected,
        autoCandidateFormats: variant.metrics?.autoCandidateFormats,
        externalOptimizer: variant.metrics?.externalOptimizer
      }))
    });
  }

  const baselinePath = path.resolve("benchmarks", "tinypng-baseline.json");
  const baseline = existsSync(baselinePath) ? JSON.parse(await readFile(baselinePath, "utf8")) : undefined;
  const output = {
    generatedAt: new Date().toISOString(),
    preset,
    baselineCompared: Boolean(baseline),
    baseline,
    report
  };

  await mkdir(path.resolve(".local-tinypng"), { recursive: true });
  const target = path.resolve(".local-tinypng", "benchmark-report.json");
  await writeFile(target, JSON.stringify(output, null, 2));
  console.log(`Benchmark complete: ${target}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
