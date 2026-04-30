import { access, lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { cwd } from "node:process";
import { exitCodes } from "../cli/constants.js";
import { AskError } from "../errors.js";
import { runSandbox } from "../sandbox.js";
import type { LocatedExecutable, ShimInfo } from "../types.js";

export interface LocateOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly executable?: string;
}

export async function locateExecutable(
  command: string,
  options: LocateOptions = {},
): Promise<LocatedExecutable> {
  const env = options.env ?? process.env;
  const explicitPath = options.executable ? resolve(options.executable) : null;
  const candidatePath = explicitPath
    ? (await isFile(explicitPath) ? explicitPath : null)
    : await findOnPath(command, env.PATH);
  const developmentFixturePath = candidatePath === null && explicitPath === null ? await findDevelopmentFixture(command) : null;

  if (candidatePath === null && developmentFixturePath === null) {
    throw new AskError(
      explicitPath ? "explicit executable was not found" : "command was not found on PATH",
      exitCodes.resolution,
      explicitPath ? `locate executable at ${explicitPath}` : `locate executable for ${command}`,
      explicitPath ? "check --executable points to a real file" : "check the command name, install it, or pass --executable <path>",
    );
  }

  const locatedPath = candidatePath ?? developmentFixturePath;
  if (locatedPath === null) {
    throw new Error("unreachable locate state");
  }

  if (explicitPath === null) {
    await rejectShellOnlyCommand(command, options.shell ?? env.SHELL);
  }
  await assertUserExecutable(locatedPath, command);

  const shim = await detectShim(command, locatedPath);
  const executablePath = shim?.resolvedVia && (await fileExists(shim.resolvedVia))
    ? shim.resolvedVia
    : locatedPath;
  const executableStat = await stat(executablePath, { bigint: true });
  const executableRealPath = await realpath(executablePath);
  const symlinkChain = await readSymlinkChain(locatedPath);
  const signature = await readExecutableSignature(executablePath);

  return {
    command,
    path: executablePath,
    realPath: executableRealPath,
    symlinkChain,
    shebang: signature.shebang,
    executableKind: signature.kind,
    mtimeNs: executableStat.mtimeNs,
    shim,
  };
}

async function findDevelopmentFixture(command: string): Promise<string | null> {
  const fixtureBins = [
    join(cwd(), "tests", "fixtures", "python", "bin"),
    join(cwd(), "tests", "fixtures", "npm", "node_modules", ".bin"),
  ];

  for (const fixtureBin of fixtureBins) {
    const candidate = join(fixtureBin, command);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function findOnPath(command: string, pathValue = ""): Promise<string | null> {
  if (command.includes("/")) {
    const resolvedCommand = resolve(command);
    return (await isFile(resolvedCommand)) ? resolvedCommand : null;
  }

  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    const candidate = join(directory, command);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function rejectShellOnlyCommand(command: string, shell: string | undefined): Promise<void> {
  if (!shell || !(await fileExists(shell))) {
    return;
  }

  const result = await runSandbox({
    command: shell,
    args: ["-ic", `type -a ${shellQuote(command)}`],
    timeoutMs: 1_000,
    stdoutBytes: 16_384,
    stderrBytes: 16_384,
  });

  if (!result.ok && result.failureReason !== "non_zero_exit") {
    return;
  }

  const typeOutput = `${result.stdout}\n${result.stderr}`;
  if (/\b(alias|aliased|function|shell builtin|builtin)\b/i.test(typeOutput)) {
    throw new AskError(
      "command resolves to a shell alias, function, or builtin",
      exitCodes.resolution,
      `locate executable for ${command}`,
      "pass --executable <path> for a real file-backed CLI",
    );
  }
}

async function assertUserExecutable(path: string, command: string): Promise<void> {
  const executableStat = await stat(path);
  if ((executableStat.mode & 0o100) === 0) {
    throw new AskError(
      "located file is not user-executable",
      exitCodes.resolution,
      `check executable bit for ${path}`,
      `run chmod u+x ${command} or pass --executable <path>`,
    );
  }
}

async function detectShim(command: string, executablePath: string): Promise<ShimInfo | null> {
  if (executablePath.includes("/.pyenv/shims/")) {
    return {
      kind: "pyenv",
      version: null,
      resolvedVia: await resolveShim("pyenv", ["which", command], executablePath),
    };
  }

  if (executablePath.includes("/.asdf/shims/")) {
    return {
      kind: "asdf",
      version: null,
      resolvedVia: await resolveShim("asdf", ["which", command], executablePath),
    };
  }

  const nvmVersion = executablePath.match(/\/\.nvm\/versions\/node\/([^/]+)\/bin\//)?.[1];
  if (nvmVersion) {
    return {
      kind: "nvm",
      version: nvmVersion,
      resolvedVia: executablePath,
    };
  }

  return null;
}

async function resolveShim(command: string, args: readonly string[], fallbackPath: string): Promise<string> {
  const result = await runSandbox({
    command,
    args,
    timeoutMs: 1_000,
    stdoutBytes: 16_384,
    stderrBytes: 16_384,
  });

  const resolvedPath = result.stdout.trim().split(/\r?\n/)[0];
  return result.ok && resolvedPath ? resolvedPath : fallbackPath;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    const candidateStat = await stat(path);
    return candidateStat.isFile();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const candidateStat = await stat(path);
    return candidateStat.isFile();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSymlinkChain(path: string): Promise<readonly string[]> {
  const chain: string[] = [];
  let currentPath = path;

  for (let depth = 0; depth < 32; depth += 1) {
    const currentStat = await lstat(currentPath);
    if (!currentStat.isSymbolicLink()) {
      break;
    }

    const target = await readlink(currentPath);
    const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(currentPath), target);
    chain.push(`${currentPath} -> ${resolvedTarget}`);
    currentPath = resolvedTarget;
  }

  return chain;
}

async function readExecutableSignature(
  path: string,
): Promise<{ shebang: string | null; kind: LocatedExecutable["executableKind"] }> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead);

    if (prefix.subarray(0, 2).equals(Buffer.from("#!"))) {
      const firstLine = prefix.toString("utf8").split(/\r?\n/, 1)[0];
      return { shebang: firstLine.slice(2).trim(), kind: "script" };
    }

    if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      return { shebang: null, kind: "elf" };
    }

    const magic = prefix.subarray(0, 4).toString("hex");
    if (["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic)) {
      return { shebang: null, kind: "mach-o" };
    }

    return { shebang: null, kind: "unknown" };
  } finally {
    await file.close();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
