import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
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
  assert.match(prompt, /access the network/);
  assert.match(prompt, /read-only inspection commands/);
  assert.doesNotMatch(prompt, /Do not execute commands/);
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

test("default agent invokes Headless without an explicit backend", async () => {
  const { capturePath } = await withFakeNpx(async () => {
    const result = await run(["fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /headless answer/);
  });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.deepEqual(capture.argv.slice(0, 8), [
    "-y",
    "@roberttlange/headless",
    "--allow",
    "read-only",
    "--work-dir",
    capture.argv[5],
    "--prompt-file",
    capture.argv[7],
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
  assert.deepEqual(capture.argv.slice(3, 7), ["--allow", "read-only", "--work-dir", capture.argv[6]]);
});

test("Headless receives reasoning effort and usage flags", async () => {
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
  }, { stdout: 'headless answer\n{"usage":{"totalTokens":42}}\n' });

  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  assert.ok(capture.argv.includes("--usage"));
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
  }, { stdout: 'headless answer\n{"usage":{"totalTokens":42}}\n' });
});

test("Headless path and extra flags come from config", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, "ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.json"),
    JSON.stringify({
      agents: { headless: { path: "headless-local", extraFlags: ["--model", "gpt-5.5"] } },
    }),
  );

  const { capturePath } = await withFakeHeadless("headless-local", async () => {
    const result = await withEnv({ XDG_CONFIG_HOME: temp }, () => run([
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
  assert.deepEqual(capture.argv.slice(0, 5), ["codex", "--allow", "read-only", "--work-dir", capture.argv[4]]);
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

    await eventually(() => diagnostics.join("").includes("live-debug") && !completed);
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

async function withFakeNpx(callback, options = {}) {
  return withFakeHeadless("npx", callback, options);
}

async function withFakeHeadless(command, callback, options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "ask-fake-headless-"));
  const capturePath = join(temp, "capture.json");
  const commandPath = join(temp, command);
  await writeFile(commandPath, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const promptFileIndex = argv.indexOf("--prompt-file");
writeFileSync(process.env.ASK_NPX_CAPTURE, JSON.stringify({
  command: process.argv[1].split("/").pop(),
  argv,
  cwd: process.cwd(),
  promptFile: promptFileIndex === -1 ? "" : readFileSync(argv[promptFileIndex + 1], "utf8")
}));
if (process.env.ASK_NPX_STDERR) {
  process.stderr.write(process.env.ASK_NPX_STDERR);
}
if (process.env.ASK_NPX_GRANDCHILD_MARKER) {
  const child = spawn(process.execPath, [
    "-e",
    "setTimeout(() => require('node:fs').writeFileSync(process.env.ASK_NPX_GRANDCHILD_MARKER, 'alive'), Number(process.env.ASK_NPX_GRANDCHILD_DELAY_MS || '1500'))",
  ], { env: process.env, stdio: "ignore" });
  child.unref();
}
process.stdout.write(process.env.ASK_NPX_STDOUT || "headless answer\\n");
const exitCode = Number(process.env.ASK_NPX_EXIT || "0");
const sleepMs = Number(process.env.ASK_NPX_SLEEP_MS || "0");
if (sleepMs > 0) {
  setTimeout(() => process.exit(exitCode), sleepMs);
} else {
  process.exit(exitCode);
}
`);
  await chmod(commandPath, 0o755);

  const previous = {
    PATH: process.env.PATH,
    ASK_NPX_CAPTURE: process.env.ASK_NPX_CAPTURE,
    ASK_NPX_EXIT: process.env.ASK_NPX_EXIT,
    ASK_NPX_STDERR: process.env.ASK_NPX_STDERR,
    ASK_NPX_STDOUT: process.env.ASK_NPX_STDOUT,
    ASK_NPX_SLEEP_MS: process.env.ASK_NPX_SLEEP_MS,
    ASK_NPX_GRANDCHILD_MARKER: process.env.ASK_NPX_GRANDCHILD_MARKER,
    ASK_NPX_GRANDCHILD_DELAY_MS: process.env.ASK_NPX_GRANDCHILD_DELAY_MS,
  };

  try {
    return await withEnv({
      PATH: `${temp}${delimiter}${process.env.PATH ?? ""}`,
      ASK_NPX_CAPTURE: capturePath,
      ASK_NPX_EXIT: options.exitCode === undefined ? undefined : String(options.exitCode),
      ASK_NPX_STDERR: options.stderr,
      ASK_NPX_STDOUT: options.stdout,
      ASK_NPX_SLEEP_MS: options.sleepMs === undefined ? undefined : String(options.sleepMs),
      ASK_NPX_GRANDCHILD_MARKER: options.grandchildMarker,
      ASK_NPX_GRANDCHILD_DELAY_MS: options.grandchildDelayMs === undefined ? undefined : String(options.grandchildDelayMs),
    }, async () => ({ capturePath, result: await callback() }));
  } finally {
    restoreEnv(previous);
  }
}

async function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    setOptionalEnv(key, value);
  }

  try {
    return await callback();
  } finally {
    restoreEnv(previous);
  }
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    setOptionalEnv(key, value);
  }
}

function setOptionalEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
