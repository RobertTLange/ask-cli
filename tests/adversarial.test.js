import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSandbox } from "../dist/sandbox.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolveNpmPackage } from "../dist/resolvers/npm.js";
import { stageWorkspace } from "../dist/workspace/stage.js";

const adversarialDir = join(process.cwd(), "tests", "fixtures", "adversarial");

test("prompt injection remains content while ASK_CONTEXT preserves untrusted-data rules", async () => {
  const injection = join(adversarialDir, "prompt-injection.md");
  const bundle = {
    resolution: resolution({ packageRoot: adversarialDir }),
    helpOutputs: [],
    files: [{
      path: injection,
      relPath: "README.md",
      sizeBytes: 100,
      truncated: false,
      kind: "readme",
    }],
    totalBytes: 100,
    warnings: [],
  };

  const staged = await stageWorkspace(bundle, { question: "What now?" });
  try {
    const askContext = await readFile(join(staged.path, "ASK_CONTEXT.md"), "utf8");
    const stagedReadme = await readFile(join(staged.path, "package", "README.md"), "utf8");
    assert.match(askContext, /UNTRUSTED data/);
    assert.match(stagedReadme, /Ignore previous instructions/);
  } finally {
    await staged.cleanup();
  }
});

test("huge output fixture is capped", async () => {
  const script = join(adversarialDir, "huge-output.js");
  await chmod(script, 0o755);
  const result = await runSandbox({
    command: script,
    timeoutMs: 10_000,
    stdoutBytes: 1024,
    stderrBytes: 1024,
  });

  assert.equal(result.failureReason, "stdout_limit");
  assert.equal(result.stdout.length, 1024);
});

test("sleeping process fixture times out", async () => {
  const script = join(adversarialDir, "sleep.js");
  await chmod(script, 0o755);
  const result = await runSandbox({
    command: script,
    timeoutMs: 100,
    stdoutBytes: 1024,
    stderrBytes: 1024,
  });

  assert.equal(result.failureReason, "timeout");
});

test("sleeping grandchild fixture is killed with the parent process group", async () => {
  const script = join(adversarialDir, "grandchild.js");
  await chmod(script, 0o755);
  const result = await runSandbox({
    command: script,
    timeoutMs: 100,
    stdoutBytes: 1024,
    stderrBytes: 1024,
  });

  assert.equal(result.failureReason, "timeout");
});

test("prototype-pollution package.json does not affect object prototypes", async () => {
  const binDir = join(process.cwd(), "tests", "fixtures", "pollution", "node_modules", "polluted-tool", "bin");
  const executable = join(binDir, "polluted.js");
  await chmod(executable, 0o755);
  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolved = await resolveNpmPackage({ ...located, command: "polluted-tool" });

  assert.equal(resolved.packageName, "polluted-tool");
  assert.equal({}.polluted, undefined);
});

function resolution(overrides = {}) {
  return {
    command: "adversarial",
    executablePath: "/bin/adversarial",
    executableRealPath: "/bin/adversarial",
    executableMtimeNs: 1n,
    ecosystem: "fallback",
    packageName: "adversarial",
    version: "0.0.0",
    packageRoot: null,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings: [],
    shim: null,
    ...overrides,
  };
}
