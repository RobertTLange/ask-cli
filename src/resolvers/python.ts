import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runSandbox } from "../sandbox.js";
import type { LocatedExecutable, Resolution } from "../types.js";

interface PythonCandidate {
  readonly packageName: string;
  readonly version: string | null;
  readonly packageRoot: string | null;
  readonly entryFile: string | null;
  readonly metadataFiles: readonly string[];
  readonly confidence: Resolution["confidence"];
  readonly source: "tier-a" | "tier-b";
}

interface RecordEntry {
  readonly path: string;
}

const introspectionScript = String.raw`
import importlib.metadata
import json
import pathlib
import sys

command = sys.argv[1]
matches = []
for dist in importlib.metadata.distributions():
    for entry in dist.entry_points:
        if entry.group == "console_scripts" and entry.name == command:
            root = pathlib.Path(dist.locate_file(""))
            module_path = pathlib.Path(*entry.module.split("."))
            entry_file = root / (str(module_path) + ".py")
            if not entry_file.exists():
                entry_file = root / module_path / "__init__.py"
            matches.append({
                "packageName": dist.metadata.get("Name"),
                "version": dist.version,
                "packageRoot": str(root),
                "entryFile": str(entry_file) if entry_file.exists() else None,
                "metadataFiles": [str(getattr(dist, "_path", ""))] if getattr(dist, "_path", None) else [],
            })
print(json.dumps(matches))
`;

export async function resolvePythonPackage(located: LocatedExecutable): Promise<Resolution> {
  const tierA = await resolveWithIntrospection(located);
  const tierB = await resolveWithDistInfo(located);
  const warnings = disagreementWarnings(tierA, tierB);
  const selected = tierA ?? tierB;

  if (!selected) {
    return unresolvedPythonResolution(located, ["Python package metadata was not found"]);
  }

  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "python",
    packageName: selected.packageName,
    version: selected.version,
    packageRoot: selected.packageRoot,
    entryFile: selected.entryFile,
    metadataFiles: selected.metadataFiles,
    confidence: selected.confidence,
    warnings,
    shim: located.shim,
  };
}

async function resolveWithIntrospection(located: LocatedExecutable): Promise<PythonCandidate | null> {
  const python = pythonFromShebang(located.shebang);
  if (!python) {
    return null;
  }

  const result = await runSandbox({
    command: python,
    args: ["-c", introspectionScript, located.command],
    timeoutMs: 5_000,
    stdoutBytes: 131_072,
    stderrBytes: 16_384,
  });

  if (!result.ok) {
    return null;
  }

  try {
    const matches = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const match = matches.find((candidate) => candidate.packageName === located.command) ?? matches[0];
    if (!match || typeof match.packageName !== "string") {
      return null;
    }

    return {
      packageName: match.packageName,
      version: stringOrNull(match.version),
      packageRoot: stringOrNull(match.packageRoot),
      entryFile: stringOrNull(match.entryFile),
      metadataFiles: stringArray(match.metadataFiles),
      confidence: "medium",
      source: "tier-a",
    };
  } catch {
    return null;
  }
}

async function resolveWithDistInfo(located: LocatedExecutable): Promise<PythonCandidate | null> {
  for (const sitePackages of await candidateSitePackages(located.path)) {
    const candidate = await resolveFromSitePackages(located, sitePackages);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

async function resolveFromSitePackages(
  located: LocatedExecutable,
  sitePackages: string,
): Promise<PythonCandidate | null> {
  let entries: string[];
  try {
    entries = await readdir(sitePackages);
  } catch {
    return null;
  }

  for (const entry of entries.filter((value) => value.endsWith(".dist-info")).sort()) {
    const distInfo = join(sitePackages, entry);
    const recordPath = join(distInfo, "RECORD");
    const metadata = await readMetadata(join(distInfo, "METADATA"));
    const entryPoint = await readConsoleScript(join(distInfo, "entry_points.txt"), located.command);
    const recordEntries = await readRecordEntries(sitePackages, recordPath);
    const executableMatchesRecord = await recordContainsExecutable(recordEntries, located.realPath);
    const metadataFiles = await existingMetadataFiles(distInfo);

    if (!metadata.name) {
      continue;
    }

    if (entryPoint) {
      const entryFile = await findEntryFile(sitePackages, entryPoint.module);

      return {
        packageName: metadata.name,
        version: metadata.version,
        packageRoot: entryFile ? packageRootForEntry(entryFile, entryPoint.module) : sitePackages,
        entryFile,
        metadataFiles,
        confidence: executableMatchesRecord ? "medium" : "low",
        source: "tier-b",
      };
    }

    if (!executableMatchesRecord) {
      continue;
    }

    const nativeEntry = await inferNativeWheelEntry(sitePackages, metadata.name, recordEntries);
    return {
      packageName: metadata.name,
      version: metadata.version,
      packageRoot: nativeEntry?.packageRoot ?? null,
      entryFile: nativeEntry?.entryFile ?? null,
      metadataFiles,
      confidence: "medium",
      source: "tier-b",
    };
  }

  return null;
}

async function candidateSitePackages(executablePath: string): Promise<readonly string[]> {
  const candidates: string[] = [];
  let current = dirname(executablePath);

  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(...await pythonLibSitePackages(current));
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return candidates;
}

async function pythonLibSitePackages(prefix: string): Promise<readonly string[]> {
  const lib = join(prefix, "lib");
  let versions: string[];
  try {
    versions = await readdir(lib);
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const version of versions.filter((entry) => entry.startsWith("python"))) {
    for (const packageDir of ["site-packages", "dist-packages"]) {
      const candidate = join(lib, version, packageDir);
      try {
        if ((await stat(candidate)).isDirectory()) {
          candidates.push(candidate);
        }
      } catch {
        // Continue scanning sibling Python package directories.
      }
    }
  }

  return candidates;
}

async function readMetadata(path: string): Promise<{ name: string | null; version: string | null }> {
  try {
    const content = await readFile(path, "utf8");
    return {
      name: headerValue(content, "Name"),
      version: headerValue(content, "Version"),
    };
  } catch {
    return { name: null, version: null };
  }
}

async function readConsoleScript(
  path: string,
  command: string,
): Promise<{ module: string; callable: string | null } | null> {
  let inConsoleScripts = false;

  try {
    const content = await readFile(path, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      if (line.startsWith("[") && line.endsWith("]")) {
        inConsoleScripts = line === "[console_scripts]";
        continue;
      }

      if (!inConsoleScripts) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const name = line.slice(0, separatorIndex).trim();
      if (name !== command) {
        continue;
      }

      const target = line.slice(separatorIndex + 1).trim();
      const [module, callable = null] = target.split(":", 2);
      return { module: module.trim(), callable: callable?.trim() ?? null };
    }
  } catch {
    return null;
  }

  return null;
}

async function findEntryFile(sitePackages: string, moduleName: string): Promise<string | null> {
  const modulePath = moduleName.split(".").join("/");
  const fileCandidate = join(sitePackages, `${modulePath}.py`);
  if (await fileExists(fileCandidate)) {
    return fileCandidate;
  }

  const packageCandidate = join(sitePackages, modulePath, "__init__.py");
  return (await fileExists(packageCandidate)) ? packageCandidate : null;
}

async function readRecordEntries(sitePackages: string, recordPath: string): Promise<readonly RecordEntry[]> {
  try {
    const content = await readFile(recordPath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.split(",", 1)[0])
      .filter((path) => path.length > 0)
      .map((path) => ({
        path: resolve(sitePackages, path),
      }));
  } catch {
    return [];
  }
}

async function recordContainsExecutable(entries: readonly RecordEntry[], executableRealPath: string): Promise<boolean> {
  const executableName = basename(executableRealPath);
  for (const entry of entries) {
    if (resolve(entry.path) === executableRealPath) {
      return true;
    }

    if (basename(entry.path) !== executableName) {
      continue;
    }

    try {
      if ((await realpath(entry.path)) === executableRealPath) {
        return true;
      }
    } catch {
      // RECORD may contain files not present in editable installs.
    }
  }

  return false;
}

async function existingMetadataFiles(distInfo: string): Promise<readonly string[]> {
  const files = ["METADATA", "entry_points.txt", "RECORD"].map((file) => join(distInfo, file));
  const existing: string[] = [];
  for (const file of files) {
    if (await fileExists(file)) {
      existing.push(file);
    }
  }

  return existing;
}

async function inferNativeWheelEntry(
  sitePackages: string,
  packageName: string,
  records: readonly RecordEntry[],
): Promise<{ packageRoot: string | null; entryFile: string | null } | null> {
  const roots = importRootCandidates(sitePackages, packageName, records);

  for (const root of roots) {
    if (root.kind === "module") {
      return { packageRoot: null, entryFile: root.path };
    }

    const mainFile = join(root.path, "__main__.py");
    if (await fileExists(mainFile)) {
      return { packageRoot: root.path, entryFile: mainFile };
    }

    const initFile = join(root.path, "__init__.py");
    if (await fileExists(initFile)) {
      return { packageRoot: root.path, entryFile: initFile };
    }
  }

  return null;
}

function importRootCandidates(
  sitePackages: string,
  packageName: string,
  records: readonly RecordEntry[],
): ReadonlyArray<{ kind: "package" | "module"; path: string; score: number }> {
  const normalizedPackageName = normalizePythonName(packageName);
  const byPath = new Map<string, { kind: "package" | "module"; path: string; score: number }>();

  for (const record of records) {
    const relPath = relativeWithin(sitePackages, record.path);
    if (!relPath) {
      continue;
    }

    const parts = relPath.split(/[\\/]/);
    const firstPart = parts[0];
    if (!firstPart || firstPart.endsWith(".dist-info") || firstPart.endsWith(".data")) {
      continue;
    }

    if (parts.length === 1 && /\.(py|pyi|so|pyd)$/.test(firstPart)) {
      const score = normalizePythonName(firstPart.replace(/\.(py|pyi|so|pyd)$/, "")) === normalizedPackageName ? 10 : 0;
      byPath.set(record.path, { kind: "module", path: record.path, score });
      continue;
    }

    if (parts.length > 1 && /\.(py|pyi|so|pyd)$/.test(parts.at(-1) ?? "")) {
      const rootPath = join(sitePackages, firstPart);
      const score = normalizePythonName(firstPart) === normalizedPackageName ? 10 : 0;
      byPath.set(rootPath, { kind: "package", path: rootPath, score });
    }
  }

  return [...byPath.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

function relativeWithin(root: string, path: string): string | null {
  const relPath = relative(resolve(root), resolve(path));
  if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) {
    return null;
  }
  return relPath;
}

function normalizePythonName(value: string): string {
  return value.toLowerCase().replace(/[-.]+/g, "_");
}

function pythonFromShebang(shebang: string | null): string | null {
  if (!shebang) {
    return null;
  }

  const parts = shebang.split(/\s+/);
  if (parts[0]?.endsWith("/env") && parts[1]?.startsWith("python")) {
    return parts[1];
  }

  return parts[0]?.includes("python") ? parts[0] : null;
}

function packageRootForEntry(entryFile: string, moduleName: string): string {
  const depth = Math.max(0, moduleName.split(".").length - 2);
  let root = dirname(entryFile);
  for (let index = 0; index < depth; index += 1) {
    root = dirname(root);
  }
  return root;
}

function headerValue(content: string, header: string): string | null {
  const match = content.match(new RegExp(`^${header}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function disagreementWarnings(
  tierA: PythonCandidate | null,
  tierB: PythonCandidate | null,
): readonly string[] {
  if (!tierA || !tierB) {
    return [];
  }

  if (tierA.packageName !== tierB.packageName || tierA.version !== tierB.version) {
    return ["Python Tier A metadata disagrees with Tier B dist-info metadata; Tier A was used"];
  }

  return [];
}

function unresolvedPythonResolution(
  located: LocatedExecutable,
  warnings: readonly string[],
): Resolution {
  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "python",
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

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
