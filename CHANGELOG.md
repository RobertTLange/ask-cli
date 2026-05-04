# Changelog

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
