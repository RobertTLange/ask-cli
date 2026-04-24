# ask project documentation

## Current milestone status

- Milestone 1, package scaffold and CLI shell, is complete.
- Milestone 2, core types, trace, and sandbox, is complete.
- Milestone 3, locate executable and ecosystem detection, is complete.
- Milestone 4, Python resolver, is complete.
- Milestone 5, npm resolver and fallback stubs, is complete.
- Milestone 6, context collection and redaction, is complete.
- Milestone 7, workspace staging, is complete.
- Milestone 8, agent adapters and output contract, is complete.
- Milestone 9, cache and refresh, is complete.
- Milestone 10, adversarial tests, docs, and release readiness, is complete.
- Current implementation milestone: complete; full plan implemented.

## What is done now

- Product target is locked in `docs/spec.md`.
- Execution plan is defined in `docs/plan.md`.
- Implementation runbook is defined in `docs/implement.md`.
- MVP scope is constrained to TypeScript/Node 20.11+, Python/npm native resolution, Cargo/Homebrew stubs, fallback collection, read-only staging, Codex plus `none` agent, offline operation, and npm distribution.
- npm/TypeScript scaffold exists with ESM package metadata, Node >=20.11 engine, `bin.ask`, `build`, `test`, and `prepublishOnly` scripts.
- `bin/ask.js` has a Node shebang and imports the built CLI from `dist/cli/index.js`.
- CLI shell parses documented flags and positionals, supports `--help` and `--version`, returns exit 1 for missing args, and reads JSON config from `$XDG_CONFIG_HOME/ask/config.json` or `~/.config/ask/config.json`.
- Tests cover help/version, missing args, documented flag parsing, CLI-over-config precedence, and config loading.
- Shared internal API types now exist for located executables, resolutions, context bundles, agent requests/events, resolvers, collectors, agents, and limits.
- Trace events can be recorded and rendered as newline-delimited JSON for debug output.
- `src/sandbox.ts` provides the subprocess wrapper with arg arrays, `shell: false`, closed stdin, restricted env, timeout handling, byte caps, and process-group cleanup.
- Sandbox tests cover normal exit, non-zero exit, timeout, byte cap, grandchild cleanup, and environment hygiene.
- Executable location now resolves PATH entries without external `which`, rejects shell aliases/functions/builtins, validates user execute bits, records realpath/symlink/shebang/signature metadata, and detects pyenv/asdf/nvm shims.
- Ecosystem detection now supports the `--ecosystem` override plus Python shebangs, Node shebangs, Python package paths, npm bin paths, Cargo bin paths, Homebrew paths, and fallback.
- CLI missing-command execution now returns exit 2 with attempted action, failure cause, and a concrete next step.
- Python resolution now supports Tier A `importlib.metadata` introspection through the sandbox and Tier B dist-info parsing of `METADATA`, `entry_points.txt`, and `RECORD`.
- The fixture Python CLI resolves to package name, version, package root, entry file, metadata files, and medium confidence.
- `--agent none` currently prints a resolution summary so resolver milestones can validate through the CLI before workspace staging is implemented.
- npm resolution now walks upward for `package.json`, supports string/object `bin`, verifies bin target equality, and falls back to packages under `node_modules/<pkg>/`.
- Cargo, Homebrew, and generic fallback resolvers now return low-confidence resolutions with clear warnings that source-level context is unavailable in MVP.
- The fixture npm CLI resolves through the CLI with high confidence.
- Context collection now runs only allowed help/version/subcommand help commands through the sandbox and honors `--no-exec` / `allowHelpExec=false`.
- Package discovery now selects bounded README, docs, changelog, entry source, parser/config/env/test/example/completion candidates with truncation warnings.
- Redaction masks common API-key patterns and sensitive environment values before staged context can be written.
- Workspace staging now creates deterministic temp workspaces, copies/redacts selected context into `package/` and `help/`, writes `metadata.json` and `ASK_CONTEXT.md`, applies read-only file/dir modes, skips symlink escapes, and cleans up unless `--keep-workspace` is used.
- Agent prompt construction now uses the fixed untrusted-data/no-network/no-execution rules.
- `--agent none` is implemented through the agent interface and prints the staged workspace path plus `ASK_CONTEXT.md`.
- `--json --agent none` emits parseable JSON matching the answer contract shape.
- Codex adapter discovery and control verification exists; it verifies documented `codex exec` sandbox controls before launching Codex.
- Resolution metadata, collected context bundles, and staged workspace copies are cached under the ask cache root.
- Cache keys include command, package, version, executable real path, executable mtime, and the first 4 KiB hash of the entry source.
- `--refresh` bypasses cached collection data and debug trace reports cache hit/miss/refresh.
- Adversarial fixtures now cover prompt injection, huge output, sleeping process, sleeping grandchild, and prototype-pollution package JSON.
- README documents install, usage, flags, exit codes, security model, limitations, and demo flow.
- Release checks pass, including `prepublishOnly`, source no-network scan, and `npm pack --dry-run`.

## What is next

All planned milestones are complete. Next work is outside the MVP plan: publishing, real-world smoke testing against installed tools, or follow-up feature work.

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
- Milestone 1 uses Node's built-in `node:util` `parseArgs` instead of a runtime CLI dependency to keep the MVP zero-dependency at runtime.
- Tests are plain Node test-runner JavaScript files that import compiled `dist/` output; this keeps runtime code TypeScript-only without adding a test transpiler.
- `dist/` and `node_modules/` are gitignored. The package `files` allowlist publishes only `bin/` and built `dist/` after the release gate.

## Milestone log

### Milestone 1: package scaffold and CLI shell

Status: complete.

Files added:

- `.gitignore`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `bin/ask.js`
- `src/cli/constants.ts`
- `src/cli/config.ts`
- `src/cli/args.ts`
- `src/cli/index.ts`
- `tests/cli.test.js`

Validation:

```sh
npm install
npm run build
npm test
node bin/ask.js --help
node bin/ask.js --version
node bin/ask.js
```

Results:

- `npm install`: passed; 3 packages installed, 0 vulnerabilities.
- `npm run build`: passed.
- `npm test`: passed; 6 tests passed.
- `node bin/ask.js --help`: passed; exited 0 and printed usage.
- `node bin/ask.js --version`: passed; exited 0 and printed `0.1.0`.
- `node bin/ask.js`: passed; exited 1 with `Usage error: missing command`.

### Milestone 2: core types, trace, and sandbox

Status: complete.

Files added:

- `scripts/test.js`
- `src/types.ts`
- `src/trace.ts`
- `src/sandbox.ts`
- `tests/sandbox.test.js`

Files changed:

- `package.json`

Validation:

```sh
npm run build
npm test -- sandbox
```

Results:

- `npm run build`: passed.
- `npm test -- sandbox`: passed; sandbox tests covered normal exit, non-zero exit, timeout, stdout byte cap, grandchild cleanup, and restricted environment.

Decisions:

- The sandbox returns a structured result rather than throwing for non-zero exits, timeouts, or byte caps. Resolver and collector code can then attach actionable failure details to user-facing errors without losing stdout/stderr context.
- macOS may inject `__CF_USER_TEXT_ENCODING` into child processes. The environment test verifies that parent secrets are not leaked and required allow-listed keys are present rather than asserting an impossible exact key set.
- `npm test -- <pattern>` now runs through `scripts/test.js`, which maps plan validation patterns to Node's built-in test name filter.

### Milestone 3: locate executable and ecosystem detection

Status: complete.

Files added:

- `src/errors.ts`
- `src/resolvers/locate.ts`
- `src/resolvers/ecosystem.ts`
- `tests/locate.test.js`
- `tests/ecosystem.test.js`

Files changed:

- `src/cli/index.ts`
- `src/types.ts`

Validation:

```sh
npm run build
npm test -- locate
npm test -- ecosystem
node bin/ask.js --agent none definitely-not-a-real-command "help"
```

Results:

- `npm run build`: passed.
- `npm test -- locate`: passed; tests covered PATH lookup, symlink/realpath/shebang/signature metadata, missing commands, execute-bit failures, shell builtin rejection, and CLI exit 2 mapping.
- `npm test -- ecosystem`: passed; tests covered override, Python/Node shebangs, Python/npm/Cargo/Homebrew path rules, and fallback.
- `node bin/ask.js --agent none definitely-not-a-real-command "help"`: passed; exited 2 with attempted action and next step.

Decisions:

- `LocatedExecutable` includes `executableKind` so first-byte script/ELF/Mach-O detection is carried with locate metadata and debug trace.
- Direct path inputs that exist but are not executable now produce the execute-bit error instead of collapsing into a generic missing-command error.
- Shell alias/function/builtin detection rejects any matching shell `type -a` output; this is conservative and matches the spec's file-backed CLI requirement.

### Milestone 4: Python resolver

Status: complete.

Files added:

- `src/resolvers/python.ts`
- `tests/python.test.js`
- `tests/fixtures/python/bin/fixture-cli-py`
- `tests/fixtures/python/lib/python3.12/site-packages/fixture_cli_py/__init__.py`
- `tests/fixtures/python/lib/python3.12/site-packages/fixture_cli_py/cli.py`
- `tests/fixtures/python/lib/python3.12/site-packages/fixture_cli_py-0.1.0.dist-info/METADATA`
- `tests/fixtures/python/lib/python3.12/site-packages/fixture_cli_py-0.1.0.dist-info/entry_points.txt`
- `tests/fixtures/python/lib/python3.12/site-packages/fixture_cli_py-0.1.0.dist-info/RECORD`

Files changed:

- `src/cli/index.ts`
- `src/resolvers/locate.ts`

Validation:

```sh
npm run build
npm test -- python
node bin/ask.js --agent none --ecosystem python fixture-cli-py "How do I use the sample option?" --debug
```

Results:

- `npm run build`: passed.
- `npm test -- python`: passed; tests covered fixture dist-info resolution, low-confidence unresolved metadata, and CLI `--agent none` summary output.
- `node bin/ask.js --agent none --ecosystem python fixture-cli-py "How do I use the sample option?" --debug`: passed; exited 0 and reported `fixture-cli-py 0.1.0` with medium confidence.

Decisions:

- Tier A uses a fixed embedded `importlib.metadata` script and does not import target package modules.
- Tier B derives fixture-style virtualenv prefixes from the executable path so local tests can run without installing the fixture into the developer's Python.
- Development fixture lookup checks `tests/fixtures/.../bin` only when PATH lookup fails. Published package contents exclude tests, so this does not affect npm package runtime behavior.

### Milestone 5: npm resolver and fallback stubs

Status: complete.

Files added:

- `src/resolvers/npm.ts`
- `src/resolvers/fallback.ts`
- `tests/npm.test.js`
- `tests/fallback.test.js`
- `tests/fixtures/npm/node_modules/.bin/fixture-cli-npm`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/package.json`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/bin/fixture.js`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/lib/cli.js`

Files changed:

- `src/cli/index.ts`

Validation:

```sh
npm run build
npm test -- npm
npm test -- fallback
node bin/ask.js --agent none --ecosystem npm fixture-cli-npm "How do I enable json output?" --debug
```

Results:

- `npm run build`: passed.
- `npm test -- npm`: passed; tests covered exact `package.json` bin resolution, `node_modules/<pkg>` fallback, and CLI `--agent none` npm summary.
- `npm test -- fallback`: passed; tests covered Cargo, Homebrew, and generic fallback warning shapes.
- `node bin/ask.js --agent none --ecosystem npm fixture-cli-npm "How do I enable json output?" --debug`: passed; exited 0 and reported `fixture-cli-npm 0.1.0` with high confidence.

Decisions:

- Exact npm bin matches are high confidence; package-path fallback without a bin match is medium confidence with a warning.
- Cargo and Homebrew remain honest low-confidence stubs per MVP scope.

### Milestone 6: context collection and redaction

Status: complete.

Files added:

- `src/collectors/limits.ts`
- `src/collectors/context.ts`
- `src/workspace/redact.ts`
- `tests/collector.test.js`
- `tests/redactor.test.js`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/README.md`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/CHANGELOG.md`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/docs/usage.md`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/lib/config.js`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/lib/env.js`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/test/cli.test.js`
- `tests/fixtures/npm/node_modules/fixture-cli-npm/examples/basic.js`

Validation:

```sh
npm run build
npm test -- collector
npm test -- redactor
```

Results:

- `npm run build`: passed.
- `npm test -- collector`: passed; tests covered help/version collection, useful package file discovery, `--no-exec`, file count limits, byte limits, and truncation warnings.
- `npm test -- redactor`: passed; tests covered API-key patterns and sensitive environment values.

Decisions:

- Collector file references carry metadata only; actual file copying/redaction happens in workspace staging.
- Help collection always uses the sandbox and records non-zero output as context instead of treating it as a fatal collector error.

### Milestone 7: workspace staging

Status: complete.

Files added:

- `src/workspace/stage.ts`
- `tests/workspace.test.js`

Files changed:

- `src/cli/index.ts`

Validation:

```sh
npm run build
npm test -- workspace
node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --keep-workspace --debug
```

Results:

- `npm run build`: passed.
- `npm test -- workspace`: passed; tests covered read-only modes, manifest content, cleanup, and symlink escape prevention.
- `node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --keep-workspace --debug`: passed; exited 0, staged a workspace under `/tmp`/`os.tmpdir()`, printed `ASK_CONTEXT.md`, and preserved the workspace.

Decisions:

- `stageWorkspace` removes a previous deterministic workspace by making it writable first, then recreates it. This keeps the hash deterministic without accumulating stale state.
- Symlink escapes are skipped instead of dereferenced when the resolved target leaves the package root.

### Milestone 8: agent adapters and output contract

Status: complete.

Files added:

- `src/agents/prompt.ts`
- `src/agents/none.ts`
- `src/agents/codex.ts`
- `tests/agent.test.js`

Files changed:

- `src/cli/index.ts`

Validation:

```sh
npm run build
npm test -- agent
node bin/ask.js --agent none fixture-cli-npm "How do I enable json output?"
node bin/ask.js --json --agent none fixture-cli-npm "How do I enable json output?" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s))'
ASK_E2E=1 npm test -- codex
```

Results:

- `npm run build`: passed.
- `npm test -- agent`: passed; tests covered none-agent human/JSON output and prompt rules.
- `node bin/ask.js --agent none fixture-cli-npm "How do I enable json output?"`: passed; exited 0 and printed workspace path plus `ASK_CONTEXT.md`.
- JSON pipe command: passed; stdout parsed as JSON.
- `ASK_E2E=1 npm test -- codex`: passed under the earlier stricter verification behavior.

Decisions:

- Codex is launched through `codex exec --sandbox read-only --cd <workspace> --skip-git-repo-check --ephemeral` and does not pass the documented `--search` flag.
- `--agent none` goes through the same collection and staging path as real agents, which keeps debug behavior representative.

### Milestone 9: cache and refresh

Status: complete.

Files added:

- `src/cache/store.ts`
- `tests/cache.test.js`

Files changed:

- `src/cli/index.ts`

Validation:

```sh
npm run build
npm test -- cache
node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --debug
node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --debug
node bin/ask.js --refresh --agent none fixture-cli-npm "How do I use it?" --debug
```

Results:

- `npm run build`: passed.
- `npm test -- cache`: passed; tests covered cache root resolution, entry source hash keys, bundle BigInt restore, workspace cache copy, and LRU eviction.
- First and second non-refresh CLI runs: passed; debug trace reported cache hits once the cache was warm.
- Refresh CLI run: passed; debug trace reported `refresh` and rebuilt collection data.

Decisions:

- Agent answers are not cached; only resolution/collection/workspace artifacts are stored.
- Cache max-size eviction is implemented in the cache store and currently called with the MVP default of 512 MiB.

### Milestone 10: adversarial tests, docs, and release readiness

Status: complete.

Files added:

- `README.md`
- `tests/adversarial.test.js`
- `tests/fixtures/adversarial/prompt-injection.md`
- `tests/fixtures/adversarial/huge-output.js`
- `tests/fixtures/adversarial/sleep.js`
- `tests/fixtures/adversarial/grandchild.js`
- `tests/fixtures/pollution/node_modules/polluted-tool/package.json`
- `tests/fixtures/pollution/node_modules/polluted-tool/bin/polluted.js`

Files changed:

- `package.json`
- `src/workspace/stage.ts`
- `src/cli/index.ts`

Validation:

```sh
npm run build
npm test
npm run prepublishOnly
if rg 'from "node:(http|https)"|from "http"|from "https"|fetch\(' src; then exit 1; else exit 0; fi
npm pack --dry-run
```

Results:

- `npm run build`: passed.
- `npm test`: passed; 54 tests passed.
- `npm run prepublishOnly`: passed; it ran build and the full test suite.
- Source no-network scan: passed; no `http`, `https`, or `fetch` runtime imports in `src/`.
- `npm pack --dry-run`: passed; package dry-run includes npm-mandatory `README.md`/`package.json` plus configured `bin/` and `dist/` contents.

Decisions:

- A filesystem lock now guards deterministic workspace paths until cleanup/release. Full-suite tests run in parallel and exposed same-hash workspace races; the lock preserves deterministic paths while preventing concurrent deletion/copy corruption.
- README is included even though `package.files` only lists `bin` and `dist`, because npm always includes README and package metadata.

## How to run and demo

Current scaffold gate:

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

- Codex adapter uses documented `codex exec` controls and should run with the installed Codex CLI. If Codex itself fails, use `--debug` or `--agent none` to inspect staged context.
- Real installed-tool integration tests may depend on local availability of tools such as `pytest`, `prettier`, or `eslint`; fixture tests should be the CI baseline.

## Follow-ups

- Revisit v1.1 items only after MVP is green: Go binary heuristics, stronger container sandboxing, opt-in answer caching, direct HTTP agent adapters, Windows support, and optional native helpers.
- Add release automation only after `npm pack --dry-run` and `prepublishOnly` are stable.
