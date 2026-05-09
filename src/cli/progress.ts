interface ProgressClock {
  readonly label?: string;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly monotonicStartedAt?: number;
  readonly color?: boolean;
}

interface StderrLike {
  readonly isTTY?: boolean;
}

type ProgressWriter = (text: string) => void;

const ansi = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const spinnerFrames = ["|", "/", "-", "\\"];

export class ProgressFormatter {
  private readonly label: string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly monotonicStartedAt: number;
  private readonly color: boolean;

  constructor(options: ProgressClock = {}) {
    this.label = options.label ?? "ask";
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.monotonicStartedAt = options.monotonicStartedAt ?? this.monotonicNow();
    this.color = options.color ?? shouldColorProgress(process.stderr, process.env);
  }

  format(message: string): string {
    const timestamp = formatClockTime(this.now());
    const elapsedSeconds = Math.max(0, this.monotonicNow() - this.monotonicStartedAt) / 1_000;
    const prefix = `[${timestamp} +${elapsedSeconds.toFixed(1)}s] ${this.label}:`;
    if (!this.color) {
      return `${prefix} ${message}\n`;
    }

    return `${ansi.dim}[${timestamp} +${elapsedSeconds.toFixed(1)}s]${ansi.reset} ${ansi.cyan}${this.label}:${ansi.reset} ${message}\n`;
  }
}

export function shouldColorProgress(
  stderr: StderrLike = process.stderr,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined) {
    return forceColor !== "" && forceColor !== "0" && forceColor.toLowerCase() !== "false";
  }

  if (env.NO_COLOR !== undefined) {
    return false;
  }

  return Boolean(stderr.isTTY);
}

export function shouldSpinProgress(
  stderr: StderrLike = process.stderr,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(stderr.isTTY) && env.ASK_NO_SPINNER === undefined;
}

export class ProgressSpinner {
  private readonly emit: ProgressWriter;
  private readonly label: string;
  private readonly message: string;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private frameIndex = 0;
  private timer: NodeJS.Timeout | undefined;
  private active = false;

  constructor(options: {
    readonly emit: ProgressWriter;
    readonly label?: string;
    readonly message?: string;
    readonly intervalMs?: number;
    readonly enabled?: boolean;
  }) {
    this.emit = options.emit;
    this.label = options.label ?? "ask";
    this.message = options.message ?? "preparing";
    this.intervalMs = options.intervalMs ?? 120;
    this.enabled = options.enabled ?? shouldSpinProgress(process.stderr, process.env);
  }

  start(): void {
    if (!this.enabled || this.active) {
      return;
    }

    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.active = false;
    this.emit("\r\x1b[2K");
  }

  private render(): void {
    const frame = spinnerFrames[this.frameIndex % spinnerFrames.length];
    this.frameIndex += 1;
    this.emit(`\r${this.label}: ${this.message} ${frame}`);
  }
}

function formatClockTime(date: Date): string {
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((part) => String(part).padStart(2, "0")).join(":");
}
