import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { helpText, packageVersion, exitCodes } from "./constants.js";
import { ConfigError, loadConfig } from "./config.js";
import { parseInvocation, UsageError, type ParsedInvocation, type ParsedRepositoryInvocation, type RunInvocation } from "./args.js";
import { cacheOptionsForInvocation } from "./cache-options.js";
import { collectContext } from "../collectors/context.js";
import { defaultLimits } from "../collectors/limits.js";
import { ProgressFormatter } from "./progress.js";
import { applyPackageRootOverride } from "./resolution-overrides.js";
import { buildUncertainty, formatUncertaintyBlock } from "./uncertainty.js";
import { AgentError, HeadlessAgent, type HeadlessBackend } from "../agents/headless.js";
import { NoneAgent } from "../agents/none.js";
import { buildAgentPrompt, buildRepositoryAgentPrompt } from "../agents/prompt.js";
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
import type { ContextBundle, Resolution, Uncertainty } from "../types.js";
import { checkoutGitRepository, GitRepositoryError, normalizeGitHubRepository } from "../repos/github.js";
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
  invocation: RunInvocation,
  emitDiagnostic: DiagnosticWriter,
): Promise<RunResult> {
  if (invocation.mode === "repo") {
    return runRepositoryQuestion(invocation, emitDiagnostic);
  }

  return runCommandQuestion(invocation, emitDiagnostic);
}

async function runCommandQuestion(
  invocation: ParsedInvocation,
  emitDiagnostic: DiagnosticWriter,
): Promise<RunResult> {
  const trace = new Trace();
  const headlessProgressEnabled = invocation.config.agent !== "none" && !invocation.config.debug;
  const progress = new ProgressFormatter({
    label: headlessProgressEnabled ? await progressLabel(invocation) : progressLabelFromConfig(invocation),
  });
  const emitProgress = (message: string): void => emitDiagnostic(progress.format(message));
  if (headlessProgressEnabled) {
    emitProgress(`resolving ${invocation.command}`);
  }

  const locateStartedAt = performance.now();
  const located = await locateExecutable(invocation.command, {
    executable: invocation.config.executable,
  });
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

  let resolution = await resolveForEcosystem(
    located,
    ecosystem.ecosystem,
    invocation.config.ecosystem === "auto",
  );
  resolution = await applyPackageRootOverride(resolution, invocation.config.packageRoot);
  const prompt = buildAgentPrompt({
    command: invocation.command,
    question: invocation.question,
    resolution,
    workspacePath: ".",
  });
  if (invocation.config.verbose) {
    emitDiagnostic(formatVerbosePrompt(prompt));
  }

  const cache = new CacheStore();
  const cacheOptions = cacheOptionsForInvocation(invocation);
  const cacheKey = await cacheKeyForResolution(resolution, cacheOptions);
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

    const uncertainty = buildUncertainty(resolution, bundle);
    const stderr = invocation.config.debug ? trace.toDebugString() : undefined;
    return invocation.config.json
      ? jsonAnswer(invocation, resolution, bundle, uncertainty, parsedAnswer.text, staged.path, trace, stderr, parsedAnswer.usage)
      : {
          exitCode: exitCodes.success,
          stdout: [
            resolutionSummary(resolution),
            formatUncertaintyBlock(uncertainty),
            parsedAnswer.text,
            parsedAnswer.usage ? JSON.stringify({ usage: parsedAnswer.usage }) : "",
          ].filter((part) => part.length > 0).join("\n"),
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

async function runRepositoryQuestion(
  invocation: ParsedRepositoryInvocation,
  emitDiagnostic: DiagnosticWriter,
): Promise<RunResult> {
  const trace = new Trace();
  const headlessProgressEnabled = invocation.config.agent !== "none" && !invocation.config.debug;
  const progress = new ProgressFormatter({
    label: headlessProgressEnabled ? await progressLabel(invocation) : progressLabelFromConfig(invocation),
  });
  const emitProgress = (message: string): void => emitDiagnostic(progress.format(message));
  if (headlessProgressEnabled) {
    emitProgress(`resolving repository ${invocation.repo}`);
  }

  const resolveStartedAt = performance.now();
  const repository = normalizeGitHubRepository(invocation.repo);
  trace.record({
    stage: "repository",
    decision: repository.slug,
    ruleMatched: "github",
    durationMs: Math.round(performance.now() - resolveStartedAt),
    details: { remoteUrl: repository.remoteUrl, ref: invocation.repoRef ?? null },
  });

  if (headlessProgressEnabled) {
    emitProgress("cloning repository context");
  }

  let checkout: Awaited<ReturnType<typeof checkoutGitRepository>> | null = null;
  let checkoutReleased = false;
  const releaseCheckout = async (): Promise<void> => {
    if (!checkout || checkoutReleased) {
      return;
    }

    checkoutReleased = true;
    if (invocation.config.keepWorkspace) {
      await checkout.release();
    } else {
      await checkout.cleanup();
    }
  };

  try {
    const checkoutStartedAt = performance.now();
    checkout = await checkoutGitRepository({
      repository,
      question: invocation.question,
      ref: invocation.repoRef,
      refresh: invocation.config.refresh,
    });
    trace.record({
      stage: "checkout",
      decision: checkout.commit,
      ruleMatched: checkout.requestedRef ?? "default",
      durationMs: Math.round(performance.now() - checkoutStartedAt),
      details: { cachePath: checkout.cachePath, workspacePath: checkout.workspacePath },
    });
    if (headlessProgressEnabled && invocation.config.keepWorkspace) {
      emitProgress(`staged workspace ${checkout.workspacePath}`);
    }

    const prompt = buildRepositoryAgentPrompt({
      repository: repository.slug,
      remoteUrl: repository.remoteUrl,
      question: invocation.question,
      requestedRef: checkout.requestedRef,
      resolvedRef: checkout.resolvedRef,
      commit: checkout.commit,
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
      workspacePath: checkout.workspacePath,
      question: invocation.question,
      prompt,
      timeoutMs: invocation.config.agentTimeout * 1_000,
      debug: invocation.config.debug,
      usage: invocation.config.usage,
      reasoningEffort: invocation.config.reasoningEffort,
    }), headlessProgressEnabled || invocation.config.debug ? emitDiagnostic : undefined, progress);

    await releaseCheckout();
    const parsedAnswer = splitUsageAnswer(answer.text, invocation.config.usage);

    if (answer.exitCode !== 0) {
      throw new AgentError(
        parsedAnswer.text || `agent exited with code ${answer.exitCode}`,
        "run agent",
        "run with --debug or --agent none --keep-workspace to inspect the staged repository workspace",
      );
    }

    const stderr = invocation.config.debug ? trace.toDebugString() : undefined;
    return invocation.config.json
      ? jsonRepositoryAnswer(invocation, checkout, parsedAnswer.text, trace, stderr, parsedAnswer.usage)
      : {
          exitCode: exitCodes.success,
          stdout: [
            repositorySummary(checkout),
            parsedAnswer.text,
            parsedAnswer.usage ? JSON.stringify({ usage: parsedAnswer.usage }) : "",
          ].filter((part) => part.length > 0).join("\n"),
          stderr,
        };
  } catch (error) {
    await releaseCheckout();

    if (error instanceof AgentError) {
      throw new AskError(
        error.message,
        exitCodes.agent,
        error.attempted,
        error.nextStep,
      );
    }

    if (error instanceof GitRepositoryError) {
      throw new AskError(
        error.message,
        exitCodes.resolution,
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

async function progressLabel(invocation: RunInvocation): Promise<string> {
  if (invocation.config.agent !== "auto") {
    return progressLabelFromConfig(invocation);
  }

  const resolved = await resolveHeadlessAutoIdentity(invocation);
  return progressLabelFromParts({
    agent: resolved.agent ?? invocation.config.agent,
    model: resolved.model ?? headlessModel(invocation.config.headlessExtraFlags),
    reasoningEffort: invocation.config.reasoningEffort ?? resolved.reasoningEffort,
  });
}

function progressLabelFromConfig(invocation: RunInvocation): string {
  return progressLabelFromParts({
    agent: invocation.config.agent,
    model: headlessModel(invocation.config.headlessExtraFlags),
    reasoningEffort: invocation.config.reasoningEffort,
  });
}

function progressLabelFromParts(parts: {
  readonly agent: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}): string {
  return `ask[${[
    parts.agent,
    parts.model,
    parts.reasoningEffort ?? "default",
  ].map(sanitizeProgressLabelPart).join("-")}]`;
}

async function resolveHeadlessAutoIdentity(invocation: RunInvocation): Promise<{
  readonly agent?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}> {
  const usesNpx = !invocation.config.headlessPath;
  const command = invocation.config.headlessPath || "npx";
  const args = [
    ...(usesNpx ? ["-y", "@roberttlange/headless"] : []),
    "--print-command",
    ...(invocation.config.reasoningEffort ? ["--reasoning-effort", invocation.config.reasoningEffort] : []),
    "--allow",
    "read-only",
    "--work-dir",
    process.cwd(),
    "--prompt",
    "identity",
    ...invocation.config.headlessExtraFlags,
  ];

  const resolved = parseHeadlessPrintCommand(await runHeadlessPrintCommand(command, args));
  return {
    ...resolved,
    reasoningEffort: resolved.reasoningEffort ?? await configuredReasoningEffort(resolved.agent),
  };
}

function runHeadlessPrintCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const settle = (output: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(output);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle("");
    }, 4_000);
    timeout.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => settle(""));
    child.on("close", (code) => settle(code === 0 ? stdout : ""));
  });
}

function parseHeadlessPrintCommand(command: string): {
  readonly agent?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
} {
  const agentMatch = command.match(/(?:^|\|\s*)(codex|claude|cursor|gemini|opencode|pi)\b/);
  const modelMatch = command.match(/(?:^|\s)--model(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const reasoningMatch = command.match(/model_reasoning_effort\s*=\s*\\?["']?([A-Za-z0-9_-]+)/);
  return {
    agent: agentMatch?.[1],
    model: modelMatch?.[1] ?? modelMatch?.[2] ?? modelMatch?.[3],
    reasoningEffort: reasoningMatch?.[1],
  };
}

async function configuredReasoningEffort(agent: string | undefined): Promise<string | undefined> {
  if (agent !== "codex") {
    return undefined;
  }

  const home = process.env.HOME || homedir();
  const config = await readFile(join(home, ".codex", "config.toml"), "utf8").catch(() => "");
  return config.match(/^\s*model_reasoning_effort\s*=\s*["']?([A-Za-z0-9_-]+)/m)?.[1];
}

function headlessModel(flags: readonly string[]): string {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--model") {
      return flags[index + 1] ?? "default";
    }

    if (flag.startsWith("--model=")) {
      return flag.slice("--model=".length) || "default";
    }
  }

  return "default";
}

function sanitizeProgressLabelPart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "default";
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

function repositorySummary(checkout: Awaited<ReturnType<typeof checkoutGitRepository>>): string {
  return [
    `Repository: ${checkout.repository.slug}`,
    `Ref: ${checkout.resolvedRef}`,
    `Commit: ${checkout.commit}`,
    `Workspace: ${checkout.workspacePath}`,
    `Warnings: ${checkout.warnings.length > 0 ? checkout.warnings.join("; ") : "none"}`,
    "",
  ].join("\n");
}

function jsonAnswer(
  invocation: ParsedInvocation,
  resolution: Resolution,
  bundle: ContextBundle,
  uncertainty: readonly Uncertainty[],
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
      uncertainty,
      warnings: [...resolution.warnings, ...bundle.warnings],
      usage,
      debug: invocation.config.debug ? { trace: trace.events(), workspacePath } : undefined,
    }, null, 2)}\n`,
    stderr,
  };
}

function jsonRepositoryAnswer(
  invocation: ParsedRepositoryInvocation,
  checkout: Awaited<ReturnType<typeof checkoutGitRepository>>,
  answer: string,
  trace: Trace,
  stderr: string | undefined,
  usage: unknown,
): RunResult {
  return {
    exitCode: exitCodes.success,
    stdout: `${JSON.stringify({
      repository: {
        input: invocation.repo,
        slug: checkout.repository.slug,
        remoteUrl: checkout.repository.remoteUrl,
        requestedRef: checkout.requestedRef,
        resolvedRef: checkout.resolvedRef,
        commit: checkout.commit,
      },
      question: invocation.question,
      answer,
      citations: [{ path: "ASK_CONTEXT.md", start: 1, end: 1, kind: "context" }],
      warnings: checkout.warnings,
      usage,
      debug: invocation.config.debug ? { trace: trace.events(), workspacePath: checkout.workspacePath } : undefined,
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
