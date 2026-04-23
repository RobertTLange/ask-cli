import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

export type SandboxFailureReason =
  | "non_zero_exit"
  | "timeout"
  | "stdout_limit"
  | "stderr_limit"
  | "spawn_error"
  | null;

export interface SandboxOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface SandboxResult {
  readonly ok: boolean;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly failureReason: SandboxFailureReason;
  readonly failureMessage: string | null;
}

interface Accumulator {
  append(chunk: Buffer): boolean;
  text(): string;
  readonly truncated: boolean;
}

export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const startedAt = performance.now();
  const command = [options.command, ...(options.args ?? [])];
  const workingDirectory = options.cwd ?? (await mkdtemp(join(tmpdir(), "ask-sandbox-")));
  const shouldRemoveCwd = options.cwd === undefined;
  const stdout = createAccumulator(options.stdoutBytes);
  const stderr = createAccumulator(options.stderrBytes);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);

  let failureReason: SandboxFailureReason = null;
  let failureMessage: string | null = null;
  let childPid: number | undefined;

  try {
    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(options.command, options.args ?? [], {
        cwd: workingDirectory,
        env: sandboxEnv(options.env),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal: timeoutSignal,
      });

      childPid = child.pid;

      timeoutSignal.addEventListener(
        "abort",
        () => {
          failureReason = "timeout";
          failureMessage = `timed out after ${options.timeoutMs}ms`;
          killProcessGroup(childPid);
        },
        { once: true },
      );

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!stdout.append(chunk)) {
          failureReason = "stdout_limit";
          failureMessage = `stdout exceeded ${options.stdoutBytes} bytes`;
          killProcessGroup(childPid);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (!stderr.append(chunk)) {
          failureReason = "stderr_limit";
          failureMessage = `stderr exceeded ${options.stderrBytes} bytes`;
          killProcessGroup(childPid);
        }
      });

      child.on("error", (error) => {
        if (failureReason === "timeout") {
          return;
        }

        failureReason = "spawn_error";
        failureMessage = error.message;
      });

      child.on("close", (exitCode, signal) => {
        const resultFailure = resultFailureFor(exitCode, failureReason, failureMessage);
        resolve({
          ok: resultFailure.reason === null,
          command,
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode,
          signal,
          durationMs: Math.round(performance.now() - startedAt),
          timedOut: resultFailure.reason === "timeout",
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          failureReason: resultFailure.reason,
          failureMessage: resultFailure.message,
        });
      });
    });
  } finally {
    if (shouldRemoveCwd) {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

function createAccumulator(limitBytes: number): Accumulator {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let wasTruncated = false;

  return {
    append(chunk: Buffer): boolean {
      if (wasTruncated) {
        return false;
      }

      const remainingBytes = limitBytes - totalBytes;
      if (chunk.byteLength > remainingBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, remainingBytes)));
        totalBytes = limitBytes;
        wasTruncated = true;
        return false;
      }

      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      return true;
    },
    text(): string {
      return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    },
    get truncated(): boolean {
      return wasTruncated;
    },
  };
}

function sandboxEnv(extraEnv: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    LANG: "C.UTF-8",
    ...extraEnv,
  };
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
}

function resultFailureFor(
  exitCode: number | null,
  reason: SandboxFailureReason,
  message: string | null,
): { reason: SandboxFailureReason; message: string | null } {
  if (reason !== null) {
    return { reason, message };
  }

  if (exitCode !== 0) {
    return {
      reason: "non_zero_exit",
      message: `process exited with code ${exitCode}`,
    };
  }

  return { reason: null, message: null };
}
