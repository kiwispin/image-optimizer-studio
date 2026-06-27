import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import encodeJxl, { init as initJxl } from "@jsquash/jxl/encode.js";

let initPromise: Promise<unknown> | undefined;

function ensureImageData() {
  if (!globalThis.ImageData) {
    globalThis.ImageData = class ImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    } as typeof ImageData;
  }
}

async function ensureJxlReady() {
  ensureImageData();
  if (!initPromise) {
    const wasmPath = path.resolve(process.cwd(), "node_modules", "@jsquash", "jxl", "codec", "enc", "jxl_enc.wasm");
    initPromise = readFile(wasmPath).then((bytes) => WebAssembly.compile(bytes)).then((module) => initJxl(module));
  }
  await initPromise;
}

export async function encodeJpegXl(input: Buffer, quality: number): Promise<Buffer> {
  await ensureJxlReady();
  const raw = await sharp(input, { animated: false, failOn: "none", limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = new Uint8ClampedArray(raw.data);
  const encoded = await encodeJxl(new ImageData(data, raw.info.width, raw.info.height), {
    quality,
    effort: 7
  });
  return Buffer.from(encoded);
}
