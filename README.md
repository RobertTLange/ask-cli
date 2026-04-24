# ask

`ask` answers usage questions about installed command-line tools by resolving the command to local package context, staging a read-only workspace, and asking an agent to answer from that workspace.

## Install

```sh
npm install -g @roberttlange/ask
```

Or run without installing:

```sh
npx -y @roberttlange/ask <command> <question>
```

## Usage

```sh
ask <command> <question>
ask --agent none prettier "How do I ignore generated files?"
ask --json --agent none fixture-cli-npm "How do I enable json output?"
```

`--agent none` stages context and prints the workspace path plus `ASK_CONTEXT.md` without calling Codex.

## Flags

- `--ecosystem <e>`: `python|npm|cargo|homebrew|fallback|auto`
- `--package-root <path>`: override package root
- `--executable <path>`: override executable path
- `--no-exec`: skip help/version subprocess collection
- `--allow-help-exec`: permit help/version collection
- `--agent <a>`: `codex|none`
- `--agent-timeout <seconds>`: default `120`
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

The MVP itself makes no network calls. The Codex adapter runs `codex exec` with the documented read-only sandbox, a staged workspace root, and no `--search` flag. Use `--agent none` to inspect staged context without any agent.

## Limitations

Python and npm CLIs have native MVP resolution. Cargo and Homebrew currently use fallback help/man/version context. Windows, remote package lookup, container sandboxing, answer caching, Go/Homebrew source extraction, and direct HTTP model adapters are outside the MVP.

## Demo

```sh
npm run build
npm test
node bin/ask.js --agent none fixture-cli-npm "How do I enable verbose output?" --keep-workspace --debug
node bin/ask.js --json --agent none fixture-cli-py "Which config file does it read?"
node bin/ask.js --agent none --ecosystem npm prettier "How do I ignore generated files?"
```
