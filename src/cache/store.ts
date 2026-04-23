import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContextBundle, Resolution } from "../types.js";

export class CacheStore {
  readonly root: string;

  constructor(root = defaultCacheRoot()) {
    this.root = root;
  }

  async getBundle(key: string): Promise<ContextBundle | null> {
    const path = join(this.root, "collections", `${key}.json`);
    try {
      const raw = await readFile(path, "utf8");
      await touch(path);
      return JSON.parse(raw, jsonReviver) as ContextBundle;
    } catch {
      return null;
    }
  }

  async setBundle(key: string, bundle: ContextBundle): Promise<void> {
    const path = join(this.root, "collections", `${key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(bundle, jsonReplacer)}\n`);
  }

  async setResolution(key: string, resolution: Resolution): Promise<void> {
    const path = join(this.root, "resolutions", `${key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(resolution, jsonReplacer)}\n`);
  }

  async storeWorkspace(key: string, workspacePath: string): Promise<void> {
    const destination = join(this.root, "workspaces", key);
    await chmodWritable(destination).catch(() => undefined);
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(workspacePath, destination, { recursive: true, dereference: true });
  }

  async evict(maxSizeMb: number): Promise<void> {
    const maxBytes = maxSizeMb * 1024 * 1024;
    const entries = await cacheEntries(this.root);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    for (const entry of entries.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (totalBytes <= maxBytes) {
        break;
      }

      await chmodWritable(entry.path).catch(() => undefined);
      await rm(entry.path, { recursive: true, force: true });
      totalBytes -= entry.sizeBytes;
    }
  }
}

export async function cacheKeyForResolution(resolution: Resolution): Promise<string> {
  const entryHash = resolution.entryFile ? await firstChunkHash(resolution.entryFile) : "";
  return createHash("sha256")
    .update([
      resolution.command,
      resolution.packageName ?? "",
      resolution.version ?? "",
      resolution.executableRealPath,
      resolution.executableMtimeNs.toString(),
      entryHash,
    ].join("|"))
    .digest("hex");
}

export function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "ask");
}

async function firstChunkHash(path: string): Promise<string> {
  try {
    const content = await readFile(path);
    return createHash("sha256").update(content.subarray(0, 4096)).digest("hex");
  } catch {
    return "";
  }
}

async function cacheEntries(root: string): Promise<Array<{
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const result = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    const entryStat = await stat(path);
    result.push({
      path,
      sizeBytes: entry.isDirectory() ? await directorySize(path) : Number(entryStat.size),
      mtimeMs: entryStat.mtimeMs,
    });
  }
  return result;
}

async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    const childStat = await stat(child);
    total += entry.isDirectory() ? await directorySize(child) : Number(childStat.size);
  }
  return total;
}

async function chmodWritable(path: string): Promise<void> {
  const entryStat = await stat(path);
  if (entryStat.isDirectory()) {
    await import("node:fs/promises").then((fs) => fs.chmod(path, 0o755));
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      await chmodWritable(join(path, entry.name));
    }
    return;
  }

  await import("node:fs/promises").then((fs) => fs.chmod(path, 0o644));
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  await import("node:fs/promises").then((fs) => fs.utimes(path, now, now));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __askBigInt: value.toString() } : value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "__askBigInt" in value &&
    typeof (value as { __askBigInt: unknown }).__askBigInt === "string"
  ) {
    return BigInt((value as { __askBigInt: string }).__askBigInt);
  }

  return value;
}
