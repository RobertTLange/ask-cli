import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { readUtf8Prefix } from "../fs/read-prefix.js";
import { runSandbox } from "../sandbox.js";
import type { FileKind, HelpOutput, Limits, Resolution } from "../types.js";

export interface FallbackFileCandidate {
  readonly path: string;
  readonly relPath: string;
  readonly kind: FileKind;
}

export async function fallbackFileCandidates(
  resolution: Resolution,
): Promise<readonly FallbackFileCandidate[]> {
  const executablePath = await realpath(resolution.executableRealPath)
    .catch(() => resolution.executableRealPath);
  const executableDir = dirname(executablePath);
  const relRoot = dirname(executableDir);
  const files: FallbackFileCandidate[] = [];

  if (await isTextLikeExecutable(executablePath, resolution.executablePath)) {
    files.push({
      path: executablePath,
      relPath: safeRelative(relRoot, executablePath) ?? basename(executablePath),
      kind: "source",
    });
  }

  files.push(...await nearbyExecutableFiles(executableDir, relRoot));
  return files;
}

export async function collectManOutput(
  resolution: Resolution,
  limits: Limits,
): Promise<HelpOutput | null> {
  const startedAt = performance.now();
  const result = await runSandbox({
    command: "man",
    args: [resolution.command],
    timeoutMs: limits.helpTimeoutMs,
    stdoutBytes: limits.helpStdoutBytes,
    stderrBytes: limits.helpStdoutBytes,
  });

  if (!result.ok || result.stdout.trim().length === 0) {
    return null;
  }

  return {
    command: ["man", resolution.command],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
    durationMs: Math.round(performance.now() - startedAt),
    truncated: result.stdoutTruncated || result.stderrTruncated,
  };
}

async function nearbyExecutableFiles(
  directory: string,
  relRoot: string,
): Promise<readonly FallbackFileCandidate[]> {
  const realDirectory = await realpath(directory).catch(() => null);
  if (!realDirectory) {
    return [];
  }

  let entries;
  try {
    entries = await readdir(realDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: FallbackFileCandidate[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const kind = nearbyFileKind(entry.name);
    if (!kind) {
      continue;
    }

    const path = join(realDirectory, entry.name);
    const realFile = await realpath(path).catch(() => null);
    if (!realFile || !isWithin(realDirectory, realFile)) {
      continue;
    }

    files.push({
      path: realFile,
      relPath: safeRelative(relRoot, realFile) ?? entry.name,
      kind,
    });
  }

  return files;
}

function nearbyFileKind(name: string): FileKind | null {
  const lower = name.toLowerCase();
  if (lower.startsWith("readme")) {
    return "readme";
  }
  if (lower.includes("completion")) {
    return "completion";
  }
  if (
    lower.endsWith(".conf")
    || lower.endsWith(".config")
    || lower.endsWith(".toml")
    || lower.endsWith(".json")
    || lower.endsWith("rc")
  ) {
    return "config";
  }
  return null;
}

async function isTextLikeExecutable(realPath: string, displayPath: string): Promise<boolean> {
  if ([".sh", ".bash", ".zsh", ".fish", ".js", ".mjs", ".cjs", ".py", ".rb", ".pl"].includes(extname(displayPath))) {
    return true;
  }

  const prefix = await readUtf8Prefix(realPath, 512);
  const sample = prefix?.text ?? "";
  if (sample.startsWith("#!")) {
    return true;
  }

  if (sample.includes("\u0000")) {
    return false;
  }

  return /^[\t\r\n -~]*$/.test(sample) && sample.trim().length > 0;
}

function safeRelative(root: string, path: string): string | null {
  const relPath = relative(root, path);
  return relPath !== "" && !relPath.startsWith("..") && !isAbsolute(relPath) ? relPath : null;
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(root, path);
  return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith(sep));
}
