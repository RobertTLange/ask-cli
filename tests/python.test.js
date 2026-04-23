import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolvePythonPackage } from "../dist/resolvers/python.js";

const fixtureBin = join(process.cwd(), "tests", "fixtures", "python", "bin");
const fixtureExecutable = join(fixtureBin, "fixture-cli-py");

test("python resolver parses dist-info metadata for fixture CLI", async () => {
  const located = await locateExecutable("fixture-cli-py", {
    env: { PATH: fixtureBin, SHELL: "/missing-shell" },
  });

  const resolution = await resolvePythonPackage(located);

  assert.equal(resolution.ecosystem, "python");
  assert.equal(resolution.packageName, "fixture-cli-py");
  assert.equal(resolution.version, "0.1.0");
  assert.equal(resolution.confidence, "medium");
  assert.match(resolution.packageRoot, /fixture_cli_py$/);
  assert.match(resolution.entryFile, /fixture_cli_py\/cli\.py$/);
  assert.equal(resolution.executableRealPath, await realpath(fixtureExecutable));
});

test("python resolver returns low confidence when metadata is unavailable", async () => {
  const located = {
    command: "missing-python-cli",
    path: "/tmp/missing-python-cli",
    realPath: "/tmp/missing-python-cli",
    symlinkChain: [],
    shebang: "/usr/bin/env python3",
    executableKind: "script",
    mtimeNs: 1n,
    shim: null,
  };

  const resolution = await resolvePythonPackage(located);

  assert.equal(resolution.packageName, null);
  assert.equal(resolution.confidence, "low");
  assert.match(resolution.warnings[0], /metadata was not found/);
});

test("CLI --agent none reports Python fixture resolution", async () => {
  const result = await run([
    "--agent",
    "none",
    "--ecosystem",
    "python",
    "fixture-cli-py",
    "How do I use the sample option?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Package: fixture-cli-py 0\.1\.0/);
  assert.match(result.stdout, /Confidence: medium/);
});
