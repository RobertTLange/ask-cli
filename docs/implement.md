# ask implementation runbook

## Operating rule

`docs/plan.md` is the source of truth for implementation order, scope, and validation. Execute milestone by milestone. Do not start features from later milestones while the current milestone is red.

## Startup checklist

1. Read `docs/spec.md`, `docs/plan.md`, and this file.
2. Load and follow the synced `clean-code` skill for implementation and refactor passes.
3. Follow repo clean-code guidance from `AGENTS.md` or equivalent project instructions when present.
4. Check worktree state:

   ```sh
   git status --short
   ```

5. Identify any unrelated edits before touching files. Work around them; do not revert them.

## Implementation loop

For each milestone in `docs/plan.md`:

1. Restate the milestone goal in the thread.
2. Make the smallest coherent code change that satisfies the acceptance criteria.
3. Keep diffs scoped to that milestone.
4. Add or update focused tests with the code.
5. Run the milestone validation commands.
6. If validation fails, stop and fix the failure before continuing.
7. Update `docs/documentation.md` with status, decisions, and any follow-ups.
8. Re-check `git status --short` before moving to the next milestone.

## Clean-code expectations

- Use meaningful names that reveal intent.
- Keep functions small and single-purpose.
- Do not add boolean flag arguments to new APIs; split behavior into separate functions or options objects.
- Prefer structured parsers and typed data over ad hoc string manipulation where practical.
- Keep abstractions local until duplication or complexity justifies extracting them.
- Keep modules below roughly 500 LOC; split by responsibility when they grow.
- Prefer self-documenting code. Add comments only for non-obvious constraints, security boundaries, or tricky behavior.
- Tests should be readable, focused on one concept, and avoid noisy setup.
- Remove duplication before adding abstraction.

## Validation discipline

- Minimum recurring gate once scaffold exists:

  ```sh
  npm run build
  npm test
  ```

- Use narrower test commands during milestone work, then run the full gate before handoff.
- Run `npm run prepublishOnly` before release-readiness handoff.
- Run the source network scan before MVP completion:

  ```sh
  if rg 'from "node:(http|https)"|from "http"|from "https"|fetch\(' src; then exit 1; else exit 0; fi
  ```

  This command should find no runtime network use in `src/`.

## Security implementation notes

- Route every subprocess through `src/sandbox.ts`.
- Use `spawn` with arg arrays and `shell: false`.
- Pass a restricted environment. Do not spread `process.env`.
- Close stdin for child processes.
- Enforce timeouts and byte caps.
- Kill the process group on timeout or shutdown.
- Treat help output, source files, README, docs, and tests as untrusted input.
- Copy files into workspaces with symlink dereferencing; never expose original package paths to the agent as writable state.
- Redact before writing staged files.
- Codex must run read-only and without network. Refuse to launch if adapter verification cannot prove the controls.

## Testing strategy during implementation

- Start with unit tests for core pure logic: config merge, path lookup, ecosystem rules, metadata parsing, manifest rendering, cache keys.
- Use fixture directories for Python dist-info and npm `package.json`/`bin` resolution.
- Use small executable fixture scripts for sandbox, timeout, byte cap, and grandchild cleanup tests.
- Use mock agents for answer-contract tests.
- Gate real Codex tests behind `ASK_E2E=1`.

## Documentation updates

Update `docs/documentation.md` continuously:

- Mark the current milestone.
- Record what changed.
- Record validation commands and outcomes.
- Record decisions that narrow ambiguous implementation choices.
- Record known issues and follow-ups.

Update README during Milestone 10, not earlier unless a milestone needs user-facing command docs to clarify behavior.

## Handoff checklist

Before handing off:

```sh
git status --short
npm run build
npm test
```

If the full gate cannot run, report exactly why and which narrower checks passed.

For MVP completion also run:

```sh
npm run prepublishOnly
if rg 'from "node:(http|https)"|from "http"|from "https"|fetch\(' src; then exit 1; else exit 0; fi
npm pack --dry-run
```
