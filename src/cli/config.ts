import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./constants.js";

export type Ecosystem = "auto" | "python" | "npm" | "cargo" | "homebrew" | "fallback";
export type AgentName = "codex" | "none";

export interface CliConfig {
  agent: AgentName;
  ecosystem: Ecosystem;
  allowHelpExec: boolean;
  noExec: boolean;
  json: boolean;
  debug: boolean;
  verbose: boolean;
  keepWorkspace: boolean;
  refresh: boolean;
  maxFiles: number;
  maxBytes: number;
  agentTimeout: number;
  packageRoot?: string;
  executable?: string;
}

export interface FileConfig {
  defaults?: Partial<CliConfig>;
  agents?: {
    codex?: {
      path?: string | null;
      extraFlags?: string[];
    };
  };
  cache?: {
    dir?: string;
    maxSizeMb?: number;
  };
}

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
  return mergeConfig(rawConfig.defaults ?? {});
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
