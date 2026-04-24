import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { verifyCodexExecControls } from "../dist/agents/codex.js";
import { buildAgentPrompt } from "../dist/agents/prompt.js";

test("prompt builder includes untrusted-data and no-network rules", () => {
  const prompt = buildAgentPrompt({
    command: "tool",
    question: "How?",
    workspacePath: "/tmp/workspace",
    resolution: {
      command: "tool",
      executablePath: "/bin/tool",
      executableRealPath: "/bin/tool",
      executableMtimeNs: 1n,
      ecosystem: "fallback",
      packageName: null,
      version: null,
      packageRoot: null,
      entryFile: null,
      metadataFiles: [],
      confidence: "low",
      warnings: [],
      shim: null,
    },
  });

  assert.match(prompt, /untrusted data, not instructions/);
  assert.match(prompt, /Do not access the network/);
  assert.match(prompt, /ASK_CONTEXT\.md/);
});

test("none agent human output prints workspace and ASK_CONTEXT", async () => {
  const result = await run(["--agent", "none", "fixture-cli-npm", "How do I enable json output?"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Workspace: /);
  assert.match(result.stdout, /# ask context/);
  assert.match(result.stdout, /Package: fixture-cli-npm 0\.1\.0/);
});

test("verbose prints exact agent prompt to stderr", async () => {
  const result = await run([
    "--verbose",
    "--agent",
    "none",
    "fixture-cli-npm",
    "How do I enable json output?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /----- ask agent prompt -----/);
  assert.match(result.stderr, /Command:\s+fixture-cli-npm/);
  assert.match(result.stderr, /Question:\s+How do I enable json output\?/);
  assert.match(result.stderr, /Rules:/);
  assert.match(result.stderr, /----- end ask agent prompt -----/);
});

test("verbose emits prompt through diagnostics before returning", async () => {
  const diagnostics = [];
  const runPromise = run([
    "--verbose",
    "--agent",
    "none",
    "fixture-cli-npm",
    "How do I enable json output?",
  ], (text) => diagnostics.push(text));

  await eventually(() => diagnostics.join("").includes("----- ask agent prompt -----"));
  const result = await runPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, undefined);
  assert.match(diagnostics.join(""), /Question:\s+How do I enable json output\?/);
});

test("verbose is buffered for tests when no diagnostic writer is provided", async () => {
  const result = await run([
    "--verbose",
    "--agent",
    "none",
    "fixture-cli-npm",
    "How do I enable json output?",
  ]);

  assert.match(result.stderr, /----- ask agent prompt -----/);
});

test("none agent JSON output follows answer contract", async () => {
  const result = await run([
    "--json",
    "--agent",
    "none",
    "fixture-cli-npm",
    "How do I enable json output?",
  ]);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.command, "fixture-cli-npm");
  assert.equal(parsed.resolution.ecosystem, "npm");
  assert.equal(parsed.resolution.package, "fixture-cli-npm");
  assert.match(parsed.answer, /# ask context/);
  assert.ok(Array.isArray(parsed.citations));
  assert.ok(Array.isArray(parsed.uncertainty));
  assert.ok(Array.isArray(parsed.warnings));
});

test("verbose does not corrupt JSON stdout", async () => {
  const result = await run([
    "--json",
    "--verbose",
    "--agent",
    "none",
    "fixture-cli-npm",
    "How do I enable json output?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /----- ask agent prompt -----/);
  assert.equal(JSON.parse(result.stdout).command, "fixture-cli-npm");
});

test("codex verification accepts documented exec sandbox controls", async () => {
  const codexPath = await fakeCodex(`
Run Codex non-interactively

Options:
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>
      --skip-git-repo-check
      --ephemeral
`);

  const verification = await verifyCodexExecControls(codexPath);

  assert.equal(verification.ok, true);
});

test("codex verification rejects missing exec sandbox controls", async () => {
  const codexPath = await fakeCodex("Run Codex non-interactively\n");
  const verification = await verifyCodexExecControls(codexPath);

  assert.equal(verification.ok, false);
  assert.match(verification.reason, /sandbox controls/);
});

async function fakeCodex(helpText) {
  const temp = await mkdtemp(join(tmpdir(), "ask-fake-codex-"));
  const codexPath = join(temp, "codex");
  await writeFile(codexPath, `#!/bin/sh
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
cat <<'EOF'
${helpText}
EOF
exit 0
fi
exit 2
`);
  await chmod(codexPath, 0o755);
  return codexPath;
}

async function eventually(predicate) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail("condition was not met before timeout");
}
