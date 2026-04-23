export interface TraceEvent {
  readonly stage: string;
  readonly decision: string;
  readonly ruleMatched: string | null;
  readonly durationMs: number;
  readonly details?: Record<string, unknown>;
}

export class Trace {
  readonly #events: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.#events.push(event);
  }

  events(): readonly TraceEvent[] {
    return this.#events;
  }

  toDebugString(): string {
    return `${this.#events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }
}
