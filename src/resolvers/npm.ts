import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type { LocatedExecutable, Resolution } from "../types.js";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
}

export async function resolveNpmPackage(located: LocatedExecutable): Promise<Resolution> {
  const exact = await resolveByPackageJsonBin(located);
  if (exact) {
    return exact;
  }

  const fallback = await resolveInsideNodeModules(located);
  if (fallback) {
    return fallback;
  }

  return unresolvedNpmResolution(located, ["npm package metadata was not found"]);
}

async function resolveByPackageJsonBin(located: LocatedExecutable): Promise<Resolution | null> {
  for (const packageRoot of packageRootCandidates(located.realPath)) {
    const packageJson = await readPackageJson(join(packageRoot, "package.json"));
    if (!packageJson) {
      continue;
    }

    const binEntries = normalizeBinEntries(packageJson);
    for (const [binName, binTarget] of binEntries) {
      const targetPath = await realpath(join(packageRoot, binTarget)).catch(() => null);
      if (binName === located.command && targetPath === located.realPath) {
        return resolutionFromPackage(located, packageJson, packageRoot, targetPath, "high", []);
      }
    }
  }

  return null;
}

async function resolveInsideNodeModules(located: LocatedExecutable): Promise<Resolution | null> {
  const packageRoot = nodeModulesPackageRoot(located.realPath);
  if (!packageRoot) {
    return null;
  }

  const packageJson = await readPackageJson(join(packageRoot, "package.json"));
  if (!packageJson) {
    return null;
  }

  return resolutionFromPackage(
    located,
    packageJson,
    packageRoot,
    located.realPath,
    "medium",
    ["No exact package.json bin match found; resolved from node_modules package path"],
  );
}

function resolutionFromPackage(
  located: LocatedExecutable,
  packageJson: PackageJson,
  packageRoot: string,
  entryFile: string | null,
  confidence: Resolution["confidence"],
  warnings: readonly string[],
): Resolution {
  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "npm",
    packageName: stringOrNull(packageJson.name),
    version: stringOrNull(packageJson.version),
    packageRoot,
    entryFile,
    metadataFiles: [join(packageRoot, "package.json")],
    confidence,
    warnings,
    shim: located.shim,
  };
}

function packageRootCandidates(startPath: string): readonly string[] {
  const candidates: string[] = [];
  let current = dirname(startPath);

  for (let depth = 0; depth < 32; depth += 1) {
    candidates.push(current);
    const next = dirname(current);
    if (next === current || current === parse(current).root) {
      break;
    }
    current = next;
  }

  return candidates;
}

async function readPackageJson(path: string): Promise<PackageJson | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeBinEntries(packageJson: PackageJson): readonly [string, string][] {
  if (typeof packageJson.bin === "string" && typeof packageJson.name === "string") {
    return [[packageJson.name, packageJson.bin]];
  }

  if (!isRecord(packageJson.bin)) {
    return [];
  }

  return Object.entries(packageJson.bin)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function nodeModulesPackageRoot(path: string): string | null {
  const parts = path.split("/");
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex + 1 >= parts.length) {
    return null;
  }

  const firstPackagePart = parts[nodeModulesIndex + 1];
  const packageEnd = firstPackagePart?.startsWith("@") ? nodeModulesIndex + 3 : nodeModulesIndex + 2;
  if (packageEnd > parts.length) {
    return null;
  }

  return parts.slice(0, packageEnd).join("/") || "/";
}

function unresolvedNpmResolution(located: LocatedExecutable, warnings: readonly string[]): Resolution {
  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "npm",
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
