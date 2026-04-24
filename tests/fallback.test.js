import assert from "node:assert/strict";
import test from "node:test";

import { resolveGenericFallback } from "../dist/resolvers/fallback.js";

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
