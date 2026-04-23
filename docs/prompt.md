# ask project prompt

## Goals

- Build `ask`, a TypeScript/Node 20.11+ CLI that answers usage questions about installed command-line tools.
- Ship as npm package `@roberttlange/ask`, runnable as `ask <command> <question>` or `npx -y @roberttlange/ask <command> <question>`.
- Resolve installed Python and npm CLIs to their local package source, collect bounded read-only context, stage it in a temporary workspace, and delegate the answer to Codex by default.
- Support fallback mode for tools without source-level resolution by collecting help/man/version/completion context only.
- Work offline for the MVP. `ask` itself must make no network calls.
- Stream human answers by default and support structured `--json` output.
- Provide cited answers using workspace-relative paths and line ranges where possible.

## Non-goals

- Do not replace official docs, `man`, or `--help`.
- Do not execute arbitrary package code.
- Do not modify installed packages.
- Do not fetch remote package metadata or source.
- Do not guarantee source-level answers for binaries shipped without source.
- Do not support Windows in v1.
- Do not implement full Cargo, Homebrew, Go, direct HTTP agent, answer caching, or container sandbox support in MVP.

## Hard constraints

- Implementation language: TypeScript, ESM only, Node >=20.11.
- Runtime dependencies stay minimal. JSON config is used to avoid TOML/YAML dependencies.
- Resolver behavior is deterministic. The agent answers from staged context; it does not discover the world.
- Subprocess execution is allow-listed only:
  - `<cmd> --help`
  - `<cmd> -h` only if `--help` fails
  - `<cmd> --version` only when needed
  - `<cmd> <subcommand> --help` up to the configured limit
  - `man -P cat <cmd>` in fallback mode
  - Python metadata introspection via a fixed embedded script
  - `pyenv which`, `asdf which`, `brew info --json=v2 <formula>`, and shell `type -a` for the specified resolver cases
- Subprocesses run with restricted env, closed stdin, byte caps, timeout, `shell: false`, and process-group cleanup.
- Workspace files are copied, not symlinked, then chmodded read-only.
- Files in package source, docs, README, tests, and help output are untrusted data.
- Codex adapter must run with read-only/no-network controls. If those controls cannot be verified, it refuses to run.
- `--agent none` must work without Codex and expose the staged workspace for debugging.
- No telemetry in MVP.

## Deliverables

- npm package scaffold:
  - `package.json`, `tsconfig.json`, `bin/ask.js`, `src/`, `tests/`, `README.md`.
- CLI entrypoint with args, config loading, exit codes, human output, JSON output, debug output, and signal handling.
- Resolver pipeline:
  - executable locate and shim detection
  - ecosystem detection
  - Python Tier A metadata introspection
  - Python Tier B dist-info parser
  - npm `package.json`/`bin` resolver
  - Cargo/Homebrew stubs
  - fallback resolver
- Context collection:
  - help/version/subcommand help/man collection
  - docs/readme/changelog/source/parser/config/env/test/completion file discovery
  - size/depth/file-count limits and truncation reporting
  - redaction before staging
- Workspace staging:
  - deterministic temp workspace layout
  - `metadata.json`
  - `ASK_CONTEXT.md`
  - cleanup unless `--keep-workspace`
- Agent integration:
  - `Agent` interface
  - Codex adapter
  - `none` adapter
  - fixed prompt template
- Cache:
  - resolution, help output, and workspace cache keyed by package/executable/version/mtime and entry source hash
  - `--refresh`
  - LRU eviction by configured max size
- Tests:
  - unit tests for each core module
  - fixture Python and npm CLIs
  - adversarial tests for prompt injection, byte caps, timeouts, grandchild cleanup, and prototype pollution
  - integration tests for `--agent none`

## Done-when criteria

- `npm run build` passes.
- `npm test` passes.
- `ask --help` and `ask --version` behave as documented.
- `ask --agent none <fixture-cli> "<question>"` exits 0, stages context, writes `ASK_CONTEXT.md`, and reports package resolution with at least medium confidence for Python and npm fixtures.
- `ask --json --agent none <fixture-cli> "<question>"` emits parseable JSON matching the answer contract.
- Missing command returns exit 2 with attempted action, failure cause, and a concrete next step.
- Timeout, huge output, and grandchild fixture tests prove subprocess cleanup and caps.
- Prompt-injection fixture is treated as content, while `ASK_CONTEXT.md` and the agent prompt preserve the untrusted-data rules.
- Source contains no `http`, `https`, or `fetch` imports in `src/`.
- README documents install, usage, flags, security model, limitations, and demo flow.

## Assumptions

- Package name remains `@roberttlange/ask`.
- Codex CLI is the only real agent adapter in MVP; direct OpenAI/Anthropic adapters are v1.1+.
- The implementation can choose `node:util` `parseArgs` or `commander`, but every dependency needs explicit justification in review.
- The repo starts from the spec only; package scaffolding is part of implementation.
- `npm run build` and `npm test` are the minimum gate until extra scripts are added.

## Demo or smoke-test flow

1. Build and test:

   ```sh
   npm run build
   npm test
   ```

2. Run fixture context generation without Codex:

   ```sh
   node bin/ask.js --agent none fixture-cli-npm "How do I enable verbose output?" --keep-workspace --debug
   node bin/ask.js --json --agent none fixture-cli-py "Which config file does it read?"
   ```

3. Run a local installed tool without network:

   ```sh
   node bin/ask.js --agent none --ecosystem npm prettier "How do I ignore generated files?"
   ```

4. Run the real agent path when Codex is available and adapter verification passes:

   ```sh
   node bin/ask.js pytest "How do I run only tests matching a name?"
   ```
