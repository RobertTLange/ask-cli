import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";
import type { LocatedExecutable, Resolution } from "../types.js";
import { resolveLocalWrapperTarget } from "./wrappers.js";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
  readonly optionalDependencies?: unknown;
}

export async function resolveNpmPackage(located: LocatedExecutable): Promise<Resolution> {
  const wrapper = await resolveThroughWrapper(located);
  if (wrapper) {
    return wrapper;
  }

  const exact = await resolveByPackageJsonBin(located);
  if (exact) {
    const platformOwner = await resolveOptionalPlatformOwner(located, exact);
    if (platformOwner) {
      return platformOwner;
    }

    return exact;
  }

  const fallback = await resolveInsideNodeModules(located);
  if (fallback) {
    return fallback;
  }

  return unresolvedNpmResolution(located, ["npm package metadata was not found"]);
}

async function resolveOptionalPlatformOwner(
  located: LocatedExecutable,
  platformResolution: Resolution,
): Promise<Resolution | null> {
  if (located.executableKind === "script") {
    return null;
  }

  if (!platformResolution.packageRoot || !platformResolution.packageName || !platformResolution.version) {
    return null;
  }

  for (const ownerRoot of await optionalOwnerCandidates(platformResolution.packageRoot)) {
    const packageJson = await readPackageJson(join(ownerRoot, "package.json"));
    if (!packageJson || !declaresOptionalDependency(packageJson, platformResolution.packageName, platformResolution.version)) {
      continue;
    }

    for (const [binName, binTarget] of normalizeBinEntries(packageJson)) {
      if (binName !== located.command) {
        continue;
      }

      const targetPath = await realpath(join(ownerRoot, binTarget)).catch(() => null);
      if (!targetPath) {
        continue;
      }

      return resolutionFromPackage(
        located,
        packageJson,
        ownerRoot,
        targetPath,
        "high",
        [],
      );
    }
  }

  return null;
}

async function optionalOwnerCandidates(platformRoot: string): Promise<readonly string[]> {
  const candidates = new Set<string>();
  const modulesRoot = dirname(platformRoot);
  if (basename(modulesRoot) !== "node_modules") {
    return [];
  }

  candidates.add(dirname(modulesRoot));

  for (const packageRoot of await packageRootsInNodeModules(modulesRoot)) {
    if (packageRoot !== platformRoot) {
      candidates.add(packageRoot);
    }
  }

  return [...candidates];
}

async function packageRootsInNodeModules(modulesRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const packageRoots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const path = join(modulesRoot, entry.name);
    if (entry.name.startsWith("@")) {
      packageRoots.push(...await scopedPackageRoots(path));
      continue;
    }

    packageRoots.push(path);
  }

  return packageRoots;
}

async function scopedPackageRoots(scopeRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(scopeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(scopeRoot, entry.name));
}

function declaresOptionalDependency(packageJson: PackageJson, name: string, version: string): boolean {
  if (!isRecord(packageJson.optionalDependencies)) {
    return false;
  }

  const requested = packageJson.optionalDependencies[name];
  return typeof requested === "string" && requested.includes(version);
}

async function resolveThroughWrapper(located: LocatedExecutable): Promise<Resolution | null> {
  const target = await resolveLocalWrapperTarget(located.realPath);
  if (!target) {
    return null;
  }

  const targetLocated = { ...located, realPath: target };
  const exact = await resolveByPackageJsonBin(targetLocated);
  if (!exact) {
    return null;
  }

  return {
    ...exact,
    warnings: [...exact.warnings, "Resolved package metadata through local wrapper script"],
  };
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
