import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocatedExecutable, Resolution } from "../types.js";

interface CargoInstall {
  readonly packageName: string;
  readonly version: string | null;
  readonly bins: readonly string[];
  readonly sourceRoot: string | null;
}

interface CargoManifest {
  readonly packageName: string | null;
  readonly version: string | null;
  readonly bins: readonly CargoBin[];
}

interface CargoBin {
  readonly name: string | null;
  readonly path: string | null;
}

export async function resolveCargoPackage(located: LocatedExecutable): Promise<Resolution> {
  const targetResolution = await resolveTargetBinary(located);
  if (targetResolution) {
    return targetResolution;
  }

  const installResolution = await resolveInstalledBinary(located);
  if (installResolution) {
    return installResolution;
  }

  return unresolvedCargoResolution(located, ["Cargo package metadata was not found"]);
}

async function resolveTargetBinary(located: LocatedExecutable): Promise<Resolution | null> {
  const commandName = executableName(located);
  if (!isCargoTargetBinary(located.realPath)) {
    return null;
  }

  const packageRoot = await findManifestRoot(dirname(located.realPath));
  if (!packageRoot) {
    return null;
  }

  const manifestPath = join(packageRoot, "Cargo.toml");
  const manifest = await readCargoManifest(manifestPath);
  if (!manifest.packageName) {
    return null;
  }

  const commandMatchesManifest = manifest.bins.some((bin) => bin.name === commandName)
    || manifest.packageName === commandName;
  if (!commandMatchesManifest) {
    return null;
  }

  const entryFile = await findCargoEntryFile(packageRoot, manifest, commandName);
  const confidence = entryFile ? "high" : "medium";
  const warnings = entryFile ? [] : ["Cargo entry file was not found; package metadata only"];

  return cargoResolution(located, {
    packageName: manifest.packageName,
    version: manifest.version,
    packageRoot,
    entryFile,
    metadataFiles: [manifestPath],
    confidence,
    warnings,
  });
}

function isCargoTargetBinary(path: string): boolean {
  const parts = path.split("/");
  const targetIndex = parts.lastIndexOf("target");
  if (targetIndex === -1 || targetIndex + 2 >= parts.length) {
    return false;
  }

  const profile = parts[targetIndex + 1];
  if (profile === "debug" || profile === "release") {
    return true;
  }

  return targetIndex + 3 < parts.length && (parts[targetIndex + 2] === "debug" || parts[targetIndex + 2] === "release");
}

async function resolveInstalledBinary(located: LocatedExecutable): Promise<Resolution | null> {
  const commandName = executableName(located);
  const cargoHome = cargoHomeForExecutable(located.realPath);
  if (!cargoHome) {
    return null;
  }

  const install = await findCargoInstall(cargoHome, commandName);
  if (!install) {
    return null;
  }

  const sourceRoot = await findPathInstallSourceRoot(install.sourceRoot)
    ?? (install.version ? await findRegistrySourceRoot(cargoHome, install.packageName, install.version) : null);
  if (!sourceRoot) {
    return cargoResolution(located, {
      packageName: install.packageName,
      version: install.version,
      packageRoot: null,
      entryFile: null,
      metadataFiles: [join(cargoHome, ".crates2.json")],
      confidence: "medium",
      warnings: ["Cargo install metadata was found, but source root was not found"],
    });
  }

  const manifestPath = join(sourceRoot, "Cargo.toml");
  const manifest = await readCargoManifest(manifestPath);
  const entryFile = await findCargoEntryFile(sourceRoot, manifest, commandName);
  return cargoResolution(located, {
    packageName: manifest.packageName ?? install.packageName,
    version: manifest.version ?? install.version,
    packageRoot: sourceRoot,
    entryFile,
    metadataFiles: [manifestPath],
    confidence: entryFile ? "high" : "medium",
    warnings: entryFile ? [] : ["Cargo source root was found, but entry file was not found"],
  });
}

async function findManifestRoot(startDirectory: string): Promise<string | null> {
  let current = startDirectory;
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(current, "Cargo.toml");
    try {
      if ((await stat(manifestPath)).isFile()) {
        return await realpath(current);
      }
    } catch {
      // Keep walking upward.
    }

    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return null;
}

async function findCargoInstall(cargoHome: string, command: string): Promise<CargoInstall | null> {
  return await findCargoInstallFromCrates2(cargoHome, command)
    ?? await findCargoInstallFromCratesToml(cargoHome, command);
}

async function findCargoInstallFromCrates2(cargoHome: string, command: string): Promise<CargoInstall | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cargoHome, ".crates2.json"), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.installs)) {
      return null;
    }

    for (const [key, value] of Object.entries(parsed.installs)) {
      if (!isRecord(value) || !stringArray(value.bins).includes(command)) {
        continue;
      }

      const parsedKey = parseInstallKey(key);
      if (parsedKey) {
        return { ...parsedKey, bins: stringArray(value.bins) };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function findCargoInstallFromCratesToml(cargoHome: string, command: string): Promise<CargoInstall | null> {
  let content;
  try {
    content = await readFile(join(cargoHome, ".crates.toml"), "utf8");
  } catch {
    return null;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)"\s*=\s*\[(.*)]\s*$/);
    if (!match || !match[2].includes(`"${command}"`)) {
      continue;
    }

    const parsedKey = parseInstallKey(match[1]);
    if (parsedKey) {
      return { ...parsedKey, bins: [command] };
    }
  }

  return null;
}

function parseInstallKey(key: string): Omit<CargoInstall, "bins"> | null {
  const match = key.match(/^(.+)\s+([0-9][^\s]*)\s+\((.+)\)$/);
  if (!match) {
    return null;
  }

  if (!isSafeCrateName(match[1]) || !isSafeCrateVersion(match[2])) {
    return null;
  }

  return {
    packageName: match[1],
    version: match[2],
    sourceRoot: parseCargoSourceRoot(match[3]),
  };
}

function parseCargoSourceRoot(source: string): string | null {
  if (!source.startsWith("path+file://")) {
    return null;
  }

  try {
    return fileURLToPath(source.slice("path+".length));
  } catch {
    return null;
  }
}

async function findPathInstallSourceRoot(path: string | null): Promise<string | null> {
  if (!path) {
    return null;
  }

  try {
    const sourceRoot = await realpath(path);
    if ((await stat(join(sourceRoot, "Cargo.toml"))).isFile()) {
      return sourceRoot;
    }
  } catch {
    return null;
  }

  return null;
}

async function findRegistrySourceRoot(
  cargoHome: string,
  packageName: string,
  version: string,
): Promise<string | null> {
  const registrySrc = join(cargoHome, "registry", "src");
  let registries: string[];
  try {
    registries = await readdir(registrySrc);
  } catch {
    return null;
  }

  for (const registry of registries.sort()) {
    const candidate = join(registrySrc, registry, `${packageName}-${version}`);
    try {
      const candidateRoot = await realpath(candidate);
      if (isWithin(await realpath(registrySrc), candidateRoot) && (await stat(join(candidateRoot, "Cargo.toml"))).isFile()) {
        return candidateRoot;
      }
    } catch {
      // Try the next registry source directory.
    }
  }

  return null;
}

async function readCargoManifest(path: string): Promise<CargoManifest> {
  try {
    return parseCargoManifest(await readFile(path, "utf8"));
  } catch {
    return { packageName: null, version: null, bins: [] };
  }
}

function parseCargoManifest(content: string): CargoManifest {
  let section: "package" | "bin" | "other" = "other";
  let packageName: string | null = null;
  let version: string | null = null;
  const bins: CargoBin[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }

    if (line === "[package]") {
      section = "package";
      continue;
    }

    if (line === "[[bin]]") {
      section = "bin";
      bins.push({ name: null, path: null });
      continue;
    }

    if (line.startsWith("[")) {
      section = "other";
      continue;
    }

    const value = tomlStringValue(line);
    if (!value) {
      continue;
    }

    if (section === "package" && value.key === "name") {
      packageName = value.value;
    } else if (section === "package" && value.key === "version") {
      version = value.value;
    } else if (section === "bin" && bins.length > 0) {
      const current = bins[bins.length - 1];
      if (value.key === "name") {
        bins[bins.length - 1] = { ...current, name: value.value };
      } else if (value.key === "path") {
        bins[bins.length - 1] = { ...current, path: value.value };
      }
    }
  }

  return { packageName, version, bins };
}

function tomlStringValue(line: string): { key: string; value: string } | null {
  const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"\s*$/);
  return match ? { key: match[1], value: match[2] } : null;
}

async function findCargoEntryFile(
  packageRoot: string,
  manifest: CargoManifest,
  command: string,
): Promise<string | null> {
  const matchingBin = manifest.bins.find((bin) => bin.name === command);
  if (matchingBin?.path) {
    return realFileWithin(packageRoot, matchingBin.path);
  }

  const candidates = [
    join("src", "bin", `${command}.rs`),
    join("src", "main.rs"),
  ];

  for (const candidate of candidates) {
    const path = await realFileWithin(packageRoot, candidate);
    if (path) {
      return path;
    }
  }

  return null;
}

async function realFileWithin(root: string, relativePath: string): Promise<string | null> {
  const rootPath = await realpath(root).catch(() => null);
  if (!rootPath) {
    return null;
  }

  const path = await realpath(join(rootPath, relativePath)).catch(() => null);
  if (!path || !isWithin(rootPath, path)) {
    return null;
  }

  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function cargoHomeForExecutable(path: string): string | null {
  const marker = "/bin/";
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const cargoHome = path.slice(0, markerIndex);
  return cargoHome.length > 0 ? cargoHome : null;
}

function executableName(located: LocatedExecutable): string {
  return basename(located.realPath);
}

function cargoResolution(
  located: LocatedExecutable,
  input: {
    readonly packageName: string | null;
    readonly version: string | null;
    readonly packageRoot: string | null;
    readonly entryFile: string | null;
    readonly metadataFiles: readonly string[];
    readonly confidence: Resolution["confidence"];
    readonly warnings: readonly string[];
  },
): Resolution {
  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem: "cargo",
    packageName: input.packageName,
    version: input.version,
    packageRoot: input.packageRoot,
    entryFile: input.entryFile,
    metadataFiles: input.metadataFiles,
    confidence: input.confidence,
    warnings: input.warnings,
    shim: located.shim,
  };
}

function unresolvedCargoResolution(located: LocatedExecutable, warnings: readonly string[]): Resolution {
  return cargoResolution(located, {
    packageName: null,
    version: null,
    packageRoot: null,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings,
  });
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCrateName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isSafeCrateVersion(value: string): boolean {
  return /^[0-9A-Za-z.+-]+$/.test(value);
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(root, path);
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}
