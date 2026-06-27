import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

const root = path.resolve(process.cwd(), ".local-tinypng");
const originalsDir = path.join(root, "originals");
const outputsDir = path.join(root, "outputs");

export interface StoredImage {
  id: string;
  originalFilename: string;
  inputPath: string;
  inputType: string;
  inputSize: number;
}

export async function ensureStore(): Promise<void> {
  await mkdir(originalsDir, { recursive: true });
  await mkdir(outputsDir, { recursive: true });
}

export async function storeOriginal(buffer: Buffer, originalFilename: string, inputType: string): Promise<StoredImage> {
  await ensureStore();
  const id = nanoid(12);
  const inputPath = path.join(originalsDir, `${id}.bin`);
  await writeFile(inputPath, buffer);
  return {
    id,
    originalFilename,
    inputPath,
    inputType,
    inputSize: buffer.byteLength
  };
}

export async function readOriginal(stored: StoredImage): Promise<Buffer> {
  return readFile(stored.inputPath);
}

export function outputPath(id: string, filename: string): string {
  return path.join(outputsDir, `${id}-${filename}`);
}

export async function saveOutput(id: string, filename: string, buffer: Buffer): Promise<string> {
  await ensureStore();
  const target = outputPath(id, filename);
  await writeFile(target, buffer);
  return target;
}

export async function outputSize(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}
