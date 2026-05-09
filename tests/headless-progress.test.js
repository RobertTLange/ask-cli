import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { ProgressFormatter, ProgressSpinner, shouldColorProgress, shouldSpinProgress } from "../dist/cli/progress.js";
import { extractToolProgressEvents, HeadlessJsonStream } from "../dist/agents/headless-json.js";
import { eventually, jsonl, withEnv, withFakeNpx } from "./helpers/fake-headless.js";

test("progress formatter adds local timestamp and elapsed time", () => {
  const formatter = new ProgressFormatter({
    label: "ask[codex-default-high]",
    color: false,
    now: () => new Date(2026, 3, 30, 12, 34, 56),
    monotonicNow: () => 1_234,
    monotonicStartedAt: 0,
  });

  assert.equal(formatter.format("agent started"), "[12:34:56 +1.2s] ask[codex-default-high]: agent started\n");
});

test("progress color follows TTY and environment gates", async () => {
  assert.equal(shouldColorProgress({ isTTY: false }, {}), false);
  assert.equal(shouldColorProgress({ isTTY: true }, {}), true);
  assert.equal(shouldColorProgress({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(shouldColorProgress({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(shouldColorProgress({ isTTY: true }, { FORCE_COLOR: "0" }), false);

  await withEnv({ FORCE_COLOR: "1", NO_COLOR: undefined }, async () => {
    const formatter = new ProgressFormatter({
      label: "ask[codex-default-default]",
      now: () => new Date(2026, 3, 30, 12, 34, 56),
      monotonicNow: () => 0,
      monotonicStartedAt: 0,
    });
    assert.match(formatter.format("agent started"), /\x1b\[/);
  });
});

test("progress spinner writes a transient pre-log frame and clears it", () => {
  const writes = [];
  const spinner = new ProgressSpinner({
    emit: (text) => writes.push(text),
    enabled: true,
    intervalMs: 10_000,
  });

  spinner.start();
  spinner.stop();

  assert.equal(writes[0], "\rask: preparing |");
  assert.equal(writes.at(-1), "\r\x1b[2K");
});

test("progress spinner follows TTY and environment gates", () => {
  assert.equal(shouldSpinProgress({ isTTY: false }, {}), false);
  assert.equal(shouldSpinProgress({ isTTY: true }, {}), true);
  assert.equal(shouldSpinProgress({ isTTY: true }, { ASK_NO_SPINNER: "1" }), false);
});

test("Headless progress diagnostics stream before completion", async () => {
  const diagnostics = [];
  let completed = false;

  await withFakeNpx(async () => {
    const runPromise = run([
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text)).finally(() => {
      completed = true;
    });

    await eventually(() => diagnostics.join("").includes("ask[codex-default-default]: agent started") && !completed, 10_000);
    const result = await runPromise;

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /headless answer/);
  }, {
    stdout: jsonl([{ type: "agent_message", text: "headless answer" }]),
    sleepMs: 5_000,
  });

  const output = diagnostics.join("");
  assert.match(output, /ask\[codex-default-default\]: resolving fixture-cli-npm/);
  assert.match(output, /ask\[codex-default-default\]: collecting context/);
  assert.match(output, /ask\[codex-default-default\]: agent started/);
  assert.match(output, /ask\[codex-default-default\]: agent finished/);
});

test("Headless progress label includes agent model and reasoning", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-progress-label-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    [
      "[agents.headless]",
      "extraFlags = [\"--model\", \"sonnet\"]",
      "",
    ].join("\n"),
  );

  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await withEnv({ HOME: temp }, () => run([
      "--agent",
      "claude",
      "--reasoning-effort",
      "high",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text)));

    assert.equal(result.exitCode, 0);
  }, {
    printCommand: "/Users/rob/.local/bin/claude --model claude-opus-4-6 -p identity --output-format stream-json --verbose --effort high",
    stdout: jsonl([{ type: "agent_message", text: "headless answer" }]),
  });

  assert.match(diagnostics.join(""), /ask\[claude-claude-opus-4-6-high\]: agent started/);
});

test("Headless progress label resolves explicit Pi model and thinking effort", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--agent",
      "pi",
      "--reasoning-effort",
      "high",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    printCommand: "pi --no-session --mode json --provider openai-codex --model gpt-5.5 --thinking high --tools 'read,grep,find,ls' identity",
    stdout: jsonl([{ type: "agent_message", text: "headless answer" }]),
  });

  assert.match(diagnostics.join(""), /ask\[pi-gpt-5.5-high\]: agent started/);
});

test("Headless progress label resolves auto agent through print command", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--reasoning-effort",
      "high",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    printCommand: "printf %s prompt | codex --model gpt-5.5 --json -",
    stdout: jsonl([{ type: "agent_message", text: "headless answer" }]),
  });

  assert.match(diagnostics.join(""), /ask\[codex-gpt-5.5-high\]: agent started/);
  assert.doesNotMatch(diagnostics.join(""), /ask\[auto-default-high\]/);
});

test("Headless progress label tolerates slower npx print-command startup", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-slow-print-command-"));
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await withEnv({ HOME: temp }, () => run([
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text)));

    assert.equal(result.exitCode, 0);
  }, {
    printCommand: "printf %s prompt | codex --model gpt-5.5 --json -",
    sleepMs: 5_000,
    stdout: jsonl([{ type: "agent_message", text: "headless answer" }]),
  });

  assert.match(diagnostics.join(""), /ask\[codex-gpt-5.5-default\]: agent started/);
  assert.doesNotMatch(diagnostics.join(""), /ask\[auto-default-default\]/);
});

test("Headless progress label reads Codex configured reasoning for auto agent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-codex-reasoning-"));
  const codexConfigDir = join(temp, ".codex");
  await mkdir(codexConfigDir);
  await writeFile(join(codexConfigDir, "config.toml"), 'model_reasoning_effort = "high"\n');

  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await withEnv({ HOME: temp }, () => run([
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text)));

    assert.equal(result.exitCode, 0);
  }, {
    printCommand: "printf %s prompt | codex --model gpt-5.5 --json -",
    stdout: jsonl([{ type: "agent_message", text: "headless answer" }]),
  });

  assert.match(diagnostics.join(""), /ask\[codex-gpt-5.5-high\]: agent started/);
  assert.doesNotMatch(diagnostics.join(""), /ask\[codex-gpt-5.5-default\]/);
});

test("Headless JSONL parser handles split chunks and non-JSON warnings", async () => {
  const chunks = [
    "warning: noisy provider banner\n{\"type\":\"agent_",
    "message\",\"text\":\"split answer\"}\nnot json\n",
  ];

  await withFakeNpx(async () => {
    const result = await run(["--agent", "codex", "fixture-cli-npm", "How do I enable json output?"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /split answer/);
    assert.doesNotMatch(result.stdout, /warning: noisy/);
  }, { stdoutChunks: chunks, stderr: "stderr warning\n" });
});

test("Headless progress reports Codex-style file reads once", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    stdout: jsonl([
      {
        type: "item.completed",
        item: {
          type: "function_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "package/README.md" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: { path: "package/README.md" },
        },
      },
      { type: "agent_message", text: "headless answer" },
    ]),
  });

  assert.equal((diagnostics.join("").match(/ask\[codex-default-default\]: read package\/README\.md/g) ?? []).length, 1);
});

test("Headless progress reports real Codex command execution records", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    stdout: jsonl([
      { type: "thread.started", thread_id: "thread_1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/zsh -lc pwd",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/zsh -lc pwd",
          aggregated_output: "/Users/rob/Dropbox/projects/ask-cli\n",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "headless answer" } },
    ]),
  });

  const output = diagnostics.join("");
  assert.equal((output.match(/ask\[codex-default-default\]: run \/bin\/zsh -lc pwd/g) ?? []).length, 1);
  assert.doesNotMatch(output, /aggregated_output|Dropbox\/projects/);
});

test("Headless progress reports Claude-style file reads", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--agent",
      "claude",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    stdout: jsonl([
      {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          name: "open",
          input: { file_path: "ASK_CONTEXT.md" },
        },
      },
      { type: "result", result: "headless answer" },
    ]),
  });

  assert.match(diagnostics.join(""), /ask\[claude-default-default\]: read ASK_CONTEXT\.md/);
});

test("Headless progress extractor summarizes provider tool calls", () => {
  const records = [
    {
      provider: "codex",
      record: {
        type: "item.completed",
        item: { type: "command_execution", command: "npm test -- --runInBand", aggregated_output: "secret result" },
      },
      expected: "run npm test -- --runInBand",
    },
    {
      provider: "claude",
      record: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Grep", input: { pattern: "ProgressFormatter" } },
      },
      expected: "search ProgressFormatter",
    },
    {
      provider: "cursor",
      record: {
        type: "toolcall",
        toolName: "read_file",
        args: { filePath: "src/cli/index.ts" },
      },
      expected: "read src/cli/index.ts",
    },
    {
      provider: "gemini",
      record: {
        type: "message",
        message: {
          role: "model",
          parts: [{ functionCall: { name: "run_command", args: { cmd: ["npm", "test"] } } }],
        },
      },
      expected: "run npm test",
    },
    {
      provider: "opencode",
      record: {
        type: "part",
        part: { type: "tool", tool: "search", input: { query: "headless progress" } },
      },
      expected: "search headless progress",
    },
    {
      provider: "pi",
      record: {
        type: "payload",
        payload: { type: "tool_use", name: "inspect_symbols", input: { symbol: "HeadlessJsonStream" } },
      },
      expected: "tool inspect_symbols",
    },
  ];

  for (const { provider, record, expected } of records) {
    assert.deepEqual(
      extractToolProgressEvents(record).map((event) => event.text),
      [expected],
      provider,
    );
  }
});

test("Headless progress reports run search edit and unknown tool summaries once where deduped", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--agent",
      "gemini",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    stdout: jsonl([
      {
        type: "message",
        message: {
          role: "model",
          parts: [
            { functionCall: { name: "run_command", args: { command: "npm test" } } },
            { functionCall: { name: "run_command", args: { command: "npm test" } } },
            { functionCall: { name: "grep", args: { pattern: "json output" } } },
            { functionCall: { name: "edit", args: { path: "src/cli/index.ts" } } },
            { functionCall: { name: "inspect_symbols", args: { symbol: "runQuestion" } } },
          ],
        },
      },
      { type: "agent_message", text: "headless answer" },
    ]),
  });

  const output = diagnostics.join("");
  assert.equal((output.match(/ask\[gemini-default-default\]: run npm test/g) ?? []).length, 1);
  assert.match(output, /ask\[gemini-default-default\]: search json output/);
  assert.match(output, /ask\[gemini-default-default\]: edit src\/cli\/index\.ts/);
  assert.match(output, /ask\[gemini-default-default\]: tool inspect_symbols/);
});

test("Headless parser joins Gemini final delta message chunks after tool use", () => {
  const stream = new HeadlessJsonStream();
  stream.push(jsonl([
    { type: "message", role: "assistant", content: "I will inspect", delta: true },
    { type: "message", role: "assistant", content: " the files first.", delta: true },
    { type: "tool_use", tool_name: "read_file", parameters: { file_path: "ASK_CONTEXT.md" } },
    { type: "tool_result", tool_id: "tool_1", status: "success", output: "not answer text" },
    { type: "message", role: "assistant", content: "Lint rules are configured in ", delta: true },
    { type: "message", role: "assistant", content: "`pyproject.toml", delta: true },
    { type: "message", role: "assistant", content: ":328`.", delta: true },
    { type: "result", status: "success", stats: { total_tokens: 328 } },
  ]));

  assert.equal(stream.finalAnswer("gemini"), "Lint rules are configured in `pyproject.toml:328`.");
});

test("Headless progress remains stderr-only for ask JSON output", async () => {
  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--json",
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).answer, "headless answer");
    assert.doesNotMatch(result.stdout, /ask\[/);
  });

  assert.match(diagnostics.join(""), /ask\[codex-default-default\]: agent started/);
});

test("agent none and debug mode do not emit progress diagnostics", async () => {
  const none = await run(["--agent", "none", "fixture-cli-npm", "How do I enable json output?"]);
  assert.doesNotMatch(none.stderr ?? "", /ask\[/);

  const diagnostics = [];
  await withFakeNpx(async () => {
    const result = await run([
      "--debug",
      "--agent",
      "codex",
      "fixture-cli-npm",
      "How do I enable json output?",
    ], (text) => diagnostics.push(text));

    assert.equal(result.exitCode, 0);
  }, {
    stdout: "raw trace\n--- final message ---\ndebug answer\n",
  });

  const output = diagnostics.join("");
  assert.match(output, /----- ask agent trace -----/);
  assert.doesNotMatch(output, /\[[0-9]{2}:[0-9]{2}:[0-9]{2} \+[0-9.]+s\] ask\[/);
});
