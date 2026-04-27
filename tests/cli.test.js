import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseInvocation } from "../dist/cli/args.js";
import { configPath, loadConfig } from "../dist/cli/config.js";
import { defaultConfig, exitCodes } from "../dist/cli/constants.js";
import { run } from "../dist/cli/index.js";

test("--help exits successfully", async () => {
  const result = await run(["--help"]);

  assert.equal(result.exitCode, exitCodes.success);
  assert.match(result.stdout, /^ask <command> <question>/);
});

test("--version exits successfully", async () => {
  const result = await run(["--version"]);

  assert.equal(result.exitCode, exitCodes.success);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("missing args are usage errors", async () => {
  const result = await run([]);

  assert.equal(result.exitCode, exitCodes.usage);
  assert.match(result.stderr, /Usage error: missing command/);
});

test("parses documented flags and joins question words", () => {
  const invocation = parseInvocation(
    [
      "--agent",
      "none",
      "--ecosystem",
      "npm",
      "--json",
      "--debug",
      "--verbose",
      "--usage",
      "--keep-workspace",
      "--refresh",
      "--no-exec",
      "--reasoning-effort",
      "high",
      "--max-files",
      "12",
      "--max-bytes",
      "4096",
      "--agent-timeout",
      "9",
      "--package-root",
      "/tmp/pkg",
      "--executable",
      "/tmp/bin/tool",
      "tool",
      "how",
      "now",
    ],
    { ...defaultConfig },
  );

  assert.equal(invocation.kind, "run");
  assert.equal(invocation.command, "tool");
  assert.equal(invocation.question, "how now");
  assert.equal(invocation.config.agent, "none");
  assert.equal(invocation.config.ecosystem, "npm");
  assert.equal(invocation.config.json, true);
  assert.equal(invocation.config.debug, true);
  assert.equal(invocation.config.verbose, true);
  assert.equal(invocation.config.usage, true);
  assert.equal(invocation.config.keepWorkspace, true);
  assert.equal(invocation.config.refresh, true);
  assert.equal(invocation.config.noExec, true);
  assert.equal(invocation.config.reasoningEffort, "high");
  assert.equal(invocation.config.maxFiles, 12);
  assert.equal(invocation.config.maxBytes, 4096);
  assert.equal(invocation.config.agentTimeout, 9);
  assert.equal(invocation.config.packageRoot, "/tmp/pkg");
  assert.equal(invocation.config.executable, "/tmp/bin/tool");
});

test("CLI flags override config defaults", () => {
  const invocation = parseInvocation(
    ["--agent", "none", "--max-files", "20", "tool", "question"],
    {
      ...defaultConfig,
      agent: "auto",
      maxFiles: 10,
      maxBytes: 100,
    },
  );

  assert.equal(invocation.kind, "run");
  assert.equal(invocation.config.agent, "none");
  assert.equal(invocation.config.maxFiles, 20);
  assert.equal(invocation.config.maxBytes, 100);
});

test("default agent uses Headless auto selection", () => {
  const invocation = parseInvocation(["tool", "question"], { ...defaultConfig });

  assert.equal(invocation.kind, "run");
  assert.equal(invocation.config.agent, "auto");
  assert.equal(invocation.config.agentTimeout, 600);
});

test("parses Headless coding agent names", () => {
  for (const agent of ["codex", "claude", "cursor", "gemini", "opencode", "pi"]) {
    const invocation = parseInvocation(["--agent", agent, "tool", "question"], { ...defaultConfig });

    assert.equal(invocation.kind, "run");
    assert.equal(invocation.config.agent, agent);
  }
});

test("rejects unsupported reasoning effort", () => {
  assert.throws(
    () => parseInvocation(["--reasoning-effort", "extreme", "tool", "question"], { ...defaultConfig }),
    /unsupported --reasoning-effort: extreme/,
  );
});

test("loads config from XDG_CONFIG_HOME", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, "ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.json"),
    JSON.stringify({ defaults: { agent: "none", maxFiles: 7 } }),
  );

  const loaded = await loadConfig({ XDG_CONFIG_HOME: temp }, "/unused");

  assert.equal(configPath({ XDG_CONFIG_HOME: temp }, "/unused"), join(askConfigDir, "config.json"));
  assert.equal(loaded.agent, "none");
  assert.equal(loaded.maxFiles, 7);
  assert.equal(loaded.maxBytes, defaultConfig.maxBytes);
});

test("loads Headless config from XDG_CONFIG_HOME", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, "ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.json"),
    JSON.stringify({
      defaults: { usage: true, reasoningEffort: "xhigh" },
      agents: { headless: { path: "headless-local", extraFlags: ["--model", "gpt-5.5"] } },
    }),
  );

  const loaded = await loadConfig({ XDG_CONFIG_HOME: temp }, "/unused");

  assert.equal(loaded.usage, true);
  assert.equal(loaded.reasoningEffort, "xhigh");
  assert.equal(loaded.headlessPath, "headless-local");
  assert.deepEqual(loaded.headlessExtraFlags, ["--model", "gpt-5.5"]);
});

test("rejects Headless extra flags owned by ask", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, "ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.json"),
    JSON.stringify({ agents: { headless: { extraFlags: ["--allow", "yolo"] } } }),
  );

  await assert.rejects(
    () => loadConfig({ XDG_CONFIG_HOME: temp }, "/unused"),
    /agents\.headless\.extraFlags cannot include --allow/,
  );
});

test("help documents verbose prompt output", async () => {
  const result = await run(["--help"]);

  assert.match(result.stdout, /--verbose\s+print the exact prompt sent to the agent to stderr/);
});
