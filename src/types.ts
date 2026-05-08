export interface ShimInfo {
  readonly kind: "pyenv" | "asdf" | "nvm";
  readonly version: string | null;
  readonly resolvedVia: string;
}

export interface LocatedExecutable {
  readonly command: string;
  readonly path: string;
  readonly realPath: string;
  readonly symlinkChain: readonly string[];
  readonly shebang: string | null;
  readonly executableKind: "script" | "elf" | "mach-o" | "unknown";
  readonly mtimeNs: bigint;
  readonly shim: ShimInfo | null;
}

export type Ecosystem = "python" | "npm" | "cargo" | "homebrew" | "fallback";
export type Confidence = "high" | "medium" | "low";

export interface Resolution {
  readonly command: string;
  readonly executablePath: string;
  readonly executableRealPath: string;
  readonly executableMtimeNs: bigint;
  readonly ecosystem: Ecosystem;
  readonly packageName: string | null;
  readonly version: string | null;
  readonly packageRoot: string | null;
  readonly entryFile: string | null;
  readonly metadataFiles: readonly string[];
  readonly confidence: Confidence;
  readonly warnings: readonly string[];
  readonly shim: ShimInfo | null;
}

export type FileKind =
  | "readme"
  | "docs"
  | "changelog"
  | "source"
  | "test"
  | "example"
  | "parser"
  | "config"
  | "env"
  | "completion";

export interface FileRef {
  readonly path: string;
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly kind: FileKind;
}

export interface HelpOutput {
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface ContextBundle {
  readonly resolution: Resolution;
  readonly helpOutputs: readonly HelpOutput[];
  readonly files: readonly FileRef[];
  readonly totalBytes: number;
  readonly warnings: readonly string[];
}

export interface Uncertainty {
  readonly code: string;
  readonly message: string;
}

export interface AgentRequest {
  readonly workspacePath: string;
  readonly question: string;
  readonly resolution?: Resolution;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly debug?: boolean;
  readonly usage?: boolean;
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "agent_trace"; readonly text: string }
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "citation";
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly kind: string;
    }
  | { readonly type: "error"; readonly message: string; readonly fatal: boolean }
  | { readonly type: "done"; readonly exitCode: number };

export interface Resolver {
  canResolve(located: LocatedExecutable): boolean;
  resolve(located: LocatedExecutable): Promise<Resolution>;
}

export interface Limits {
  readonly maxFiles: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
  readonly helpTimeoutMs: number;
  readonly helpStdoutBytes: number;
  readonly subcommandHelpLimit: number;
}

export interface Collector {
  collect(resolution: Resolution, limits: Limits): Promise<ContextBundle>;
}

export interface Agent {
  answer(req: AgentRequest): AsyncIterable<AgentEvent>;
}
