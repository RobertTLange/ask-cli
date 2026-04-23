import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { verifyCodexControls } from "../dist/agents/codex.js";
import { buildAgentPrompt } from "../dist/agents/prompt.js";
import { findOnPath } from "../dist/resolvers/locate.js";

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

test("codex verification refuses unverifiable no-network controls", async () => {
  const codexPath = process.env.ASK_CODEX_PATH
    ?? (process.env.ASK_E2E ? await findOnPath("codex", process.env.PATH) : null);
  if (!codexPath) {
    assert.ok(true);
    return;
  }

  const verification = await verifyCodexControls(codexPath);
  assert.equal(verification.ok, false);
  assert.match(verification.reason, /no-network|unable to inspect|read-only/);
});
