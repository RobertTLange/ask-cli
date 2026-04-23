import { helpText, packageVersion, exitCodes } from "./constants.js";
import { ConfigError, loadConfig } from "./config.js";
import { parseInvocation, UsageError, type ParsedInvocation } from "./args.js";
import { collectContext } from "../collectors/context.js";
import { defaultLimits } from "../collectors/limits.js";
import { AgentError, CodexAgent } from "../agents/codex.js";
import { NoneAgent } from "../agents/none.js";
import { buildAgentPrompt } from "../agents/prompt.js";
import { CacheStore, cacheKeyForResolution } from "../cache/store.js";
import { AskError } from "../errors.js";
import { detectEcosystem } from "../resolvers/ecosystem.js";
import { resolveCargoStub, resolveGenericFallback, resolveHomebrewStub } from "../resolvers/fallback.js";
import { locateExecutable } from "../resolvers/locate.js";
import { resolveNpmPackage } from "../resolvers/npm.js";
import { resolvePythonPackage } from "../resolvers/python.js";
import { Trace } from "../trace.js";
import type { Resolution } from "../types.js";
import { stageWorkspace } from "../workspace/stage.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await run(argv);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exitCode = result.exitCode;
}

interface RunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export async function run(argv: string[]): Promise<RunResult> {
  let config;

  try {
    config = await loadConfig();
  } catch (error) {
    return formatConfigError(error);
  }

  try {
    const invocation = parseInvocation(argv, config);

    switch (invocation.kind) {
      case "help":
        return { exitCode: exitCodes.success, stdout: `${helpText}\n` };
      case "version":
        return { exitCode: exitCodes.success, stdout: `${packageVersion}\n` };
      case "run":
        return await runQuestion(invocation);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return {
        exitCode: exitCodes.usage,
        stderr: [
          `Usage error: ${error.message}`,
          "",
          helpText,
          "",
        ].join("\n"),
      };
    }

    if (error instanceof AskError) {
      return formatAskError(error);
    }

    throw error;
  }
}

async function runQuestion(invocation: ParsedInvocation): Promise<RunResult> {
  const trace = new Trace();
  const locateStartedAt = performance.now();
  const located = await locateExecutable(invocation.command);
  trace.record({
    stage: "locate",
    decision: located.path,
    ruleMatched: "path",
    durationMs: Math.round(performance.now() - locateStartedAt),
    details: {
      realPath: located.realPath,
      shebang: located.shebang,
      executableKind: located.executableKind,
      symlinkChain: located.symlinkChain,
      shim: located.shim,
    },
  });

  const ecosystemStartedAt = performance.now();
  const ecosystem = detectEcosystem(located, invocation.config.ecosystem);
  trace.record({
    stage: "ecosystem",
    decision: ecosystem.ecosystem,
    ruleMatched: ecosystem.ruleMatched,
    durationMs: Math.round(performance.now() - ecosystemStartedAt),
  });

  const resolution = await resolveForEcosystem(located, ecosystem.ecosystem);

  const cache = new CacheStore();
  const cacheKey = await cacheKeyForResolution(resolution);
  const cachedBundle = invocation.config.refresh ? null : await cache.getBundle(cacheKey);
  trace.record({
    stage: "cache",
    decision: invocation.config.refresh ? "refresh" : cachedBundle ? "hit" : "miss",
    ruleMatched: "collection",
    durationMs: 0,
    details: { key: cacheKey },
  });

  const bundle = cachedBundle ?? await collectContext(resolution, {
    ...defaultLimits,
    maxFiles: invocation.config.maxFiles,
    maxTotalBytes: invocation.config.maxBytes,
  }, {
    noExec: invocation.config.noExec,
    allowHelpExec: invocation.config.allowHelpExec,
  });
  if (!cachedBundle) {
    await cache.setResolution(cacheKey, resolution);
    await cache.setBundle(cacheKey, bundle);
  }

  const staged = await stageWorkspace(bundle, { question: invocation.question });
  await cache.storeWorkspace(cacheKey, staged.path);
  await cache.evict(512);
  const prompt = buildAgentPrompt({
    command: invocation.command,
    question: invocation.question,
    resolution,
    workspacePath: staged.path,
  });

  try {
    const agent = invocation.config.agent === "none" ? new NoneAgent() : new CodexAgent();
    const answer = await collectAgentAnswer(agent.answer({
      workspacePath: staged.path,
      question: invocation.question,
      resolution,
      prompt,
      timeoutMs: invocation.config.agentTimeout * 1_000,
    }));

    if (invocation.config.keepWorkspace) {
      await staged.release();
    } else {
      await staged.cleanup();
    }

    if (answer.exitCode !== 0) {
      throw new AgentError(
        answer.text || `agent exited with code ${answer.exitCode}`,
        "run agent",
        "run with --debug or --agent none to inspect the staged workspace",
      );
    }

    const stderr = invocation.config.debug ? trace.toDebugString() : undefined;
    return invocation.config.json
      ? jsonAnswer(invocation, resolution, answer.text, staged.path, trace)
      : {
          exitCode: exitCodes.success,
          stdout: [
            resolutionSummary(resolution),
            answer.text,
          ].join("\n"),
          stderr,
        };
  } catch (error) {
    if (invocation.config.keepWorkspace) {
      await staged.release();
    } else {
      await staged.cleanup();
    }

    if (error instanceof AgentError) {
      throw new AskError(
        error.message,
        exitCodes.agent,
        error.attempted,
        error.nextStep,
      );
    }

    throw error;
  }
}

async function collectAgentAnswer(events: AsyncIterable<import("../types.js").AgentEvent>): Promise<{
  readonly text: string;
  readonly exitCode: number;
}> {
  let text = "";
  let exitCode = 0;

  for await (const event of events) {
    if (event.type === "text") {
      text += event.text;
    }
    if (event.type === "error" && event.fatal) {
      text += event.message;
      exitCode = 1;
    }
    if (event.type === "done") {
      exitCode = event.exitCode;
    }
  }

  return { text, exitCode };
}

async function resolveForEcosystem(
  located: Awaited<ReturnType<typeof locateExecutable>>,
  ecosystem: Resolution["ecosystem"],
): Promise<Resolution> {
  switch (ecosystem) {
    case "python":
      return resolvePythonPackage(located);
    case "npm":
      return resolveNpmPackage(located);
    case "cargo":
      return resolveCargoStub(located);
    case "homebrew":
      return resolveHomebrewStub(located);
    case "fallback":
      return resolveGenericFallback(located);
  }
}

function resolutionSummary(resolution: Resolution): string {
  return [
    `Command: ${resolution.command}`,
    `Ecosystem: ${resolution.ecosystem}`,
    `Package: ${resolution.packageName ?? "unknown"} ${resolution.version ?? ""}`.trim(),
    `Confidence: ${resolution.confidence}`,
    `Package root: ${resolution.packageRoot ?? "not available"}`,
    `Entry file: ${resolution.entryFile ?? "not available"}`,
    `Warnings: ${resolution.warnings.length > 0 ? resolution.warnings.join("; ") : "none"}`,
    "",
  ].join("\n");
}

function jsonAnswer(
  invocation: ParsedInvocation,
  resolution: Resolution,
  answer: string,
  workspacePath: string,
  trace: Trace,
): RunResult {
  return {
    exitCode: exitCodes.success,
    stdout: `${JSON.stringify({
      command: invocation.command,
      question: invocation.question,
      resolution: {
        ecosystem: resolution.ecosystem,
        package: resolution.packageName,
        version: resolution.version,
      },
      answer,
      citations: [{ path: "ASK_CONTEXT.md", start: 1, end: 1, kind: "context" }],
      uncertainty: [],
      warnings: resolution.warnings,
      debug: invocation.config.debug ? { trace: trace.events(), workspacePath } : undefined,
    }, null, 2)}\n`,
    stderr: invocation.config.debug ? trace.toDebugString() : undefined,
  };
}

function formatAskError(error: AskError): RunResult {
  const label = error.exitCode === exitCodes.agent ? "Agent error" : "Resolution error";
  return {
    exitCode: error.exitCode,
    stderr: [
      `${label}: ${error.message}`,
      `Attempted: ${error.attempted}`,
      `Next step: ${error.nextStep}`,
      "",
    ].join("\n"),
  };
}

function formatConfigError(error: unknown): RunResult {
  if (error instanceof ConfigError) {
    return {
      exitCode: exitCodes.config,
      stderr: [
        "Config error.",
        `Attempted: read ${error.path}`,
        `Failure: ${error.message}`,
        "Next step: fix the JSON config or move it aside.",
        "",
      ].join("\n"),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: exitCodes.config,
    stderr: [
      "Config error.",
      "Attempted: load ask configuration",
      `Failure: ${message}`,
      "Next step: run with a valid JSON config file.",
      "",
    ].join("\n"),
  };
}
