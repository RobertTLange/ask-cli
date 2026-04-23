# ask implementation plan

## Source of truth

This plan implements `docs/spec.md`. Keep scope locked to the MVP: TypeScript on Node 20.11+, Python/npm native resolution, Cargo/Homebrew stubs, fallback collection, read-only staging, Codex plus `none` agent, offline operation.

## Stop-and-fix rule

After every milestone, run that milestone's validation commands. If a command fails, stop feature work, fix the failure, and rerun the same validation before moving on. Do not carry known-red build, type, or test failures into the next milestone.

## Intended architecture

- `src/cli/`: argument parsing, config merge, output formatting, exit-code mapping, top-level orchestration.
- `src/resolvers/`: locate executable, ecosystem detection, Python/npm resolvers, Cargo/Homebrew stubs, fallback.
- `src/collectors/`: bounded context discovery and allow-listed help/man/version execution.
- `src/workspace/`: temp workspace creation, file copy/chmod, redaction, `metadata.json`, `ASK_CONTEXT.md`, cleanup.
- `src/agents/`: `Agent` interface, Codex adapter, `none` adapter, prompt builder.
- `src/cache/`: resolution/help/workspace cache, keys, refresh, LRU cleanup.
- `src/sandbox.ts`: single subprocess wrapper used by all command execution.
- `tests/fixtures/`: tiny Python and npm CLIs plus adversarial cases.

## Milestone 1: Package scaffold and CLI shell

Build the initial npm/TypeScript project.

Acceptance criteria:

- `package.json` defines ESM, Node >=20.11, `bin.ask`, `build`, `test`, and `prepublishOnly`.
- `bin/ask.js` has a Node shebang and calls `dist/cli/index.js`.
- `tsconfig.json` compiles `src/` to `dist/`.
- CLI parses the documented flags and positionals.
- `--help`, `--version`, bad usage, and missing args map to documented exit behavior.
- Config loader reads `~/.config/ask/config.json` or `$XDG_CONFIG_HOME/ask/config.json`, with CLI flags overriding config and config overriding built-ins.

Validation commands:

```sh
npm install
npm run build
npm test
node bin/ask.js --help
node bin/ask.js --version
node bin/ask.js
```

## Milestone 2: Core types, trace, and sandbox

Establish shared contracts and safe process execution before resolver work.

Acceptance criteria:

- Internal API types match the spec: `LocatedExecutable`, `Resolution`, `ContextBundle`, `AgentRequest`, `AgentEvent`, `Resolver`, `Collector`, `Limits`.
- Trace captures resolver decisions and is emitted under `--debug`.
- Sandbox wrapper uses arg arrays, `shell: false`, closed stdin, restricted env, timeout, stdout/stderr byte caps, process-group cleanup, and clear errors.
- Tests cover normal exit, non-zero exit, timeout, byte cap, and grandchild cleanup.

Validation commands:

```sh
npm run build
npm test -- sandbox
```

## Milestone 3: Locate executable and ecosystem detection

Resolve an input command to an executable and classify the ecosystem.

Acceptance criteria:

- PATH lookup is implemented without external `which`.
- Shell builtin/alias/function detection uses the user's shell only for `type -a` and treats aliases/functions as resolution failures.
- Realpath, symlink-chain, first-byte shebang/magic detection, execute-bit check, pyenv/asdf/nvm shim detection are recorded.
- Ecosystem detection follows the spec order, including `--ecosystem` override.
- Missing command exits 2 with attempted action, failure cause, and next step.

Validation commands:

```sh
npm run build
npm test -- locate
npm test -- ecosystem
node bin/ask.js --agent none definitely-not-a-real-command "help"
```

## Milestone 4: Python resolver

Implement Python package resolution with Tier A introspection and Tier B dist-info parsing.

Acceptance criteria:

- Tier A runs one embedded `importlib.metadata` script through the sandbox and never imports target package code.
- Tier B parses `METADATA`, `entry_points.txt`, and `RECORD` from candidate `site-packages`/`dist-packages`.
- Disambiguation and confidence follow the spec.
- Warnings are recorded when Tier A and Tier B disagree.
- Fixture Python CLI resolves with package name, version, root, entry file, metadata files, and at least medium confidence.

Validation commands:

```sh
npm run build
npm test -- python
node bin/ask.js --agent none --ecosystem python fixture-cli-py "How do I use the sample option?" --debug
```

## Milestone 5: npm resolver and fallback stubs

Resolve npm CLIs and provide honest behavior for unsupported ecosystems.

Acceptance criteria:

- npm resolver walks upward for `package.json`, handles string/object `bin`, and verifies bin target path equality.
- npm fallback inside `node_modules/<pkg>/` returns medium confidence when no exact bin match exists.
- Cargo and Homebrew resolvers return stub resolutions with clear warnings and fallback collection.
- Generic fallback returns help/man/version/completion-only context.

Validation commands:

```sh
npm run build
npm test -- npm
npm test -- fallback
node bin/ask.js --agent none --ecosystem npm fixture-cli-npm "How do I enable json output?" --debug
```

## Milestone 6: Context collection and redaction

Collect only bounded, useful, untrusted context.

Acceptance criteria:

- Help, version, and subcommand help use only allowed commands and honor `--no-exec` and `--allow-help-exec`.
- README, docs, changelog, entry source, parser candidates, config hints, env-var references, tests, examples, and completions are selected with bounded depth.
- Defaults are implemented: `maxFiles=200`, `maxBytesPerFile=262144`, `maxTotalBytes=8388608`, `helpTimeoutMs=5000`, `helpStdoutBytes=131072`, `subcommandHelpLimit=10`.
- Truncation is marked and reported.
- Redactor masks common API-key patterns and sensitive env var values before staging.
- Tests cover discovery, limits, truncation, `--no-exec`, and redaction.

Validation commands:

```sh
npm run build
npm test -- collector
npm test -- redactor
```

## Milestone 7: Workspace staging

Create the read-only workspace contract consumed by agents.

Acceptance criteria:

- Workspace layout matches the spec under `os.tmpdir()/ask-workspaces/<hash>/`.
- Files are copied with symlink dereferencing, never symlinked.
- Package files are chmodded `0444`; directories are chmodded `0555`.
- `metadata.json` includes resolution and bundle summary.
- `ASK_CONTEXT.md` has the fixed sections and untrusted-data rules.
- Cleanup runs on normal exit and SIGINT/SIGTERM unless `--keep-workspace` is set.
- Tests assert read-only modes, symlink escape prevention, manifest content, and cleanup behavior.

Validation commands:

```sh
npm run build
npm test -- workspace
node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --keep-workspace --debug
```

## Milestone 8: Agent adapters and output contract

Stream answers through `none` and Codex adapters.

Acceptance criteria:

- `--agent none` prints the workspace path and `ASK_CONTEXT.md`, then exits 0.
- Codex adapter discovers `codex`, verifies read-only/no-network controls, streams stdout, handles timeout and SIGINT, and refuses to run if controls cannot be verified.
- Prompt template matches the spec and treats staged files as untrusted data.
- Human output and JSON output follow the answer contract.
- Agent failure exits 4 with attempted action, failure cause, and next step.

Validation commands:

```sh
npm run build
npm test -- agent
node bin/ask.js --agent none fixture-cli-npm "How do I enable json output?"
node bin/ask.js --json --agent none fixture-cli-npm "How do I enable json output?" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>JSON.parse(s))'
ASK_E2E=1 npm test -- codex
```

## Milestone 9: Cache and refresh

Add deterministic caching without caching answers.

Acceptance criteria:

- Resolution, help output, and staged workspace contents are cached under `$XDG_CACHE_HOME/ask` or `~/.cache/ask`.
- Cache key uses command, package name, version, executable real path, executable mtime, and editable entry source hash.
- `--refresh` bypasses and rebuilds cache entries.
- LRU eviction honors `maxSizeMb`.
- Agent answers are never cached.

Validation commands:

```sh
npm run build
npm test -- cache
node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --debug
node bin/ask.js --agent none fixture-cli-npm "How do I use it?" --debug
node bin/ask.js --refresh --agent none fixture-cli-npm "How do I use it?" --debug
```

## Milestone 10: Adversarial tests, docs, and release readiness

Close the MVP with security, packaging, and user docs.

Acceptance criteria:

- Adversarial fixtures cover prompt injection, huge output, sleeping process, sleeping grandchild, and prototype-pollution payload.
- Source scan verifies no `http`, `https`, or `fetch` imports in `src/`.
- README documents install, usage, flags, exit codes, security model, limitations, examples, and demo flow.
- `prepublishOnly` passes.
- Package contents are limited to `bin/` and `dist/`.

Validation commands:

```sh
npm run build
npm test
npm run prepublishOnly
if rg 'from "node:(http|https)"|from "http"|from "https"|fetch\(' src; then exit 1; else exit 0; fi
npm pack --dry-run
```

## Decision notes

- Keep Cargo and Homebrew as stubs in MVP. Do not expand them unless the spec changes.
- Keep network use at zero. Do not add registry lookup or direct HTTP agent work.
- Prefer built-in Node APIs. If adding a dependency, record the reason in README or implementation notes.
- Do not let the agent participate in resolution, discovery, or command execution.
- Keep resolver and collector modules independently testable.
- Keep error messages actionable: attempted action, concrete failure, next step.
- Treat fixtures as first-class implementation aids, not afterthoughts.
