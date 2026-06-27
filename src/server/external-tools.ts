import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";

const execFileAsync = promisify(execFile);

export type SpecialistTool = "oxipng" | "zopflipng" | "cjxl" | "butteraugli" | "ssimulacra2";

export interface ToolStatus {
  name: SpecialistTool;
  available: boolean;
  path?: string;
}

const toolNames: SpecialistTool[] = ["oxipng", "zopflipng", "cjxl", "butteraugli", "ssimulacra2"];
const commandCache = new Map<string, string | undefined>();

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export async function findCommand(command: string): Promise<string | undefined> {
  if (commandCache.has(command)) return commandCache.get(command);

  const localBin = path.resolve(process.cwd(), "node_modules", ".bin");
  const pathDirs = [localBin, ...(process.env.PATH?.split(path.delimiter) || [])];
  const candidates = pathDirs.flatMap((dir) => {
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    return extensions.map((extension) => path.join(dir, `${command}${extension}`));
  });

  for (const candidate of candidates) {
    if (await canExecute(candidate)) {
      commandCache.set(command, candidate);
      return candidate;
    }
  }

  commandCache.set(command, undefined);
  return undefined;
}

export async function specialistToolStatus(): Promise<ToolStatus[]> {
  return Promise.all(
    toolNames.map(async (name) => {
      const toolPath = await findCommand(name);
      return {
        name,
        available: Boolean(toolPath),
        path: toolPath
      };
    })
  );
}

export async function optimizePngWithOxipng(buffer: Buffer): Promise<{ buffer: Buffer; optimizer?: string }> {
  const oxipng = await findCommand("oxipng");
  if (!oxipng) return { buffer };

  const tmpDir = path.resolve(process.cwd(), ".local-tinypng", "tmp");
  await mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${nanoid(10)}.png`);
  await writeFile(filePath, buffer);
  try {
    if (process.platform === "win32") {
      await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${oxipng}" -o 4 --strip safe "${filePath}"`], { timeout: 120000 });
    } else {
      await execFileAsync(oxipng, ["-o", "4", "--strip", "safe", filePath], { timeout: 120000 });
    }
  } catch {
    return { buffer };
  }

  const optimized = await readFile(filePath);

  return optimized.byteLength < buffer.byteLength
    ? { buffer: optimized, optimizer: "oxipng" }
    : { buffer };
}
