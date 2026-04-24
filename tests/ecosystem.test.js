import assert from "node:assert/strict";
import test from "node:test";

import { detectEcosystem } from "../dist/resolvers/ecosystem.js";

test("ecosystem override wins", () => {
  const decision = detectEcosystem(located({ shebang: "/usr/bin/env python3" }), "npm");

  assert.equal(decision.ecosystem, "npm");
  assert.equal(decision.ruleMatched, "override");
});

test("ecosystem detects Python shebang", () => {
  const decision = detectEcosystem(located({ shebang: "/usr/bin/env python3" }));

  assert.equal(decision.ecosystem, "python");
  assert.equal(decision.ruleMatched, "shebang:python");
});

test("ecosystem detects Node shebang", () => {
  const decision = detectEcosystem(located({ shebang: "/usr/bin/env node" }));

  assert.equal(decision.ecosystem, "npm");
  assert.equal(decision.ruleMatched, "shebang:node");
});

test("ecosystem detects site-packages paths", () => {
  const decision = detectEcosystem(located({
    realPath: "/venv/lib/python3.12/site-packages/pkg/cli.py",
  }));

  assert.equal(decision.ecosystem, "python");
  assert.equal(decision.ruleMatched, "path:site-packages");
});

test("ecosystem detects npm bin paths", () => {
  const decision = detectEcosystem(located({
    realPath: "/repo/node_modules/.bin/eslint",
  }));

  assert.equal(decision.ecosystem, "npm");
  assert.equal(decision.ruleMatched, "path:node-bin");
});

test("ecosystem detects cargo and homebrew paths", () => {
  assert.equal(
    detectEcosystem(located({ realPath: "/Users/rob/.cargo/bin/tool" })).ecosystem,
    "cargo",
  );
  assert.equal(
    detectEcosystem(located({ realPath: "/repo/target/release/tool" })).ruleMatched,
    "path:cargo-target",
  );
  assert.equal(
    detectEcosystem(located({ realPath: "/opt/homebrew/bin/tool" })).ecosystem,
    "homebrew",
  );
});

test("ecosystem falls back when no rule matches", () => {
  const decision = detectEcosystem(located({ realPath: "/usr/bin/tool" }));

  assert.equal(decision.ecosystem, "fallback");
  assert.equal(decision.ruleMatched, "fallback");
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
