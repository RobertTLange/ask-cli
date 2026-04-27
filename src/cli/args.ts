import { parseArgs } from "node:util";
import type { CliConfig } from "./config.js";
import { mergeConfig } from "./config.js";

export interface ParsedInvocation {
  kind: "run";
  command: string;
  question: string;
  config: CliConfig;
}

export interface MetaInvocation {
  kind: "help" | "version";
}

export type Invocation = ParsedInvocation | MetaInvocation;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const optionSchema = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  ecosystem: { type: "string" },
  "package-root": { type: "string" },
  executable: { type: "string" },
  "no-exec": { type: "boolean" },
  "allow-help-exec": { type: "boolean" },
  agent: { type: "string" },
  "agent-timeout": { type: "string" },
  "reasoning-effort": { type: "string" },
  json: { type: "boolean" },
  debug: { type: "boolean" },
  usage: { type: "boolean" },
  verbose: { type: "boolean" },
  "keep-workspace": { type: "boolean" },
  "max-files": { type: "string" },
  "max-bytes": { type: "string" },
  refresh: { type: "boolean" },
} as const;

export function parseInvocation(argv: string[], baseConfig: CliConfig): Invocation {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      options: optionSchema,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(message);
  }

  if (parsed.values.help) {
    return { kind: "help" };
  }

  if (parsed.values.version) {
    return { kind: "version" };
  }

  const [command, ...questionParts] = parsed.positionals;
  if (!command) {
    throw new UsageError("missing command");
  }

  if (questionParts.length === 0) {
    throw new UsageError("missing question");
  }

  const cliConfig = definedValues(parseCliConfig(parsed.values));
  return {
    kind: "run",
    command,
    question: questionParts.join(" "),
    config: mergeConfig({
      ...baseConfig,
      ...cliConfig,
    }),
  };
}

function parseCliConfig(values: Record<string, string | boolean | undefined>): Partial<CliConfig> {
  return {
    agent: parseAgent(values.agent),
    ecosystem: parseEcosystem(values.ecosystem),
    packageRoot: stringValue(values["package-root"]),
    executable: stringValue(values.executable),
    noExec: booleanValue(values["no-exec"]),
    allowHelpExec: booleanValue(values["allow-help-exec"]),
    agentTimeout: positiveInteger(values["agent-timeout"], "--agent-timeout"),
    reasoningEffort: parseReasoningEffort(values["reasoning-effort"]),
    json: booleanValue(values.json),
    debug: booleanValue(values.debug),
    usage: booleanValue(values.usage),
    verbose: booleanValue(values.verbose),
    keepWorkspace: booleanValue(values["keep-workspace"]),
    maxFiles: positiveInteger(values["max-files"], "--max-files"),
    maxBytes: positiveInteger(values["max-bytes"], "--max-bytes"),
    refresh: booleanValue(values.refresh),
  };
}

function parseAgent(value: string | boolean | undefined): CliConfig["agent"] | undefined {
  const agent = stringValue(value);
  if (agent === undefined) {
    return undefined;
  }

  if (
    agent === "auto" ||
    agent === "codex" ||
    agent === "claude" ||
    agent === "cursor" ||
    agent === "gemini" ||
    agent === "opencode" ||
    agent === "pi" ||
    agent === "none"
  ) {
    return agent;
  }

  throw new UsageError(`unsupported --agent: ${agent}`);
}

function parseReasoningEffort(value: string | boolean | undefined): CliConfig["reasoningEffort"] | undefined {
  const effort = stringValue(value);
  if (effort === undefined) {
    return undefined;
  }

  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") {
    return effort;
  }

  throw new UsageError(`unsupported --reasoning-effort: ${effort}`);
}

function parseEcosystem(value: string | boolean | undefined): CliConfig["ecosystem"] | undefined {
  const ecosystem = stringValue(value);
  if (ecosystem === undefined) {
    return undefined;
  }

  if (
    ecosystem === "auto" ||
    ecosystem === "python" ||
    ecosystem === "npm" ||
    ecosystem === "cargo" ||
    ecosystem === "homebrew" ||
    ecosystem === "fallback"
  ) {
    return ecosystem;
  }

  throw new UsageError(`unsupported --ecosystem: ${ecosystem}`);
}

function positiveInteger(
  value: string | boolean | undefined,
  flag: string,
): number | undefined {
  const raw = stringValue(value);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || `${parsed}` !== raw) {
    throw new UsageError(`${flag} must be a positive integer`);
  }

  return parsed;
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: string | boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function definedValues<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
