import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { runSandbox } from "../sandbox.js";
import type { ContextBundle, FileKind, FileRef, HelpOutput, Limits, Resolution } from "../types.js";
import { defaultLimits } from "./limits.js";

export interface CollectionOptions {
  readonly noExec?: boolean;
  readonly allowHelpExec?: boolean;
}

interface DiscoveryState {
  readonly resolution: Resolution;
  readonly limits: Limits;
  readonly files: FileRef[];
  readonly seenPaths: Set<string>;
  totalBytes: number;
  truncatedByLimit: boolean;
}

const localImportDepthLimit = 4;

export async function collectContext(
  resolution: Resolution,
  limits: Limits = defaultLimits,
  options: CollectionOptions = {},
): Promise<ContextBundle> {
  const helpOutputs = await collectHelpOutputs(resolution, limits, options);
  const discoveryState: DiscoveryState = {
    resolution,
    limits,
    files: [],
    seenPaths: new Set(),
    totalBytes: 0,
    truncatedByLimit: false,
  };

  if (resolution.entryFile) {
    await addFileAndLocalImports(discoveryState, resolution.entryFile, 0);
  }

  for (const metadataFile of resolution.metadataFiles) {
    if (isReadablePackageFile(discoveryState, metadataFile)) {
      await addFileRef(discoveryState, metadataFile, "config");
    }
  }

  if (resolution.packageRoot) {
    await discoverPackageFiles(discoveryState, resolution.packageRoot, 0);
  }

  const warnings = discoveryState.truncatedByLimit ? ["Context file limits were reached"] : [];
  return {
    resolution,
    helpOutputs,
    files: discoveryState.files,
    totalBytes: discoveryState.totalBytes,
    warnings,
  };
}

async function collectHelpOutputs(
  resolution: Resolution,
  limits: Limits,
  options: CollectionOptions,
): Promise<readonly HelpOutput[]> {
  if (options.noExec || options.allowHelpExec === false) {
    return [];
  }

  const outputs: HelpOutput[] = [];
  const help = await runAllowedCommand(resolution, ["--help"], limits);
  outputs.push(help);

  if (help.exitCode !== 0) {
    outputs.push(await runAllowedCommand(resolution, ["-h"], limits));
  }

  outputs.push(await runAllowedCommand(resolution, ["--version"], limits));

  for (const subcommand of parseSubcommands(help.stdout).slice(0, limits.subcommandHelpLimit)) {
    outputs.push(await runAllowedCommand(resolution, [subcommand, "--help"], limits));
  }

  return outputs;
}

async function runAllowedCommand(
  resolution: Resolution,
  args: readonly string[],
  limits: Limits,
): Promise<HelpOutput> {
  const startedAt = performance.now();
  const result = await runSandbox({
    command: resolution.executablePath,
    args,
    timeoutMs: limits.helpTimeoutMs,
    stdoutBytes: limits.helpStdoutBytes,
    stderrBytes: limits.helpStdoutBytes,
  });

  return {
    command: [resolution.executablePath, ...args],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
    durationMs: Math.round(performance.now() - startedAt),
    truncated: result.stdoutTruncated || result.stderrTruncated,
  };
}

async function discoverPackageFiles(
  state: DiscoveryState,
  directory: string,
  depth: number,
): Promise<void> {
  if (depth > 6 || state.files.length >= state.limits.maxFiles || state.totalBytes >= state.limits.maxTotalBytes) {
    state.truncatedByLimit = true;
    return;
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.files.length >= state.limits.maxFiles || state.totalBytes >= state.limits.maxTotalBytes) {
      state.truncatedByLimit = true;
      return;
    }

    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await discoverPackageFiles(state, path, depth + 1);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await addFileRef(state, path);
  }
}

async function addFileAndLocalImports(
  state: DiscoveryState,
  path: string,
  depth: number,
): Promise<void> {
  const content = await addFileRef(state, path, "source");
  if (content === null || depth >= localImportDepthLimit) {
    return;
  }

  for (const specifier of parseLocalImports(content)) {
    const importedPath = await resolveLocalImport(path, specifier);
    if (!importedPath || !isReadablePackageFile(state, importedPath)) {
      continue;
    }

    await addFileAndLocalImports(state, importedPath, depth + 1);
  }
}

async function addFileRef(
  state: DiscoveryState,
  path: string,
  forcedKind?: FileKind,
): Promise<string | null> {
  if (state.files.length >= state.limits.maxFiles || state.totalBytes >= state.limits.maxTotalBytes) {
    state.truncatedByLimit = true;
    return null;
  }

  if (state.seenPaths.has(path)) {
    return null;
  }
  state.seenPaths.add(path);

  let fileStat;
  try {
    fileStat = await stat(path);
  } catch {
    return null;
  }

  if (!fileStat.isFile()) {
    return null;
  }

  const remainingBytes = state.limits.maxTotalBytes - state.totalBytes;
  const readLimit = Math.min(state.limits.maxBytesPerFile, Math.max(0, remainingBytes));
  const content = await readFilePrefix(path, readLimit);
  const relPath = state.resolution.packageRoot
    ? relative(state.resolution.packageRoot, path)
    : path;
  const kind = forcedKind ?? classifyFile(path, relPath, content, state.resolution.entryFile);

  if (!kind) {
    return null;
  }

  const truncated = fileStat.size > readLimit;
  state.files.push({
    path,
    relPath,
    sizeBytes: Number(fileStat.size),
    truncated,
    kind,
  });
  state.totalBytes += Math.min(Number(fileStat.size), readLimit);

  if (truncated) {
    state.truncatedByLimit = true;
  }

  return content;
}

async function readFilePrefix(path: string, limit: number): Promise<string> {
  if (limit <= 0) {
    return "";
  }

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const result = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function classifyFile(
  path: string,
  relPath: string,
  content: string,
  entryFile: string | null,
): FileKind | null {
  const name = basename(path).toLowerCase();
  const normalizedRelPath = relPath.toLowerCase();

  if (entryFile === path) {
    return "source";
  }

  if (name.startsWith("readme")) {
    return "readme";
  }

  if (name.startsWith("changelog") || name === "changes.md") {
    return "changelog";
  }

  if (name === "cargo.toml" || name === "cargo.lock" || name === "install_receipt.json") {
    return "config";
  }

  if (normalizedRelPath.startsWith(`docs/`) || normalizedRelPath.startsWith(`doc/`)) {
    return "docs";
  }

  if (normalizedRelPath.startsWith(`test/`) || normalizedRelPath.startsWith(`tests/`) || normalizedRelPath.includes("/__tests__/")) {
    return "test";
  }

  if (normalizedRelPath.startsWith(`examples/`) || normalizedRelPath.startsWith(`example/`)) {
    return "example";
  }

  if (name.endsWith(".rs")) {
    return "source";
  }

  if (/\b(argparse|click|typer|fire|commander|yargs|meow|cac)\b/.test(content)) {
    return "parser";
  }

  if (/\b(pyproject\.toml|setup\.cfg|package\.json|rc|config)\b/i.test(content)) {
    return "config";
  }

  if (/\b(os\.environ|getenv|process\.env)\b/.test(content)) {
    return "env";
  }

  if (normalizedRelPath.includes("completion")) {
    return "completion";
  }

  return null;
}

function parseSubcommands(help: string): readonly string[] {
  const commands: string[] = [];
  let inCommands = false;

  for (const line of help.split(/\r?\n/)) {
    if (/^\s*(commands|subcommands):\s*$/i.test(line)) {
      inCommands = true;
      continue;
    }

    if (inCommands && /^\S/.test(line)) {
      break;
    }

    const match = inCommands ? line.match(/^\s{2,}([a-z][a-z0-9_-]+)/i) : null;
    if (match) {
      commands.push(match[1]);
    }
  }

  return commands;
}

function parseLocalImports(content: string): readonly string[] {
  const imports: string[] = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["'](\.[^"']+)["']/g,
    /\bexport\s+[^'"]+\s+from\s+["'](\.[^"']+)["']/g,
    /\brequire\(\s*["'](\.[^"']+)["']\s*\)/g,
    /\bimport\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }
  }

  return imports;
}

async function resolveLocalImport(fromPath: string, specifier: string): Promise<string | null> {
  const base = join(dirname(fromPath), specifier);
  const candidates = extname(base)
    ? [base]
    : [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.js"),
        join(base, "index.ts"),
      ];

  for (const candidate of candidates) {
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function isReadablePackageFile(state: DiscoveryState, path: string): boolean {
  if (!state.resolution.packageRoot) {
    return true;
  }

  const relPath = relative(state.resolution.packageRoot, path);
  return relPath !== "" && !relPath.startsWith("..") && !isAbsolute(relPath);
}
