<p align="center">
  <img src="docs/logo.png" alt="ask-cli command context resolver" width="420" style="border-radius: 24px;" />
</p>

<h1 align="center">ask-cli</h1>

<p align="center">
  Ask usage questions about installed command-line tools from their local package context.
</p>

<p align="center">
  <img alt="Node.js 20.11+" src="https://img.shields.io/badge/Node.js-20.11%2B-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white" />
  <img alt="npm package" src="https://img.shields.io/badge/npm-%40roberttlange%2Fask--cli-CB3837?logo=npm&logoColor=white" />
</p>

`ask` resolves a CLI command to the package that installed it, stages a small read-only context bundle, and asks a coding agent to answer from that bundle. It is built for the moments where `tool --help` is not enough and generic web answers are too far away from the version installed on your machine.

By default, `ask` runs Headless with the first available supported agent. Pass `--agent none` to inspect the resolved context without calling an agent.

## Quick Start

### With npx

```bash
npx -y @roberttlange/ask-cli prettier "How do I ignore generated files?"
```

### Global install

```bash
npm install -g @roberttlange/ask-cli
ask prettier "How do I ignore generated files?"
```

## 60-Second Usage

```bash
# Ask about an installed CLI using the default agent.
ask zod "What does this package do?"

# Pick a specific Headless backend.
ask --agent codex prettier "How do I ignore generated files?"

# Resolve and stage context without running an agent.
ask --agent none fixture-cli-npm "How do I enable JSON output?"

# Emit machine-readable output.
ask --json --agent none fixture-cli-py "Which config file does it read?"

# Keep the staged workspace for inspection.
ask --agent none --keep-workspace ruff "Where are lint rules configured?"

# Force an ecosystem resolver when auto-detection is ambiguous.
ask --ecosystem npm prettier "How is config discovered?"

# Skip help/version subprocess collection.
ask --no-exec pip "Where does it read configuration?"

# Print the exact agent prompt for debugging.
ask --verbose --agent none fixture-cli-npm "How do I enable verbose output?"

# Bypass cached context collection.
ask --refresh cargo-nextest "How do I run one test?"
```

## What ask Stages

`ask` creates a temporary workspace containing `ASK_CONTEXT.md` plus selected local package files. The staged bundle can include README files, docs, changelogs, source files, tests, examples, parser/config files, completion scripts, package metadata, and bounded help/version output.

The agent sees that staged workspace as its working directory and receives a prompt that includes the resolved command, package metadata, and the user question.

## Supported Ecosystems

| Ecosystem | Resolution source |
| --- | --- |
| `npm` | package metadata, bin entries, source files under `node_modules` |
| `python` | entry points, dist-info metadata, import package files |
| `cargo` | local target builds and Cargo registry cache metadata |
| `homebrew` | Cellar package metadata, receipts, formula files, script wrappers |
| `fallback` | executable path, shebang, nearby files, bounded help output |

Use `--ecosystem <name>` to override auto-detection.

## Supported Agents

`ask` delegates agent execution to [Headless](https://www.npmjs.com/package/@roberttlange/headless) and runs it in read-only mode against the staged workspace.

| Agent | `--agent` value |
| --- | --- |
| Automatic Headless selection | `auto` |
| Codex | `codex` |
| Claude Code | `claude` |
| Cursor | `cursor` |
| Gemini CLI | `gemini` |
| OpenCode | `opencode` |
| Pi | `pi` |
| No agent, context only | `none` |

When no agent is specified, Headless chooses the first installed backend it supports.

## Output Modes

### 1) Human mode (default)

Human mode prints a resolution summary followed by the agent answer.

```bash
ask prettier "How do I ignore generated files?"
```

### 2) JSON mode (`--json`)

JSON mode prints the command, question, compact resolution metadata, answer, citations, warnings, and optional debug trace.

```bash
ask --json --agent none fixture-cli-npm "How do I enable JSON output?"
```

### 3) Debug mode (`--debug`)

Debug mode writes resolver, cache, collection, and agent trace details to stderr while preserving the normal answer output on stdout.

```bash
ask --debug prettier "How is config resolved?"
```

### 4) Context-only mode (`--agent none`)

Context-only mode resolves the command, collects package context, writes the staged workspace path, and exits without launching Headless.

```bash
ask --agent none --keep-workspace zod "What does this package do?"
```

## CLI Reference

```bash
ask <command> <question> [options]
```

Options:

- `--ecosystem <e>`: resolver override, one of `python`, `npm`, `cargo`, `homebrew`, `fallback`, or `auto`.
- `--package-root <path>`: use this directory as the package root.
- `--executable <path>`: use this executable path instead of resolving `command` from `PATH`.
- `--no-exec`: skip subprocess collection.
- `--allow-help-exec`: permit help/version subprocess collection.
- `--agent <a>`: one of `auto`, `codex`, `claude`, `cursor`, `gemini`, `opencode`, `pi`, or `none`.
- `--agent-timeout <seconds>`: agent timeout. Defaults to `600`.
- `--json`: emit JSON to stdout.
- `--debug`: write full trace output to stderr.
- `--verbose`: print the exact prompt sent to the agent to stderr.
- `--keep-workspace`: preserve the staged workspace on exit.
- `--max-files <n>`: maximum staged file count. Defaults to `200`.
- `--max-bytes <n>`: maximum staged byte count. Defaults to `8388608`.
- `--refresh`: bypass cached context and collect again.
- `-h`, `--help`: show usage.
- `--version`: show the installed version.

## Configuration

`ask` reads optional defaults from:

```text
$XDG_CONFIG_HOME/ask/config.json
```

When `XDG_CONFIG_HOME` is unset, it falls back to:

```text
~/.config/ask/config.json
```

Example:

```json
{
  "defaults": {
    "agent": "codex",
    "ecosystem": "auto",
    "maxFiles": 200,
    "agentTimeout": 600
  }
}
```

CLI flags override config defaults.

## Security Model

`ask` treats package source, README files, tests, docs, metadata, and help output as untrusted data. Subprocess collection uses an allow-list, closed stdin, `shell: false`, restricted environment, byte caps, timeouts, and process-group cleanup.

Staged workspaces copy files instead of symlinking them, redact common secrets, and chmod staged files read-only. The default Headless adapter runs with `--allow read-only`. Use `--agent none` to inspect the staged context without running any agent.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | usage error |
| `2` | resolution failed |
| `3` | context collection failed |
| `4` | agent failed |
| `5` | config error |
| `130` | interrupted |

## Development

```bash
npm install
npm run build
npm test
```

`npm test` builds the package and runs the Node test suite. The package exports one binary, `ask`, from `bin/ask.js`.

## Layout

```text
bin/ask.js              CLI binary entrypoint
src/cli/                CLI parsing, config, execution
src/resolvers/          executable and package resolution
src/collectors/         bounded context collection
src/workspace/          staged read-only workspace creation
src/agents/             Headless and context-only adapters
src/cache/              local context cache
tests/                  resolver, collector, workspace, CLI coverage
docs/logo.png           README image
```
