import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./constants.js";

export type Ecosystem = "auto" | "python" | "npm" | "cargo" | "homebrew" | "fallback";
export type AgentName = "auto" | "codex" | "claude" | "cursor" | "gemini" | "opencode" | "pi" | "none";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CliConfig {
  agent: AgentName;
  ecosystem: Ecosystem;
  allowHelpExec: boolean;
  noExec: boolean;
  json: boolean;
  debug: boolean;
  verbose: boolean;
  usage: boolean;
  keepWorkspace: boolean;
  refresh: boolean;
  maxFiles: number;
  maxBytes: number;
  agentTimeout: number;
  reasoningEffort?: ReasoningEffort;
  headlessPath?: string | null;
  headlessExtraFlags: readonly string[];
  packageRoot?: string;
  executable?: string;
}

export interface FileConfig {
  defaults?: Partial<CliConfig>;
  agents?: {
    headless?: {
      path?: string | null;
      extraFlags?: string[];
    };
  };
  cache?: {
    dir?: string;
    maxSizeMb?: number;
  };
}

const ownedHeadlessFlags = new Set([
  "--allow",
  "-C",
  "--debug",
  "--docker",
  "--json",
  "--modal",
  "--prompt",
  "-p",
  "--prompt-file",
  "--reasoning-effort",
  "--session",
  "--tmux",
  "--usage",
  "--work-dir",
]);

const reasoningEfforts = new Set(["low", "medium", "high", "xhigh"]);

export class ConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.path = path;
  }
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<CliConfig> {
  const path = configPath(env, home);

  if (!(await fileExists(path))) {
    return { ...defaultConfig };
  }

  const rawConfig = await readJsonConfig(path);
  return mergeConfig({
    ...parseDefaultsConfig(rawConfig.defaults, path),
    ...parseHeadlessConfig(rawConfig, path),
  });
}

export function configPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "ask", "config.json");
}

export function mergeConfig(overrides: Partial<CliConfig>): CliConfig {
  return {
    ...defaultConfig,
    ...definedValues(overrides),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonConfig(path: string): Promise<FileConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) {
      throw new ConfigError(path, "config root must be a JSON object");
    }

    return parsed as FileConfig;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(path, message);
  }
}

function definedValues<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDefaultsConfig(defaults: FileConfig["defaults"], path: string): Partial<CliConfig> {
  if (defaults === undefined) {
    return {};
  }

  if (!isRecord(defaults)) {
    throw new ConfigError(path, "defaults must be a JSON object");
  }

  if (Object.hasOwn(defaults, "headlessPath")) {
    throw new ConfigError(path, "defaults.headlessPath is not supported; use agents.headless.path");
  }
  if (Object.hasOwn(defaults, "headlessExtraFlags")) {
    throw new ConfigError(path, "defaults.headlessExtraFlags is not supported; use agents.headless.extraFlags");
  }

  const reasoningEffort = defaults.reasoningEffort;
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
    throw new ConfigError(path, "defaults.reasoningEffort must be one of low, medium, high, xhigh");
  }

  return defaults;
}

function parseHeadlessConfig(config: FileConfig, path: string): Partial<CliConfig> {
  const headless = config.agents?.headless;
  if (!headless) {
    return {};
  }

  if (headless.path !== undefined && headless.path !== null && typeof headless.path !== "string") {
    throw new ConfigError(path, "agents.headless.path must be a string or null");
  }

  if (headless.extraFlags !== undefined) {
    if (!Array.isArray(headless.extraFlags) || headless.extraFlags.some((flag) => typeof flag !== "string")) {
      throw new ConfigError(path, "agents.headless.extraFlags must be an array of strings");
    }
    validateHeadlessExtraFlags(headless.extraFlags, path);
  }

  return {
    headlessPath: headless.path,
    headlessExtraFlags: headless.extraFlags ? [...headless.extraFlags] : undefined,
  };
}

function isOwnedHeadlessFlag(flag: string): boolean {
  const name = flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
  return ownedHeadlessFlags.has(name);
}

function validateHeadlessExtraFlags(flags: readonly string[], path: string): void {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (isOwnedHeadlessFlag(flag)) {
      throw new ConfigError(path, `agents.headless.extraFlags cannot include ${flag}`);
    }

    if (flag === "--model") {
      const value = flags[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new ConfigError(path, "agents.headless.extraFlags --model requires a value");
      }
      index += 1;
      continue;
    }

    if (flag.startsWith("--model=")) {
      if (flag === "--model=") {
        throw new ConfigError(path, "agents.headless.extraFlags --model requires a value");
      }
      continue;
    }

    throw new ConfigError(path, "agents.headless.extraFlags only supports --model");
  }
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && reasoningEfforts.has(value);
}
