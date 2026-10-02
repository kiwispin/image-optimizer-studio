import sharp from "sharp";
import { nanoid } from "nanoid";
import type { JobResult, OutputFormat, OutputVariant, ProcessOptions, ResizeKernel } from "../shared/types.js";
import { detectMime, extensionForMime, mimeForOutput, normalizeSharpFormat, sanitizeFilename } from "./format.js";
import { saveOutput, storeOriginal, type StoredImage } from "./store.js";
import { optimizePngWithOxipng } from "./external-tools.js";
import { encodeJpegXl } from "./jxl.js";
import { maxAvifPixels, maxInputPixels } from "./config.js";

const pixelLimit: number | false = Number.isFinite(maxInputPixels) ? maxInputPixels : false;

// Keep libvips' operation cache small so memory is released between jobs (matters on small hosts).
sharp.cache({ memory: 48, files: 0, items: 64 });

// Images larger than this are quality-searched on a downscaled proxy, then encoded at full size once.
const PROXY_MIN_PIXELS = 1_000_000;
const PROXY_MAX_EDGE = 1024;
// Below this size AVIF's slow high-effort modes are cheap enough to keep.
const SMALL_IMAGE_PIXELS = 300_000;

/** "search" = proxy quality search, "small" = tiny image, "large" = full-size encode of a big image. */
type EncodeTier = "search" | "small" | "large";

function avifEffort(options: ProcessOptions, tier: EncodeTier): number {
  if (tier === "search") return 3;
  if (tier === "small") return options.preset === "ultra" ? 9 : 7;
  // Effort 7+ is 4-5x slower than 5 on big photos for ~1-2% smaller files.
  return options.preset === "ultra" ? 6 : 5;
}

const presetSettings = {
  balanced: { targetSsim: 0.982, jpeg: [84, 80, 76, 72], webp: [84, 80, 76, 72], avif: [58, 52, 46, 40], pngColors: [224, 192, 160, 128] },
  smallest: { targetSsim: 0.962, jpeg: [76, 70, 64, 58], webp: [76, 68, 60, 52], avif: [48, 42, 36, 30], pngColors: [192, 128, 96, 64] },
  fidelity: { targetSsim: 0.992, jpeg: [94, 90, 86, 82], webp: [94, 90, 86, 82], avif: [72, 66, 60, 54], pngColors: [256, 224, 192, 160] },
  ultra: { targetSsim: 0.986, jpeg: [94, 90, 86, 82, 78, 74, 70, 66], webp: [94, 90, 86, 82, 78, 74, 70, 64, 58], avif: [74, 68, 62, 56, 50, 44, 38, 32], pngColors: [256, 224, 192, 160, 128, 96, 64, 48] }
} as const;

export const defaultOptions: ProcessOptions = {
  preset: "balanced",
  formats: ["original"],
  preserve: []
};

export function mergeOptions(input?: Partial<ProcessOptions>): ProcessOptions {
  return {
    ...defaultOptions,
    ...input,
    formats: input?.formats?.length ? input.formats : defaultOptions.formats,
    preserve: input?.preserve || []
  };
}

type EncodableFormat = Exclude<OutputFormat, "auto" | "original">;
type ContentClass = "photo" | "graphic" | "screenshot" | "transparent-graphic" | "transparent-photo" | "animation";

interface Candidate {
  buffer: Buffer;
  quality: number;
  metrics: {
    psnr?: number;
    ssim?: number;
    colorDelta?: number;
    contrastRatio?: number;
    saturationRatio?: number;
  };
  externalOptimizer?: string;
  losslessFallback?: boolean;
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

interface ImageToneStats {
  contrast: number;
  saturation: number;
}

interface ReferenceImage {
  metric: RawImage;
  psnr: RawImage;
  tone: ImageToneStats;
}

interface OptimizedResult {
  buffer: Buffer;
  proxied: boolean;
  candidateCount: number;
  selectedQuality: number;
  psnr?: number;
  ssim?: number;
  colorDelta?: number;
  contrastRatio?: number;
  saturationRatio?: number;
  targetSsim: number;
  passedQualityGate: boolean;
  externalOptimizer?: string;
  losslessFallback?: boolean;
}

function resizeKernel(kernel?: ResizeKernel): keyof sharp.KernelEnum {
  if (kernel === "nearest") return "nearest";
  if (kernel === "linear") return "linear";
  if (kernel === "cubic") return "cubic";
  if (kernel === "mitchell") return "mitchell";
  if (kernel === "lanczos2") return "lanczos2";
  return "lanczos3";
}

function inputImage(buffer: Buffer, animated = false): sharp.Sharp {
  return sharp(buffer, { animated, failOn: "none", limitInputPixels: pixelLimit }).rotate();
}

/** Approximate pixel count of the output after the user's resize settings. */
function estimateOutputPixels(metadata: sharp.Metadata, options: ProcessOptions): number {
  const width = metadata.width || 0;
  const height = metadata.pageHeight || metadata.height || 0;
  const resize = options.resize;
  if (!resize || (!resize.width && !resize.height) || !width || !height) return width * height;
  if ((resize.method === "cover" || resize.method === "thumb") && resize.width && resize.height) {
    return Math.min(width * height, resize.width * resize.height);
  }
  const scale = Math.min(1, resize.width ? resize.width / width : Infinity, resize.height ? resize.height / height : Infinity);
  return Math.round(width * scale) * Math.round(height * scale);
}

function displayDimensions(metadata: sharp.Metadata) {
  const swapsDimensions = metadata.orientation ? [5, 6, 7, 8].includes(metadata.orientation) : false;
  return {
    width: swapsDimensions ? metadata.height : metadata.width,
    height: swapsDimensions ? metadata.width : metadata.height
  };
}

function applyResize(image: sharp.Sharp, options: ProcessOptions): sharp.Sharp {
  const resize = options.resize;
  if (!resize || (!resize.width && !resize.height)) return image;

  const common = {
    width: resize.width,
    height: resize.height,
    kernel: resizeKernel(resize.kernel),
    withoutEnlargement: true
  };

  if (resize.method === "scale" || resize.method === "fit") {
    return image.resize({ ...common, fit: "inside" });
  }

  if (resize.method === "thumb") {
    return image.resize({ ...common, fit: "cover", position: sharp.strategy.attention });
  }

  return image.resize({ ...common, fit: "cover", position: sharp.strategy.entropy });
}

function applyEnhancements(image: sharp.Sharp, options: ProcessOptions): sharp.Sharp {
  const denoise = Math.max(0, Math.min(10, options.enhance?.denoise || 0));
  const manualSharpen = Math.max(0, Math.min(10, options.enhance?.sharpen || 0));
  const brightness = Math.max(-50, Math.min(50, options.enhance?.brightness || 0));
  const contrast = Math.max(-50, Math.min(50, options.enhance?.contrast || 0));
  const resizeSharpen = options.resize?.kernel === "lanczos3" ? 2 : 0;
  const sharpen = Math.max(manualSharpen, resizeSharpen);
  let enhanced = image;

  if (denoise > 0) {
    enhanced = enhanced.median(Math.max(1, Math.round(denoise / 3)));
  }

  if (brightness !== 0) {
    enhanced = enhanced.modulate({ brightness: 1 + brightness / 100 });
  }

  if (contrast !== 0) {
    const factor = 1 + contrast / 100;
    enhanced = enhanced.linear(factor, 128 * (1 - factor));
  }

  if (sharpen > 0) {
    enhanced = enhanced.sharpen({
      sigma: 0.6 + sharpen * 0.12,
      m1: 0.35 + sharpen * 0.08,
      m2: 1.2 + sharpen * 0.18
    });
  }

  return enhanced;
}

function targetSsimFor(options: ProcessOptions, contentClass: ContentClass): number {
  const base = presetSettings[options.preset].targetSsim;
  if (contentClass === "graphic" || contentClass === "screenshot" || contentClass === "transparent-graphic") {
    return Math.min(0.997, base + 0.006);
  }
  if (contentClass === "transparent-photo") {
    return Math.min(0.996, base + 0.008);
  }
  if (contentClass === "animation") {
    return Math.min(0.99, base + 0.002);
  }
  return base;
}

function candidateQualities(format: EncodableFormat, options: ProcessOptions, contentClass: ContentClass): number[] {
  const settings = presetSettings[options.preset];
  if (format === "png") {
    const colors: number[] = [...settings.pngColors];
    if ((contentClass === "graphic" || contentClass === "screenshot") && !colors.includes(32)) {
      colors.push(32);
    }
    if (contentClass === "transparent-photo" && !colors.includes(512)) {
      colors.unshift(512);
    }
    colors.push(0);
    return colors;
  }
  if (format === "jxl") {
    return options.preset === "ultra" ? [90, 84, 78, 72, 66, 60] : [84, 78, 72, 66];
  }
  return [...settings[format]];
}

function encode(
  image: sharp.Sharp,
  format: EncodableFormat,
  options: ProcessOptions,
  quality: number,
  contentClass: ContentClass,
  tier: EncodeTier = "small"
): sharp.Sharp {
  const keepMetadata = Boolean(options.preserve?.length);
  const colorManaged = image.keepIccProfile();
  const prepared = keepMetadata ? colorManaged.keepMetadata().withMetadata({ orientation: 1 }) : colorManaged;

  if (format === "jpeg") {
    return prepared
      .flatten({ background: options.transform?.background || "#ffffff" })
      .jpeg({
        chromaSubsampling: contentClass === "graphic" || contentClass === "screenshot" ? "4:4:4" : "4:2:0",
        mozjpeg: true,
        optimiseCoding: true,
        progressive: true,
        quality,
        trellisQuantisation: true
      });
  }

  if (format === "webp") {
    return prepared.webp({
      effort: options.preset === "ultra" ? 6 : 5,
      nearLossless: contentClass === "graphic" || contentClass === "screenshot",
      quality,
      smartSubsample: true
    });
  }

  if (format === "avif") {
    return prepared.avif({
      chromaSubsampling: contentClass === "graphic" || contentClass === "screenshot" ? "4:4:4" : "4:2:0",
      effort: avifEffort(options, tier),
      quality
    });
  }

  if (format === "png") {
    if (quality === 0) {
      return prepared.png({
        compressionLevel: 9,
        effort: 10,
        palette: false
      });
    }

    return prepared.png({
      compressionLevel: 9,
      effort: 10,
      palette: true,
      quality: Math.min(100, Math.max(60, quality)),
      colors: Math.min(256, quality),
      dither: contentClass === "photo" || contentClass === "transparent-photo" ? 1 : 0.65
    });
  }

  if (format === "jxl") {
    return prepared;
  }

  throw new Error(`Unsupported output format: ${format}`);
}

async function rawForMetric(buffer: Buffer, width?: number, height?: number): Promise<RawImage> {
  const image = inputImage(buffer).removeAlpha();
  if (width && height) {
    image.resize(width, height, { fit: "fill" });
  } else {
    image.resize(160, 160, { fit: "inside", withoutEnlargement: true });
  }
  const raw = await image.raw().toBuffer({ resolveWithObject: true });
  return {
    data: raw.data,
    width: raw.info.width,
    height: raw.info.height,
    channels: raw.info.channels
  };
}

function psnrFromRaw(a: RawImage, b: RawImage): number {
  let mse = 0;
  for (let index = 0; index < a.data.length; index += 1) {
    const diff = a.data[index] - b.data[index];
    mse += diff * diff;
  }
  mse /= a.data.length;
  if (mse === 0) return 99;
  return Number((20 * Math.log10(255 / Math.sqrt(mse))).toFixed(2));
}

function luminance(raw: RawImage, pixel: number): number {
  const offset = pixel * raw.channels;
  return raw.data[offset] * 0.2126 + raw.data[offset + 1] * 0.7152 + raw.data[offset + 2] * 0.0722;
}

function ssimFromRaw(a: RawImage, b: RawImage): number {
  const pixels = Math.min(a.width * a.height, b.width * b.height);
  if (!pixels) return 0;

  let meanA = 0;
  let meanB = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    meanA += luminance(a, pixel);
    meanB += luminance(b, pixel);
  }
  meanA /= pixels;
  meanB /= pixels;

  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const deltaA = luminance(a, pixel) - meanA;
    const deltaB = luminance(b, pixel) - meanB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
    covariance += deltaA * deltaB;
  }
  const denominator = Math.max(1, pixels - 1);
  varianceA /= denominator;
  varianceB /= denominator;
  covariance /= denominator;

  const c1 = 6.5025;
  const c2 = 58.5225;
  const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
  const divisor = (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2);
  return Number(Math.max(0, Math.min(1, numerator / divisor)).toFixed(5));
}

function colorDeltaFromRaw(a: RawImage, b: RawImage): number {
  const pixels = Math.min(a.width * a.height, b.width * b.height);
  if (!pixels) return 1;

  let delta = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const aOffset = pixel * a.channels;
    const bOffset = pixel * b.channels;
    delta += Math.abs(a.data[aOffset] - b.data[bOffset]);
    delta += Math.abs(a.data[aOffset + 1] - b.data[bOffset + 1]);
    delta += Math.abs(a.data[aOffset + 2] - b.data[bOffset + 2]);
  }

  return Number((delta / (pixels * 3 * 255)).toFixed(5));
}

function toneStatsFromRaw(raw: RawImage): ImageToneStats {
  const pixels = raw.width * raw.height;
  if (!pixels) return { contrast: 0, saturation: 0 };

  let mean = 0;
  let saturation = 0;
  const luminanceValues = new Float64Array(pixels);

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * raw.channels;
    const red = raw.data[offset] / 255;
    const green = raw.data[offset + 1] / 255;
    const blue = raw.data[offset + 2] / 255;
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    luminanceValues[pixel] = luma;
    mean += luma;
    saturation += max === 0 ? 0 : (max - min) / max;
  }

  mean /= pixels;
  saturation /= pixels;

  let variance = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const delta = luminanceValues[pixel] - mean;
    variance += delta * delta;
  }

  return {
    contrast: Math.sqrt(variance / pixels),
    saturation
  };
}

/**
 * Decode the original once per job at the sizes the quality metrics use, instead of
 * re-decoding the full-resolution original for every metric of every candidate.
 */
async function buildReference(original: Buffer): Promise<ReferenceImage | undefined> {
  try {
    const metric = await rawForMetric(original, 160, 160);
    const psnr = await rawForMetric(original, 96, 96);
    return { metric, psnr, tone: toneStatsFromRaw(metric) };
  } catch {
    return undefined;
  }
}

async function measureCandidate(reference: ReferenceImage | undefined, buffer: Buffer): Promise<Candidate["metrics"]> {
  if (!reference) return {};
  try {
    const metric = await rawForMetric(buffer, reference.metric.width, reference.metric.height);
    const psnr = await rawForMetric(buffer, reference.psnr.width, reference.psnr.height);
    const tone = toneStatsFromRaw(metric);
    return {
      psnr: psnrFromRaw(reference.psnr, psnr),
      ssim: ssimFromRaw(reference.metric, metric),
      colorDelta: colorDeltaFromRaw(reference.metric, metric),
      contrastRatio: reference.tone.contrast ? Number((tone.contrast / reference.tone.contrast).toFixed(4)) : undefined,
      saturationRatio: reference.tone.saturation ? Number((tone.saturation / reference.tone.saturation).toFixed(4)) : undefined
    };
  } catch {
    return {};
  }
}

/**
 * For large still images, build a small lossless proxy (resize + enhancements already applied)
 * to run the quality search on. Encoding a 12 MP photo 4-8 times per format is what made the
 * app take minutes and hundreds of MB per image; the metrics are measured at 160px anyway.
 */
async function buildSearchProxy(original: Buffer, options: ProcessOptions, metadata: sharp.Metadata): Promise<Buffer | undefined> {
  if ((metadata.pages || 1) > 1) return undefined;
  const pixels = (metadata.width || 0) * (metadata.height || 0);
  if (pixels <= PROXY_MIN_PIXELS) return undefined;

  try {
    let prepared = inputImage(original);
    prepared = applyResize(prepared, options);
    prepared = applyEnhancements(prepared, options);
    const stage = await prepared.keepIccProfile().png({ compressionLevel: 0, palette: false }).toBuffer({ resolveWithObject: true });
    if (stage.info.width * stage.info.height <= PROXY_MIN_PIXELS) {
      return stage.data;
    }
    return await sharp(stage.data, { failOn: "none", limitInputPixels: pixelLimit })
      .resize({ width: PROXY_MAX_EDGE, height: PROXY_MAX_EDGE, fit: "inside", kernel: "lanczos3" })
      .keepIccProfile()
      .png({ compressionLevel: 0, palette: false })
      .toBuffer();
  } catch {
    return undefined;
  }
}

async function encodeFromOriginal(
  original: Buffer,
  format: EncodableFormat,
  options: ProcessOptions,
  quality: number,
  contentClass: ContentClass,
  tier: EncodeTier
): Promise<Buffer> {
  let image = inputImage(original, true);
  image = applyResize(image, options);
  image = applyEnhancements(image, options);
  return format === "jxl"
    ? encodeJpegXl(await image.png({ compressionLevel: 0, palette: false }).toBuffer(), quality)
    : encode(image, format, options, quality, contentClass, tier).toBuffer();
}

async function encodeFromProxy(
  proxy: Buffer,
  format: EncodableFormat,
  options: ProcessOptions,
  quality: number,
  contentClass: ContentClass
): Promise<Buffer> {
  return format === "jxl"
    ? encodeJpegXl(proxy, quality)
    : encode(sharp(proxy, { failOn: "none" }), format, options, quality, contentClass, "search").toBuffer();
}

async function classifyContent(sample: RawImage | undefined, metadata: sharp.Metadata): Promise<ContentClass> {
  if ((metadata.pages || 1) > 1) return "animation";
  if (!sample) return "photo";

  try {
    const buckets = new Set<string>();
    let totalDelta = 0;
    let checks = 0;
    for (let y = 1; y < sample.height; y += 1) {
      for (let x = 1; x < sample.width; x += 1) {
        const pixel = y * sample.width + x;
        const left = pixel - 1;
        const up = pixel - sample.width;
        totalDelta += Math.abs(luminance(sample, pixel) - luminance(sample, left));
        totalDelta += Math.abs(luminance(sample, pixel) - luminance(sample, up));
        checks += 2;
        const offset = pixel * sample.channels;
        buckets.add(`${sample.data[offset] >> 4}-${sample.data[offset + 1] >> 4}-${sample.data[offset + 2] >> 4}`);
      }
    }
    const uniqueRatio = buckets.size / Math.max(1, sample.width * sample.height);
    const edgeDelta = totalDelta / Math.max(1, checks);
    if (metadata.hasAlpha) {
      return uniqueRatio < 0.08 ? "transparent-graphic" : "transparent-photo";
    }
    if (uniqueRatio < 0.045) return "graphic";
    if (uniqueRatio < 0.16 && edgeDelta > 12) return "screenshot";
  } catch {
    return "photo";
  }

  return "photo";
}

function maxColorDeltaFor(contentClass: ContentClass, options: ProcessOptions): number {
  if (contentClass === "graphic" || contentClass === "screenshot" || contentClass === "transparent-graphic") {
    return options.preset === "smallest" ? 0.022 : 0.012;
  }
  if (contentClass === "transparent-photo") {
    return options.preset === "smallest" ? 0.026 : 0.014;
  }
  return options.preset === "smallest" ? 0.035 : 0.024;
}

function minToneRatioFor(contentClass: ContentClass, options: ProcessOptions): number {
  if (contentClass === "graphic" || contentClass === "screenshot" || contentClass === "transparent-graphic") {
    return options.preset === "smallest" ? 0.94 : 0.985;
  }

  if (options.preset === "fidelity") return 0.99;
  if (options.preset === "ultra") return 0.982;
  if (options.preset === "smallest") return 0.93;
  return 0.975;
}

interface RaceContext {
  original: Buffer;
  reference?: ReferenceImage;
  proxy?: Buffer;
  options: ProcessOptions;
  contentClass: ContentClass;
  tier: EncodeTier;
  allowAvif: boolean;
  /** Per-job memo so "Auto" plus an explicit format (e.g. AVIF) doesn't run the same search twice. */
  races?: Map<EncodableFormat, Promise<OptimizedResult>>;
  finals?: Map<EncodableFormat, Promise<OptimizedResult>>;
}

function raceFormat(context: RaceContext, format: EncodableFormat): Promise<OptimizedResult> {
  context.races ??= new Map();
  let race = context.races.get(format);
  if (!race) {
    race = optimizeWithCandidateRace(context, format);
    context.races.set(format, race);
  }
  return race;
}

function finalFormat(context: RaceContext, format: EncodableFormat, result: OptimizedResult): Promise<OptimizedResult> {
  context.finals ??= new Map();
  let final = context.finals.get(format);
  if (!final) {
    final = finalizeResult(context, format, result);
    context.finals.set(format, final);
  }
  return final;
}

async function optimizeWithCandidateRace(context: RaceContext, format: EncodableFormat): Promise<OptimizedResult> {
  const { original, reference, proxy, options, contentClass } = context;
  const targetSsim = targetSsimFor(options, contentClass);
  const maxColorDelta = maxColorDeltaFor(contentClass, options);
  const minToneRatio = minToneRatioFor(contentClass, options);
  const candidates: Candidate[] = [];

  for (const quality of candidateQualities(format, options, contentClass)) {
    const buffer = proxy
      ? await encodeFromProxy(proxy, format, options, quality, contentClass)
      : await encodeFromOriginal(original, format, options, quality, contentClass, context.tier);
    candidates.push({
      buffer,
      quality,
      losslessFallback: format === "png" && quality === 0,
      metrics: await measureCandidate(reference, buffer)
    });
  }

  const passing = candidates.filter(
    (candidate) =>
      (candidate.metrics.ssim || 0) >= targetSsim &&
      (candidate.metrics.colorDelta ?? 1) <= maxColorDelta &&
      (candidate.metrics.contrastRatio ?? 0) >= minToneRatio &&
      (candidate.metrics.saturationRatio ?? 0) >= minToneRatio
  );
  const selected = passing.length
    ? passing.sort((a, b) => {
        if (a.buffer.byteLength !== b.buffer.byteLength) return a.buffer.byteLength - b.buffer.byteLength;
        return (b.metrics.ssim || 0) - (a.metrics.ssim || 0);
      })[0]
    : candidates.sort((a, b) => {
        const toneDeficitA =
          Math.max(0, minToneRatio - (a.metrics.contrastRatio || 0)) +
          Math.max(0, minToneRatio - (a.metrics.saturationRatio || 0));
        const toneDeficitB =
          Math.max(0, minToneRatio - (b.metrics.contrastRatio || 0)) +
          Math.max(0, minToneRatio - (b.metrics.saturationRatio || 0));
        if (a.losslessFallback !== b.losslessFallback) return a.losslessFallback ? -1 : 1;
        if (toneDeficitA !== toneDeficitB) return toneDeficitA - toneDeficitB;
        if ((b.metrics.ssim || 0) !== (a.metrics.ssim || 0)) return (b.metrics.ssim || 0) - (a.metrics.ssim || 0);
        if ((a.metrics.colorDelta ?? 1) !== (b.metrics.colorDelta ?? 1)) return (a.metrics.colorDelta ?? 1) - (b.metrics.colorDelta ?? 1);
        return a.buffer.byteLength - b.buffer.byteLength;
      })[0];

  return {
    buffer: selected.buffer,
    proxied: Boolean(proxy),
    candidateCount: candidates.length,
    selectedQuality: selected.quality,
    psnr: selected.metrics.psnr,
    ssim: selected.metrics.ssim,
    colorDelta: selected.metrics.colorDelta,
    contrastRatio: selected.metrics.contrastRatio,
    saturationRatio: selected.metrics.saturationRatio,
    targetSsim,
    passedQualityGate: passing.includes(selected),
    externalOptimizer: selected.externalOptimizer,
    losslessFallback: selected.losslessFallback
  };
}

/** Produce the real output for the chosen quality: full-size encode (if searched on a proxy) plus PNG post-optimization. */
async function finalizeResult(context: RaceContext, format: EncodableFormat, result: OptimizedResult): Promise<OptimizedResult> {
  const buffer = result.proxied
    ? await encodeFromOriginal(context.original, format, context.options, result.selectedQuality, context.contentClass, context.tier)
    : result.buffer;
  const external = format === "png" ? await optimizePngWithOxipng(buffer) : { buffer };
  return {
    ...result,
    buffer: external.buffer,
    externalOptimizer: external.optimizer || result.externalOptimizer
  };
}

function autoCandidateFormats(originalFormat: OutputFormat, contentClass: ContentClass, hasAlpha?: boolean, allowAvif = true): EncodableFormat[] {
  if (contentClass === "animation") {
    return originalFormat === "webp" || originalFormat === "png" ? [originalFormat] : ["webp"];
  }

  const formats: EncodableFormat[] = (
    hasAlpha || contentClass === "graphic" || contentClass === "screenshot" ? ["webp", "avif", "png"] : ["avif", "webp", "jpeg"]
  ).filter((format) => allowAvif || format !== "avif") as EncodableFormat[];

  // Always let the input's own lossy format compete, so a JPEG that was misread as a graphic
  // can still come back as a smaller JPEG instead of a much larger lossless PNG.
  const lossyOriginal = originalFormat === "jpeg" || originalFormat === "webp" || (originalFormat === "avif" && allowAvif);
  if (!hasAlpha && lossyOriginal && !formats.includes(originalFormat)) {
    formats.push(originalFormat);
  }
  return formats;
}

async function optimizeAuto(
  context: RaceContext,
  originalFormat: OutputFormat,
  hasAlpha?: boolean
): Promise<OptimizedResult & { format: EncodableFormat; candidateFormats: EncodableFormat[] }> {
  const candidateFormats = autoCandidateFormats(originalFormat, context.contentClass, hasAlpha, context.allowAvif);
  const results = [];

  for (const format of candidateFormats) {
    results.push({
      format,
      ...(await raceFormat(context, format))
    });
  }

  const passing = results.filter((result) => result.passedQualityGate);
  const selected = (passing.length ? passing : results).sort((a, b) => {
    if (a.passedQualityGate !== b.passedQualityGate) return a.passedQualityGate ? -1 : 1;
    if (a.buffer.byteLength !== b.buffer.byteLength) return a.buffer.byteLength - b.buffer.byteLength;
    return (b.ssim || 0) - (a.ssim || 0);
  })[0];

  // Only the winning format is encoded at full size.
  return {
    ...(await finalFormat(context, selected.format, selected)),
    format: selected.format,
    candidateFormats
  };
}

export async function processStoredImage(stored: StoredImage, original: Buffer, optionsInput?: Partial<ProcessOptions>): Promise<JobResult> {
  const options = mergeOptions(optionsInput);
  const inputType = await detectMime(original, stored.originalFilename);

  try {
    const metadata = await sharp(original, { animated: true, failOn: "none", limitInputPixels: false }).metadata();
    const inputDimensions = displayDimensions(metadata);
    const inputPixels = (metadata.width || 0) * (metadata.height || 0);
    if (pixelLimit && inputPixels > pixelLimit) {
      throw new Error(
        `This image is ${(inputPixels / 1e6).toFixed(1)} MP; this server accepts up to ${Math.round(pixelLimit / 1e6)} MP. Run the app locally for larger images.`
      );
    }
    const outputPixels = estimateOutputPixels(metadata, options);
    const allowAvif = outputPixels <= maxAvifPixels;
    const notes: string[] = [];
    const reference = await buildReference(original);
    const contentClass = await classifyContent(reference?.psnr, metadata);
    const originalFormat = normalizeSharpFormat(metadata.format);
    const requestedFormats = options.formats.map((format) => (format === "original" ? originalFormat : format));
    const uniqueFormats = [...new Set(requestedFormats)];
    const variants: OutputVariant[] = [];
    const context: RaceContext = {
      original,
      reference,
      proxy: await buildSearchProxy(original, options, metadata),
      options,
      contentClass,
      tier: outputPixels <= SMALL_IMAGE_PIXELS ? "small" : "large",
      allowAvif
    };

    for (const format of uniqueFormats) {
      if (format === "auto") {
        const variantId = nanoid(12);
        const optimized = await optimizeAuto(context, originalFormat, metadata.hasAlpha);
        const outputBuffer = optimized.buffer;
        const outputMeta = optimized.format === "jxl" ? metadata : await sharp(outputBuffer, { animated: true, failOn: "none" }).metadata();
        const mime = mimeForOutput(optimized.format);
        const filename = `${sanitizeFilename(stored.originalFilename)}-auto-${optimized.format}.${extensionForMime(mime)}`;
        await saveOutput(variantId, filename, outputBuffer);
        const savings = 1 - outputBuffer.byteLength / original.byteLength;

        variants.push({
          id: variantId,
          filename,
          size: outputBuffer.byteLength,
          type: mime,
          width: outputMeta.width,
          height: outputMeta.height,
          savings,
          format: optimized.format,
          downloadUrl: `/output/${variantId}`,
          previewUrl: `/preview/${variantId}`,
          metrics: {
            psnr: optimized.psnr,
            ssim: optimized.ssim,
            colorDelta: optimized.colorDelta,
            contrastRatio: optimized.contrastRatio,
            saturationRatio: optimized.saturationRatio,
            sizeRatio: Number((outputBuffer.byteLength / original.byteLength).toFixed(4)),
            candidateCount: optimized.candidateCount,
            selectedQuality: optimized.selectedQuality,
            targetSsim: optimized.targetSsim,
            contentClass,
            losslessFallback: optimized.losslessFallback,
            autoSelected: true,
            autoCandidateFormats: optimized.candidateFormats,
            externalOptimizer: optimized.externalOptimizer
          }
        });
        continue;
      }

      if (format === "original") {
        throw new Error("Original output format could not be resolved from the input image.");
      }

      if (format === "avif" && !allowAvif) {
        notes.push(
          `AVIF was skipped: at ${(outputPixels / 1e6).toFixed(1)} MP it needs more memory than this server allows (limit ${Math.round(maxAvifPixels / 1e6)} MP). Resize first, pick WebP, or run the app locally.`
        );
        continue;
      }

      const variantId = nanoid(12);
      const optimized = await finalFormat(context, format, await raceFormat(context, format));
      const outputBuffer = optimized.buffer;
      const outputMeta = format === "jxl" ? metadata : await sharp(outputBuffer, { animated: true, failOn: "none" }).metadata();
      const mime = mimeForOutput(format);
      const filename = `${sanitizeFilename(stored.originalFilename)}-${format}.${extensionForMime(mime)}`;
      await saveOutput(variantId, filename, outputBuffer);
      const savings = 1 - outputBuffer.byteLength / original.byteLength;

      variants.push({
        id: variantId,
        filename,
        size: outputBuffer.byteLength,
        type: mime,
        width: outputMeta.width,
        height: outputMeta.height,
        savings,
        format,
        downloadUrl: `/output/${variantId}`,
        previewUrl: `/preview/${variantId}`,
        metrics: {
          psnr: optimized.psnr,
          ssim: optimized.ssim,
          colorDelta: optimized.colorDelta,
          contrastRatio: optimized.contrastRatio,
          saturationRatio: optimized.saturationRatio,
          sizeRatio: Number((outputBuffer.byteLength / original.byteLength).toFixed(4)),
          candidateCount: optimized.candidateCount,
          selectedQuality: optimized.selectedQuality,
          targetSsim: optimized.targetSsim,
          contentClass,
          losslessFallback: optimized.losslessFallback,
          externalOptimizer: optimized.externalOptimizer
        }
      });
    }

    return {
      id: stored.id,
      originalFilename: stored.originalFilename,
      input: {
        size: stored.inputSize,
        type: inputType,
        width: inputDimensions.width,
        height: inputDimensions.height,
        previewUrl: `/input/${stored.id}`
      },
      status: variants.length ? "done" : "error",
      error: variants.length ? undefined : notes[0],
      notes: notes.length ? notes : undefined,
      variants
    };
  } catch (error) {
    return {
      id: stored.id,
      originalFilename: stored.originalFilename,
      input: {
        size: stored.inputSize,
        type: inputType,
        previewUrl: `/input/${stored.id}`
      },
      status: "error",
      error: error instanceof Error ? error.message : "Image could not be optimized.",
      variants: []
    };
  }
}

export async function processUpload(
  buffer: Buffer,
  originalFilename: string,
  options?: Partial<ProcessOptions>,
  existingPath?: string
): Promise<JobResult> {
  const mime = await detectMime(buffer, originalFilename);
  const stored = await storeOriginal(buffer, originalFilename, mime, existingPath);
  return processStoredImage(stored, buffer, options);
}
