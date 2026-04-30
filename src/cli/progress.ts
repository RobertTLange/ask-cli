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

const ansi = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

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

function formatClockTime(date: Date): string {
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((part) => String(part).padStart(2, "0")).join(":");
}
