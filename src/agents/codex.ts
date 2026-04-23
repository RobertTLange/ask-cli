import { spawn } from "node:child_process";
import { findOnPath } from "../resolvers/locate.js";
import { runSandbox } from "../sandbox.js";
import type { Agent, AgentEvent, AgentRequest } from "../types.js";

export class AgentError extends Error {
  readonly attempted: string;
  readonly nextStep: string;

  constructor(message: string, attempted: string, nextStep: string) {
    super(message);
    this.name = "AgentError";
    this.attempted = attempted;
    this.nextStep = nextStep;
  }
}

export class CodexAgent implements Agent {
  async *answer(req: AgentRequest): AsyncIterable<AgentEvent> {
    const codex = await findOnPath("codex", process.env.PATH);
    if (!codex) {
      throw new AgentError(
        "codex was not found on PATH",
        "launch Codex agent",
        "install Codex CLI or run with --agent none",
      );
    }

    const verification = await verifyCodexControls(codex);
    if (!verification.ok) {
      throw new AgentError(
        verification.reason,
        "verify Codex read-only/no-network controls",
        "run with --agent none or upgrade Codex CLI to a version with verifiable no-network controls",
      );
    }

    yield* streamCodex(codex, req);
  }
}

export async function verifyCodexControls(codexPath: string): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await runSandbox({
    command: codexPath,
    args: ["exec", "--help"],
    timeoutMs: 2_000,
    stdoutBytes: 65_536,
    stderrBytes: 65_536,
  });

  const help = `${result.stdout}\n${result.stderr}`;
  if (!result.ok) {
    return { ok: false, reason: "unable to inspect Codex CLI help output" };
  }

  const hasReadOnly = help.includes("--sandbox <SANDBOX_MODE>") && help.includes("read-only");
  const hasApprovalNever = help.includes("--ask-for-approval") && help.includes("never");
  const hasNetworkDisable = /--no-(network|search)|network\s*=\s*false|disable.*network/i.test(help);

  if (!hasReadOnly || !hasApprovalNever) {
    return { ok: false, reason: "Codex CLI read-only controls could not be verified" };
  }

  if (!hasNetworkDisable) {
    return { ok: false, reason: "Codex CLI does not expose a verifiable no-network control" };
  }

  return { ok: true };
}

async function* streamCodex(codexPath: string, req: AgentRequest): AsyncIterable<AgentEvent> {
  const child = spawn(codexPath, [
    "exec",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--cd",
    req.workspacePath,
    "--skip-git-repo-check",
    "--ephemeral",
    req.prompt,
  ], {
    cwd: req.workspacePath,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (stdout) {
    yield { type: "text", text: stdout };
  }
  if (exitCode !== 0) {
    yield { type: "error", message: stderr || `codex exited ${exitCode}`, fatal: true };
  }
  yield { type: "done", exitCode };
}
