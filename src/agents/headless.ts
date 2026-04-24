import { spawn } from "node:child_process";
import type { Agent, AgentEvent, AgentRequest } from "../types.js";

export type HeadlessBackend = "codex" | "claude" | "cursor" | "gemini" | "opencode" | "pi";

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

export class HeadlessAgent implements Agent {
  constructor(private readonly backend?: HeadlessBackend) {}

  async *answer(req: AgentRequest): AsyncIterable<AgentEvent> {
    yield* streamHeadless(this.backend, req);
  }
}

function headlessArgs(backend: HeadlessBackend | undefined, req: AgentRequest): string[] {
  return [
    "-y",
    "@roberttlange/headless",
    ...(backend ? [backend] : []),
    ...(req.debug ? ["--debug"] : []),
    "--allow",
    "read-only",
    "--work-dir",
    req.workspacePath,
    "--prompt",
    req.prompt,
  ];
}

async function* streamHeadless(
  backend: HeadlessBackend | undefined,
  req: AgentRequest,
): AsyncIterable<AgentEvent> {
  type QueueEvent =
    | { readonly type: "agent_trace"; readonly text: string }
    | { readonly type: "close"; readonly exitCode: number };

  const queue: QueueEvent[] = [];
  let wakeQueue: (() => void) | null = null;
  const pushQueue = (event: QueueEvent): void => {
    queue.push(event);
    wakeQueue?.();
    wakeQueue = null;
  };
  const nextQueueEvent = async (): Promise<QueueEvent> => {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wakeQueue = resolve;
      });
    }

    const event = queue.shift();
    if (!event) {
      throw new Error("headless queue wake without event");
    }
    return event;
  };

  const child = spawn("npx", headlessArgs(backend, req), {
    cwd: req.workspacePath,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnErrorMessage: string | null = null;
  let timedOut = false;
  let settled = false;
  let pendingDebugTrace = "";
  let reachedFinalMessage = false;
  const pushDebugTrace = (text: string): void => {
    for (const chunk of headlessDebugTraceChunks(text)) {
      pushQueue({ type: "agent_trace", text: chunk });
    }
  };
  const flushDebugTrace = (): void => {
    if (!req.debug || reachedFinalMessage || !pendingDebugTrace) {
      return;
    }

    pushQueue({ type: "agent_trace", text: pendingDebugTrace });
    pendingDebugTrace = "";
  };
  const finish = (exitCode: number): void => {
    if (settled) {
      return;
    }

    settled = true;
    flushDebugTrace();
    pushQueue({ type: "close", exitCode });
  };
  const timeout = req.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, req.timeoutMs)
    : null;

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (req.debug) {
      pushDebugTrace(text);
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    spawnErrorMessage = error.message;
    finish(127);
  });
  child.on("close", (code) => finish(code ?? 1));

  let exitCode = 1;
  while (true) {
    const event = await nextQueueEvent();
    if (event.type === "agent_trace") {
      yield event;
      continue;
    }

    exitCode = event.exitCode;
    break;
  }

  if (timeout) {
    clearTimeout(timeout);
  }
  if (spawnErrorMessage) {
    yield {
      type: "error",
      message: `failed to launch Headless: ${spawnErrorMessage}`,
      fatal: true,
    };
  } else if (timedOut) {
    yield {
      type: "error",
      message: `headless timed out after ${Math.ceil(req.timeoutMs / 1_000)}s`,
      fatal: true,
    };
  } else if (exitCode !== 0) {
    yield { type: "error", message: stderr || `headless exited ${exitCode}`, fatal: true };
  } else if (stdout) {
    if (req.debug) {
      const output = splitHeadlessDebugOutput(stdout);
      yield { type: "text", text: output.answer || stdout };
    } else {
      yield { type: "text", text: stdout };
    }
  }
  yield { type: "done", exitCode };

  function headlessDebugTraceChunks(text: string): string[] {
    if (reachedFinalMessage) {
      return [];
    }

    const marker = "--- final message ---";
    pendingDebugTrace += text;
    const markerIndex = pendingDebugTrace.indexOf(marker);
    if (markerIndex !== -1) {
      reachedFinalMessage = true;
      const trace = pendingDebugTrace.slice(0, markerIndex);
      pendingDebugTrace = "";
      return trace ? [trace] : [];
    }

    const retainedLength = marker.length - 1;
    if (pendingDebugTrace.length <= retainedLength) {
      return [];
    }

    const chunk = pendingDebugTrace.slice(0, -retainedLength);
    pendingDebugTrace = pendingDebugTrace.slice(-retainedLength);
    return chunk ? [chunk] : [];
  }
}

function splitHeadlessDebugOutput(stdout: string): {
  readonly trace: string;
  readonly answer: string;
} {
  const marker = "--- final message ---";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    return { trace: stdout, answer: "" };
  }

  return {
    trace: stdout.slice(0, markerIndex),
    answer: stdout.slice(markerIndex + marker.length).trim(),
  };
}
