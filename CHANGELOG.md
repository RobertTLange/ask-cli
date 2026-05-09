# Changelog

## Unreleased

### Fixed

- Resolved Headless progress labels for explicit agents so model and reasoning details are shown when Headless reports them.
- Allowed slower Headless auto identity probes to finish before falling back to default progress-label fields.
- Detected native npm package binaries installed under package directories in `node_modules`, avoiding fallback context for tools like `hunk`.
- Resolved npm platform optional binaries through their parent package when available, so tools like `hunk` collect README and wrapper context instead of native binary blobs.

### Changed

- Show a transient startup spinner before the first progress log while agent identity details are being resolved.
- Include bundled package skill markdown in staged docs context.

## 0.1.2 - 2026-05-08

### Added

- Added `ask --repo` for answering questions about GitHub repositories from a cached, read-only checked-out worktree.

### Fixed

- Avoided chmod traversal through repository symlinks while preparing read-only repo worktrees.
- Mapped invalid repository input errors to usage errors.

### Documentation

- Added a README badge linking to the companion ask-cli blog post.

## 0.1.1 - 2026-05-04

### Changed

- Renamed the npm package from `@roberttlange/ask-cli` to `@roberttlange/ask`; the installed binary remains `ask`.
- Updated README installation examples and npm badge for the new package name.

## 0.1.0 - 2026-05-04

### Added

- Initial `ask` CLI for answering questions about installed command-line tools from locally staged package context.
- Headless-backed agent execution with support for automatic backend selection and explicit agent/model/reasoning configuration.
- Read-only context workspaces with `ASK_CONTEXT.md`, package source/docs, metadata, and bounded help/version output.
- Resolvers for npm, Python, Homebrew, Cargo, fallback commands, and common wrapper/shim layouts.
- Human and JSON output modes with warnings, citations, uncertainty details, and context-only inspection through `--agent none`.
- Cache and sandbox protections for bounded collection, stale bundle avoidance, symlink containment, and process-group cleanup.

### Fixed

- Kept agent prompts workspace-relative so opencode and other permissioned backends can read staged files without requesting external-directory access.
