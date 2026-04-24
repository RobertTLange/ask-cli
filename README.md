# ask-cli

`ask` answers usage questions about installed command-line tools by resolving the command to local package context, staging a read-only workspace, and asking an agent to answer from that workspace.

## Install

```sh
npm install -g @roberttlange/ask-cli
```

Or run without installing:

```sh
npx -y @roberttlange/ask-cli <command> <question>
```

## Usage

```sh
ask <command> <question>
ask --agent none prettier "How do I ignore generated files?"
ask --agent claude prettier "How do I ignore generated files?"
ask --json --agent none fixture-cli-npm "How do I enable json output?"
```

By default, `ask` calls `npx -y @roberttlange/headless` and lets Headless choose the first available coding agent. Use `--agent <name>` to pick a Headless backend, or `--agent none` to stage context and print the workspace path plus `ASK_CONTEXT.md` without calling an agent.

## Flags

- `--ecosystem <e>`: `python|npm|cargo|homebrew|fallback|auto`
- `--package-root <path>`: override package root
- `--executable <path>`: override executable path
- `--no-exec`: skip help/version subprocess collection
- `--allow-help-exec`: permit help/version collection
- `--agent <a>`: `auto|codex|claude|cursor|gemini|opencode|pi|none`
- `--agent-timeout <seconds>`: default `600`
- `--json`: emit JSON
- `--debug`: write trace events to stderr
- `--verbose`: print the exact prompt sent to the agent to stderr
- `--keep-workspace`: preserve staged workspace
- `--max-files <n>`: default `200`
- `--max-bytes <n>`: default `8388608`
- `--refresh`: bypass cache
- `--help`, `--version`

## Exit Codes

- `0`: success
- `1`: usage error
- `2`: resolution failed
- `3`: context collection failed
- `4`: agent failed
- `5`: config error
- `130`: interrupted

## Security Model

`ask` treats package source, README files, tests, and help output as untrusted data. Subprocess collection uses an allow-list, closed stdin, `shell: false`, restricted environment, byte caps, timeouts, and process-group cleanup. Workspaces copy files instead of symlinking them, redact common secrets, and chmod staged files read-only.

The MVP itself only makes network calls when npm needs to fetch the Headless package through `npx`. The Headless adapter runs the selected backend with `--allow read-only` and a staged workspace root. Use `--agent none` to inspect staged context without any agent.

## Limitations

Python and npm CLIs have native source-aware resolution. Cargo CLIs resolve local `target` builds and `cargo install` metadata when crate sources are present in the Cargo registry cache. Homebrew CLIs resolve Cellar package metadata, receipts, formula files, and script wrappers when available, but bottled binaries usually do not include upstream application source. Windows, remote package lookup, container sandboxing, answer caching, Go package resolution, and direct HTTP model adapters are outside the MVP.

## Demo

```sh
npm run build
npm test
node bin/ask.js --agent none fixture-cli-npm "How do I enable verbose output?" --keep-workspace --debug
node bin/ask.js --json --agent none fixture-cli-py "Which config file does it read?"
node bin/ask.js --agent none --ecosystem npm prettier "How do I ignore generated files?"
```
