import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { LocatedExecutable, Resolution } from "../types.js";

interface CellarPackage {
  readonly packageName: string;
  readonly version: string;
  readonly packageRoot: string;
}

export async function resolveHomebrewPackage(located: LocatedExecutable): Promise<Resolution> {
  const cellar = await parseCellarPackage(located.realPath);
  if (!cellar) {
    return unresolvedHomebrewResolution(located, ["Homebrew Cellar path was not found"]);
  }

  const metadataFiles = await homebrewMetadataFiles(cellar.packageRoot, cellar.packageName);
  const entryFile = await scriptEntryFile(cellar.packageRoot, located.realPath, located.executableKind);
  const warnings = metadataFiles.length > 0 ? [] : ["Homebrew package metadata files were not found"];

  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "homebrew",
    packageName: cellar.packageName,
    version: cellar.version,
    packageRoot: null,
    entryFile,
    metadataFiles,
    confidence: entryFile ? "high" : "medium",
    warnings,
    shim: located.shim,
  };
}

async function parseCellarPackage(path: string): Promise<CellarPackage | null> {
  const parts = path.split(sep);
  const cellarIndex = parts.lastIndexOf("Cellar");
  if (cellarIndex === -1 || cellarIndex + 2 >= parts.length) {
    return null;
  }

  const packageName = parts[cellarIndex + 1];
  const version = parts[cellarIndex + 2];
  if (!packageName || !version || !isSafeCellarPart(packageName) || !isSafeCellarPart(version)) {
    return null;
  }

  const packageRoot = await realpath(parts.slice(0, cellarIndex + 3).join(sep) || sep).catch(() => null);
  if (!packageRoot || !isWithin(packageRoot, path)) {
    return null;
  }

  return { packageName, version, packageRoot };
}

async function homebrewMetadataFiles(packageRoot: string, packageName: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const relativePath of ["INSTALL_RECEIPT.json", "README", "README.md"]) {
    const path = await realFileWithin(packageRoot, relativePath);
    if (path) {
      files.push(path);
    }
  }

  files.push(...await filesUnder(packageRoot, join("share", "doc"), 3, (name) => isReadableMetadataName(name)));
  files.push(...await filesUnder(packageRoot, join("share", "man"), 4, (name) => /\.(\d|man)$/i.test(name)));

  const formulaDir = join(packageRoot, ".brew");
  let entries: string[];
  try {
    entries = await readdir(formulaDir);
  } catch {
    return files;
  }

  for (const entry of entries.sort()) {
    if (entry === `${packageName}.rb` || entry.endsWith(".rb")) {
      const path = await realFileWithin(packageRoot, join(".brew", entry));
      if (path) {
        files.push(path);
      }
    }
  }

  return files;
}

async function filesUnder(
  packageRoot: string,
  relativeDirectory: string,
  maxDepth: number,
  includeFile: (name: string) => boolean,
): Promise<readonly string[]> {
  const root = await realpath(join(packageRoot, relativeDirectory)).catch(() => null);
  if (!root || !isWithin(packageRoot, root)) {
    return [];
  }

  const files: string[] = [];
  await collectFiles(root, root, maxDepth, includeFile, files);
  return files;
}

async function collectFiles(
  root: string,
  directory: string,
  depth: number,
  includeFile: (name: string) => boolean,
  files: string[],
): Promise<void> {
  if (depth < 0 || files.length >= 32) {
    return;
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await realpath(path).catch(() => null);
      if (child && isWithin(root, child)) {
        await collectFiles(root, child, depth - 1, includeFile, files);
      }
      continue;
    }

    if (!entry.isFile() || !includeFile(entry.name)) {
      continue;
    }

    const file = await realpath(path).catch(() => null);
    if (file && isWithin(root, file)) {
      files.push(file);
    }
  }
}

function isReadableMetadataName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("readme")
    || lower.startsWith("changelog")
    || lower.endsWith(".md")
    || lower.endsWith(".txt")
    || lower.endsWith(".1");
}

async function scriptEntryFile(
  packageRoot: string,
  executablePath: string,
  executableKind: LocatedExecutable["executableKind"],
): Promise<string | null> {
  if (executableKind !== "script") {
    return null;
  }

  const path = await realpath(executablePath).catch(() => null);
  if (!path || !isWithin(packageRoot, path)) {
    return null;
  }

  return path;
}

async function realFileWithin(root: string, relativePath: string): Promise<string | null> {
  const path = await realpath(join(root, relativePath)).catch(() => null);
  if (!path || !isWithin(root, path)) {
    return null;
  }

  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function unresolvedHomebrewResolution(located: LocatedExecutable, warnings: readonly string[]): Resolution {
  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "homebrew",
    packageName: null,
    version: null,
    packageRoot: null,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings,
    shim: located.shim,
  };
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(root, path);
  return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith(sep));
}

function isSafeCellarPart(value: string): boolean {
  return value !== "." && value !== ".." && !value.includes(sep);
}
