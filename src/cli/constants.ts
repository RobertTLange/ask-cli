export const packageName = "@roberttlange/ask-cli";
export const packageVersion = "0.1.0";

export const exitCodes = {
  success: 0,
  usage: 1,
  resolution: 2,
  collection: 3,
  agent: 4,
  config: 5,
  interrupted: 130,
} as const;

export const defaultConfig = {
  agent: "auto",
  ecosystem: "auto",
  allowHelpExec: true,
  noExec: false,
  json: false,
  debug: false,
  verbose: false,
  usage: false,
  keepWorkspace: false,
  refresh: false,
  maxFiles: 200,
  maxBytes: 8_388_608,
  agentTimeout: 600,
  reasoningEffort: undefined,
  headlessPath: undefined,
  headlessExtraFlags: [],
  packageRoot: undefined,
  executable: undefined,
} as const;

export const helpText = `ask <command> <question>

Positional:
  command                       CLI to ask about
  question                      natural-language question (quote it)

Selection:
  --ecosystem <e>               python|npm|cargo|homebrew|fallback|auto (default: auto)
  --package-root <path>         override resolver; use this directory as package root
  --executable <path>           override located executable

Execution control:
  --no-exec                     do not run any subprocesses during collection
  --allow-help-exec             permit help/version subprocesses (default: on)

Agent:
  --agent <a>                   auto|codex|claude|cursor|gemini|opencode|pi|none (default: auto)
  --agent-timeout <seconds>     default: 600
  --reasoning-effort <level>    low|medium|high|xhigh

Output:
  --json                        emit JSON to stdout instead of human output
  --debug                       write full trace to stderr
  --usage                       include Headless usage accounting when available
  --verbose                     print the exact prompt sent to the agent to stderr
  --keep-workspace              do not delete the staged workspace on exit

Limits:
  --max-files <n>               default: 200
  --max-bytes <n>               default: 8388608

Cache:
  --refresh                     ignore cache; re-resolve and re-collect

Misc:
  -h, --help                    show help
  --version                     show ask version`;
