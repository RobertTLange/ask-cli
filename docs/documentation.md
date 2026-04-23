# ask project documentation

## Current milestone status

- Planning pack generated from `docs/spec.md`.
- Implementation has not started.
- Current implementation milestone: Milestone 1, package scaffold and CLI shell.

## What is done now

- Product target is locked in `docs/spec.md`.
- Execution plan is defined in `docs/plan.md`.
- Implementation runbook is defined in `docs/implement.md`.
- MVP scope is constrained to TypeScript/Node 20.11+, Python/npm native resolution, Cargo/Homebrew stubs, fallback collection, read-only staging, Codex plus `none` agent, offline operation, and npm distribution.

## What is next

1. Scaffold the npm TypeScript project.
2. Add CLI arg parsing, config loading, help/version output, and exit-code mapping.
3. Add the initial test runner and first CLI tests.
4. Run Milestone 1 validation from `docs/plan.md`.

## Decisions made and why

- TypeScript on Node 20.11+ is fixed because the CLI is distributed through npm and must run through `npx`.
- ESM-only is fixed to match the spec and simplify package exports.
- `@roberttlange/ask` is the package name until the spec changes.
- Codex is the only real MVP agent adapter; `--agent none` is required for debug and testability.
- Python and npm are native MVP resolvers; Cargo and Homebrew are honest stubs.
- No network use is allowed in MVP because offline operation is a core goal.
- Resolver and collector stay deterministic; agent use is restricted to answering from staged context.
- Workspace staging copies files instead of symlinking to prevent escape from the staged tree.
- JSON config is used to keep runtime dependencies minimal.

## How to run and demo

The project is not scaffolded yet. After Milestone 1:

```sh
npm install
npm run build
npm test
node bin/ask.js --help
node bin/ask.js --version
```

After fixture CLIs and `--agent none` exist:

```sh
node bin/ask.js --agent none fixture-cli-npm "How do I enable verbose output?" --keep-workspace --debug
node bin/ask.js --json --agent none fixture-cli-py "Which config file does it read?"
```

After Codex adapter verification exists:

```sh
node bin/ask.js pytest "How do I run only tests matching a name?"
```

## Quick smoke tests

- `node bin/ask.js --help` prints usage and exits 0.
- `node bin/ask.js --version` prints package version and exits 0.
- `node bin/ask.js` returns exit 1 with a usage error.
- `node bin/ask.js --agent none definitely-not-a-real-command "help"` returns exit 2 with an actionable resolution error.
- `node bin/ask.js --json --agent none fixture-cli-npm "question"` emits parseable JSON.
- `node bin/ask.js --agent none fixture-cli-npm "question" --keep-workspace --debug` prints a workspace path containing `ASK_CONTEXT.md`.

## Known issues

- No project scaffold exists yet.
- Validation commands that depend on `package.json` cannot run until Milestone 1 is implemented.
- Codex adapter flags for verified read-only/no-network operation need to be confirmed during implementation against the installed Codex CLI.
- Real installed-tool integration tests may depend on local availability of tools such as `pytest`, `prettier`, or `eslint`; fixture tests should be the CI baseline.

## Follow-ups

- Revisit v1.1 items only after MVP is green: Go binary heuristics, stronger container sandboxing, opt-in answer caching, direct HTTP agent adapters, Windows support, and optional native helpers.
- Add release automation only after `npm pack --dry-run` and `prepublishOnly` are stable.
