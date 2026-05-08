import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSandbox } from "../dist/sandbox.js";

test("sandbox captures normal exit", async () => {
  const result = await runSandbox({
    command: process.execPath,
    args: ["-e", "console.log(process.env.SECRET || 'unset')"],
    env: { SECRET: "visible" },
    timeoutMs: 5_000,
    stdoutBytes: 1_024,
    stderrBytes: 1_024,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "visible");
  assert.equal(result.stderr, "");
});

test("sandbox reports non-zero exit", async () => {
  const result = await runSandbox({
    command: process.execPath,
    args: ["-e", "console.error('bad'); process.exit(7)"],
    timeoutMs: 5_000,
    stdoutBytes: 1_024,
    stderrBytes: 1_024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.failureReason, "non_zero_exit");
  assert.match(result.stderr, /bad/);
});

test("sandbox times out long-running commands", async () => {
  const result = await runSandbox({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10_000)"],
    timeoutMs: 100,
    stdoutBytes: 1_024,
    stderrBytes: 1_024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.failureReason, "timeout");
});

test("sandbox enforces stdout byte cap", async () => {
  const result = await runSandbox({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(10_000))"],
    timeoutMs: 5_000,
    stdoutBytes: 32,
    stderrBytes: 1_024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stdout.length, 32);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.failureReason, "stdout_limit");
});

test("sandbox kills grandchildren in the process group", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-grandchild-"));
  const marker = join(temp, "grandchild-marker");

  try {
    const result = await runSandbox({
      command: process.execPath,
      args: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 500)`) }], { stdio: 'ignore' });`,
          "setTimeout(() => {}, 10_000);",
        ].join(""),
      ],
      timeoutMs: 100,
      stdoutBytes: 1_024,
      stderrBytes: 1_024,
    });

    assert.equal(result.failureReason, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 800));
    await assert.rejects(access(marker, fsConstants.F_OK));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("sandbox starts with a restricted environment", async () => {
  const result = await runSandbox({
    command: process.execPath,
    args: [
      "-e",
      [
        "console.log(JSON.stringify({",
        "keys: Object.keys(process.env).sort(),",
        "secret: process.env.ASK_SHOULD_NOT_LEAK || null",
        "}))",
      ].join(""),
    ],
    timeoutMs: 5_000,
    stdoutBytes: 1_024,
    stderrBytes: 1_024,
  });

  const env = JSON.parse(result.stdout);
  assert.equal(env.secret, null);
  assert.ok(env.keys.includes("HOME"));
  assert.ok(env.keys.includes("LANG"));
  assert.ok(env.keys.includes("PATH"));
});
