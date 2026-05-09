import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { buildAgentPrompt } from "../dist/agents/prompt.js";
import { delay, eventually, jsonl, withEnv, withFakeHeadless, withFakeNpx } from "./helpers/fake-headless.js";

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
  assert.match(prompt, /access the network/);
  assert.match(prompt, /read-only inspection commands/);
  assert.match(prompt, /Use relative paths/);
  assert.match(prompt, /Workspace:\s+\./);
  assert.doesNotMatch(prompt, /\/tmp\/workspace/);
  assert.doesNotMatch(prompt, /Do not execute commands/);
  assert.match(prompt, /ASK_CONTEXT\.md/);
});

test("none agent human output prints workspace and ASK_CONTEXT", async () => {
  const result = await run(["--agent", "none", "fixture-cli-npm", "How do I enable json output?"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Workspace: /);
  assert.match(result.stdout, /# ask context/);
  assert.match(result.stdout, /Package: fixture-cli-npm 0\.1\.0/);
  assert.doesNotMatch(result.stderr ?? "", /^ask:/m);
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

test("default agent invokes Headless without an explicit backend", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run(["fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /headless answer/);
  });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 9), [
    "-y",
    "@roberttlange/headless",
    "--json",
    "--allow",
    "read-only",
    "--work-dir",
    capture.argv[6],
    "--prompt-file",
    capture.argv[8],
  ]);
  assert.match(capture.cwd, /ask-/);
  assert.match(capture.promptFile, /Question:\s+How do I enable json output\?/);
});

test("explicit coding agent is passed to Headless", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run(["--agent", "claude", "fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /headless answer/);
  });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 3), ["-y", "@roberttlange/headless", "claude"]);
  assert.deepEqual(capture.argv.slice(3, 8), ["--json", "--allow", "read-only", "--work-dir", capture.argv[7]]);
});

test("Headless receives reasoning effort and omits usage flag in JSON trace mode", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run([
      "--agent",
      "codex",
      "--reasoning-effort",
      "high",
      "--usage",
      "fixture-cli-npm",
      "How do I enable json output?",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /headless answer/);
    assert.match(result.stdout, /"usage"/);
  }, { stdout: jsonl([
    { type: "agent_message", text: "headless answer" },
    { type: "turn.completed", usage: { totalTokens: 42 } },
  ]) });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.ok(capture.argv.includes("--json"));
  assert.ok(!capture.argv.includes("--usage"));
  assert.deepEqual(capture.argv.slice(capture.argv.indexOf("--reasoning-effort"), capture.argv.indexOf("--reasoning-effort") + 2), [
    "--reasoning-effort",
    "high",
  ]);
});

test("JSON usage output is structured outside the answer", async () => {
  await withFakeNpx(async () => {
    const result = await run([
      "--json",
      "--usage",
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ]);

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.answer, "headless answer");
    assert.deepEqual(parsed.usage, { totalTokens: 42 });
  }, { stdout: jsonl([
    { type: "agent_message", text: "headless answer" },
    { type: "turn.completed", usage: { totalTokens: 42 } },
  ]) });
});

test("Headless path and extra flags come from config", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    [
      "[agents.headless]",
      "path = \"headless-local\"",
      "extraFlags = [\"--model\", \"gpt-5.5\"]",
      "",
    ].join("\n"),
  );

  const { capturePath } = await withFakeHeadless("headless-local", async () => {
    const result = await withEnv({ HOME: temp }, () => run([
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ]));

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /headless answer/);
  });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(capture.command, "headless-local");
  assert.deepEqual(capture.argv.slice(0, 6), ["codex", "--json", "--allow", "read-only", "--work-dir", capture.argv[5]]);
  assert.deepEqual(capture.argv.slice(-2), ["--model", "gpt-5.5"]);
});

test("Headless failure maps to agent exit code", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run(["--agent", "codex", "fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /Agent error: headless boom/);
  }, { exitCode: 7, stderr: "headless boom\n" });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 3), ["-y", "@roberttlange/headless", "codex"]);
});

test("debug mode delegates trace streaming and final extraction to Headless", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run(["--debug", "--agent", "codex", "fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /debug final answer/);
    assert.match(result.stderr, /"type":"agent_message"/);
    assert.doesNotMatch(result.stderr, /debug final answer/);
  }, { stdout: '{"type":"agent_message","text":"trace only"}\\n--- final message ---\\ndebug final answer\\n' });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 3), ["-y", "@roberttlange/headless", "codex"]);
  assert.ok(capture.argv.includes("--debug"));
  assert.ok(!capture.argv.includes("--json"));
});

test("debug mode streams Headless trace diagnostics before completion", async () => {
  const diagnostics = [];
  let completed = false;
  await withFakeNpx(async () => {
    const runPromise = run([
      "--debug",
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text)).finally(() => {
      completed = true;
    });

    await eventually(() => diagnostics.join("").includes("live-debug") && !completed, 10_000);
    const result = await runPromise;

    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /"stage":"locate"/);
    assert.match(result.stdout, /debug final answer/);
  }, {
    stdout: '{"type":"agent_message","text":"live-debug"}\\n--- final message ---\\ndebug final answer\\n',
    sleepMs: 1_500,
  });
});

test("debug mode prints partial Headless trace when the agent times out", async () => {
  const resultPromise = withFakeNpx(async () => run([
    "--debug",
    "--agent-timeout",
    "1",
    "--agent",
    "codex",
    "fixture-cli-npm",
    "How do I enable json output?",
  ]), {
    stdout: '{"type":"thread.started","thread_id":"debug-timeout"}\\n',
    sleepMs: 5_000,
  });

  const { result } = await resultPromise;
  assert.equal(result.exitCode, 4);
  assert.match(result.stderr, /ask agent trace/);
  assert.match(result.stderr, /debug-timeout/);
  assert.match(result.stderr, /headless timed out after 1s/);
});

test("Headless prompt file is removed after completion", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run(["--agent", "codex", "fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 0);
  });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  const promptFilePath = capture.argv[capture.argv.indexOf("--prompt-file") + 1];
  await assert.rejects(() => readFile(promptFilePath, "utf8"), /ENOENT/);
});

test("Headless timeout terminates descendant processes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-headless-descendant-"));
  const markerPath = join(temp, "descendant-alive");
  try {
    const { result } = await withFakeNpx(async () => run([
      "--agent-timeout",
      "1",
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ]), {
      grandchildMarker: markerPath,
      grandchildDelayMs: 1_800,
      sleepMs: 5_000,
    });

    assert.equal(result.exitCode, 4);
    assert.match(result.stderr, /headless timed out after 1s/);
    await delay(2_200);
    await assert.rejects(() => readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});
