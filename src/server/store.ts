import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

export const storeRoot = path.resolve(process.cwd(), ".local-tinypng");
export const originalsDir = path.join(storeRoot, "originals");
export const outputsDir = path.join(storeRoot, "outputs");
export const incomingDir = path.join(storeRoot, "incoming");
export const tmpDir = path.join(storeRoot, "tmp");

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
  await mkdir(incomingDir, { recursive: true });
}

export function originalPath(id: string): string {
  return path.join(originalsDir, `${id}.bin`);
}

export async function storeOriginal(buffer: Buffer, originalFilename: string, inputType: string, existingPath?: string): Promise<StoredImage> {
  await ensureStore();
  const id = nanoid(12);
  const inputPath = originalPath(id);
  if (existingPath) {
    // The upload is already on disk (multer disk storage) - move it instead of writing a second copy.
    await rename(existingPath, inputPath).catch(() => writeFile(inputPath, buffer));
  } else {
    await writeFile(inputPath, buffer);
  }
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

/**
 * Delete stored originals, outputs and temp files older than `maxAgeMs`.
 * Without this the store grew forever (and every file was re-read on startup).
 */
export async function sweepStore(maxAgeMs: number): Promise<string[]> {
  const removed: string[] = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const dir of [originalsDir, outputsDir, incomingDir, tmpDir]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await rm(filePath, { force: true });
          removed.push(filePath);
        }
      } catch {
        // File vanished between readdir and stat; nothing to do.
      }
    }
  }
  return removed;
}
