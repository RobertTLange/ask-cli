import { helpText, packageVersion, exitCodes } from "./constants.js";
import { ConfigError, loadConfig } from "./config.js";
import { parseInvocation, UsageError, type ParsedInvocation } from "./args.js";
import { collectContext } from "../collectors/context.js";
import { defaultLimits } from "../collectors/limits.js";
import { ProgressFormatter } from "./progress.js";
import { AgentError, HeadlessAgent, type HeadlessBackend } from "../agents/headless.js";
import { NoneAgent } from "../agents/none.js";
import { buildAgentPrompt } from "../agents/prompt.js";
import { CacheStore, cacheKeyForResolution } from "../cache/store.js";
import { AskError } from "../errors.js";
import { detectEcosystem } from "../resolvers/ecosystem.js";
import { resolveCargoPackage } from "../resolvers/cargo.js";
import { resolveGenericFallback } from "../resolvers/fallback.js";
import { resolveHomebrewPackage } from "../resolvers/homebrew.js";
import { locateExecutable } from "../resolvers/locate.js";
import { resolveNpmPackage } from "../resolvers/npm.js";
import { resolvePythonPackage } from "../resolvers/python.js";
import { Trace } from "../trace.js";
import type { Resolution } from "../types.js";
import { stageWorkspace } from "../workspace/stage.js";

type DiagnosticWriter = (text: string) => void;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await run(argv, (text) => process.stderr.write(text));

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

export async function run(argv: string[], diagnosticWriter?: DiagnosticWriter): Promise<RunResult> {
  let config;
  let bufferedDiagnostics = "";
  const emitDiagnostic = (text: string): void => {
    if (diagnosticWriter) {
      diagnosticWriter(text);
      return;
    }

    bufferedDiagnostics += text;
  };

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
        return withBufferedDiagnostics(await runQuestion(invocation, emitDiagnostic), bufferedDiagnostics);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return withBufferedDiagnostics({
        exitCode: exitCodes.usage,
        stderr: [
          `Usage error: ${error.message}`,
          "",
          helpText,
          "",
        ].join("\n"),
      }, bufferedDiagnostics);
    }

    if (error instanceof AskError) {
      return withBufferedDiagnostics(formatAskError(error), bufferedDiagnostics);
    }

    throw error;
  }
}

async function runQuestion(
  invocation: ParsedInvocation,
  emitDiagnostic: DiagnosticWriter,
): Promise<RunResult> {
  const trace = new Trace();
  const progress = new ProgressFormatter();
  const emitProgress = (message: string): void => emitDiagnostic(progress.format(message));
  const headlessProgressEnabled = invocation.config.agent !== "none" && !invocation.config.debug;
  if (headlessProgressEnabled) {
    emitProgress(`resolving ${invocation.command}`);
  }

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

  const resolution = await resolveForEcosystem(
    located,
    ecosystem.ecosystem,
    invocation.config.ecosystem === "auto",
  );

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

  if (headlessProgressEnabled) {
    emitProgress("collecting context");
  }

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

  let staged: Awaited<ReturnType<typeof stageWorkspace>> | null = null;
  let stagedReleased = false;
  const releaseStaged = async (): Promise<void> => {
    if (!staged || stagedReleased) {
      return;
    }

    stagedReleased = true;
    if (invocation.config.keepWorkspace) {
      await staged.release();
    } else {
      await staged.cleanup();
    }
  };

  try {
    staged = await stageWorkspace(bundle, { question: invocation.question });
    if (headlessProgressEnabled && invocation.config.keepWorkspace) {
      emitProgress(`staged workspace ${staged.path}`);
    }
    await cache.storeWorkspace(cacheKey, staged.path);
    await cache.evict(512);
    const prompt = buildAgentPrompt({
      command: invocation.command,
      question: invocation.question,
      resolution,
      workspacePath: staged.path,
    });
    if (invocation.config.verbose) {
      emitDiagnostic(formatVerbosePrompt(prompt));
    }

    const agent = invocation.config.agent === "none"
      ? new NoneAgent()
      : new HeadlessAgent(headlessBackend(invocation.config.agent), {
          command: invocation.config.headlessPath,
          extraFlags: invocation.config.headlessExtraFlags,
        });
    const answer = await collectAgentAnswer(agent.answer({
      workspacePath: staged.path,
      question: invocation.question,
      resolution,
      prompt,
      timeoutMs: invocation.config.agentTimeout * 1_000,
      debug: invocation.config.debug,
      usage: invocation.config.usage,
      reasoningEffort: invocation.config.reasoningEffort,
    }), headlessProgressEnabled || invocation.config.debug ? emitDiagnostic : undefined, progress);

    await releaseStaged();
    const parsedAnswer = splitUsageAnswer(answer.text, invocation.config.usage);

    if (answer.exitCode !== 0) {
      throw new AgentError(
        parsedAnswer.text || `agent exited with code ${answer.exitCode}`,
        "run agent",
        "run with --debug or --agent none to inspect the staged workspace",
      );
    }

    const stderr = invocation.config.debug ? trace.toDebugString() : undefined;
    return invocation.config.json
      ? jsonAnswer(invocation, resolution, parsedAnswer.text, staged.path, trace, stderr, parsedAnswer.usage)
      : {
          exitCode: exitCodes.success,
          stdout: [
            resolutionSummary(resolution),
            parsedAnswer.text,
            parsedAnswer.usage ? JSON.stringify({ usage: parsedAnswer.usage }) : "",
          ].join("\n"),
          stderr,
        };
  } catch (error) {
    await releaseStaged();

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

function headlessBackend(agent: ParsedInvocation["config"]["agent"]): HeadlessBackend | undefined {
  if (agent === "auto" || agent === "none") {
    return undefined;
  }

  return agent;
}

function splitUsageAnswer(answer: string, usageEnabled: boolean): {
  readonly text: string;
  readonly usage?: unknown;
} {
  if (!usageEnabled) {
    return { text: answer };
  }

  const lines = answer.trimEnd().split(/\r?\n/);
  let usageLineIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length > 0) {
      usageLineIndex = index;
      break;
    }
  }
  if (usageLineIndex === -1) {
    return { text: answer };
  }

  try {
    const parsed = JSON.parse(lines[usageLineIndex]) as unknown;
    if (!isRecord(parsed) || !Object.hasOwn(parsed, "usage")) {
      return { text: answer };
    }

    const answerLines = [
      ...lines.slice(0, usageLineIndex),
      ...lines.slice(usageLineIndex + 1),
    ];
    return {
      text: answerLines.join("\n").trimEnd(),
      usage: parsed.usage,
    };
  } catch {
    return { text: answer };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withBufferedDiagnostics(result: RunResult, diagnostics: string): RunResult {
  if (diagnostics.length === 0) {
    return result;
  }

  return {
    ...result,
    stderr: `${diagnostics}${result.stderr ?? ""}`,
  };
}

async function collectAgentAnswer(
  events: AsyncIterable<import("../types.js").AgentEvent>,
  emitAgentDiagnostic?: DiagnosticWriter,
  progress?: ProgressFormatter,
): Promise<{
  readonly text: string;
  readonly trace: string;
  readonly exitCode: number;
}> {
  let text = "";
  let trace = "";
  let exitCode = 0;
  let traceOpen = false;
  let lastTraceEndedWithNewline = true;

  for await (const event of events) {
    if (event.type === "text") {
      text += event.text;
    }
    if (event.type === "agent_trace") {
      trace += event.text;
      if (emitAgentDiagnostic) {
        if (!traceOpen) {
          emitAgentDiagnostic("----- ask agent trace -----\n");
          traceOpen = true;
        }
        emitAgentDiagnostic(event.text);
        lastTraceEndedWithNewline = event.text.endsWith("\n");
      }
    }
    if (event.type === "progress" && emitAgentDiagnostic) {
      emitAgentDiagnostic((progress ?? new ProgressFormatter()).format(event.message));
    }
    if (event.type === "error" && event.fatal) {
      text += event.message;
      exitCode = 1;
    }
    if (event.type === "done") {
      exitCode = event.exitCode;
    }
  }

  if (traceOpen && emitAgentDiagnostic) {
    emitAgentDiagnostic(`${lastTraceEndedWithNewline ? "" : "\n"}----- end ask agent trace -----\n\n`);
  }

  return { text, trace, exitCode };
}

function formatAgentTrace(trace: string): string {
  if (!trace) {
    return "";
  }

  return [
    "----- ask agent trace -----",
    trace.trimEnd(),
    "----- end ask agent trace -----",
    "",
  ].join("\n");
}

async function resolveForEcosystem(
  located: Awaited<ReturnType<typeof locateExecutable>>,
  ecosystem: Resolution["ecosystem"],
  allowFallbackUpgrade = false,
): Promise<Resolution> {
  switch (ecosystem) {
    case "python":
      return resolvePythonPackage(located);
    case "npm":
      return resolveNpmPackage(located);
    case "cargo":
      return resolveCargoPackage(located);
    case "homebrew":
      return resolveHomebrewPackage(located);
    case "fallback":
      if (allowFallbackUpgrade) {
        const pythonResolution = await resolvePythonPackage(located);
        if (pythonResolution.packageName !== null) {
          return pythonResolution;
        }
      }
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
  stderr: string | undefined,
  usage: unknown,
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
      usage,
      debug: invocation.config.debug ? { trace: trace.events(), workspacePath } : undefined,
    }, null, 2)}\n`,
    stderr,
  };
}

function formatVerbosePrompt(prompt: string): string {
  return [
    "----- ask agent prompt -----",
    prompt.trimEnd(),
    "----- end ask agent prompt -----",
    "",
  ].join("\n");
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
        "Next step: fix the TOML config or move it aside.",
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
      "Next step: run with a valid TOML config file.",
      "",
    ].join("\n"),
  };
}
