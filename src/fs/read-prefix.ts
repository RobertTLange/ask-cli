import { open, stat } from "node:fs/promises";

export interface PrefixRead {
  readonly text: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export async function readUtf8Prefix(path: string, maxBytes: number): Promise<PrefixRead | null> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile()) {
    return null;
  }

  const sizeBytes = Number(fileStat.size);
  const readBytes = Math.min(maxBytes, sizeBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(readBytes);
    const result = await handle.read(buffer, 0, readBytes, 0);
    return {
      text: buffer.subarray(0, result.bytesRead).toString("utf8"),
      sizeBytes,
      truncated: sizeBytes > result.bytesRead,
    };
  } finally {
    await handle.close();
  }
}

export async function readUtf8FileWithinLimit(path: string, maxBytes: number): Promise<string | null> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size > maxBytes) {
    return null;
  }

  return (await readUtf8Prefix(path, maxBytes))?.text ?? null;
}
