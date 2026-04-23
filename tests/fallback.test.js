import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCargoStub,
  resolveGenericFallback,
  resolveHomebrewStub,
} from "../dist/resolvers/fallback.js";

test("cargo and homebrew stubs return clear fallback warnings", () => {
  const cargo = resolveCargoStub(located({ command: "cargo-tool" }));
  const homebrew = resolveHomebrewStub(located({ command: "brew-tool" }));

  assert.equal(cargo.ecosystem, "cargo");
  assert.equal(cargo.packageRoot, null);
  assert.match(cargo.warnings[0], /not available in the MVP/);
  assert.equal(homebrew.ecosystem, "homebrew");
  assert.equal(homebrew.packageRoot, null);
  assert.match(homebrew.warnings[0], /not available in the MVP/);
});

test("generic fallback returns help-only resolution shape", () => {
  const resolution = resolveGenericFallback(located({ command: "tool" }));

  assert.equal(resolution.ecosystem, "fallback");
  assert.equal(resolution.packageName, null);
  assert.equal(resolution.confidence, "low");
  assert.match(resolution.warnings[0], /help, version, man, and completion/);
});

function located(overrides = {}) {
  return {
    command: "tool",
    path: "/usr/bin/tool",
    realPath: "/usr/bin/tool",
    symlinkChain: [],
    shebang: null,
    executableKind: "unknown",
    mtimeNs: 1n,
    shim: null,
    ...overrides,
  };
}
