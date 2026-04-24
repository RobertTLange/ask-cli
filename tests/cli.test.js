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
      "--keep-workspace",
      "--refresh",
      "--no-exec",
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
  assert.equal(invocation.config.keepWorkspace, true);
  assert.equal(invocation.config.refresh, true);
  assert.equal(invocation.config.noExec, true);
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
      agent: "codex",
      maxFiles: 10,
      maxBytes: 100,
    },
  );

  assert.equal(invocation.kind, "run");
  assert.equal(invocation.config.agent, "none");
  assert.equal(invocation.config.maxFiles, 20);
  assert.equal(invocation.config.maxBytes, 100);
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

test("help documents verbose prompt output", async () => {
  const result = await run(["--help"]);

  assert.match(result.stdout, /--verbose\s+print the exact prompt sent to the agent to stderr/);
});
