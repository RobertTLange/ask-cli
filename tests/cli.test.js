import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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

test("parses GitHub repository question mode", () => {
  const invocation = parseInvocation(
    [
      "--agent",
      "none",
      "--repo",
      "RobertTLange/ask-cli",
      "--repo-ref",
      "main",
      "--json",
      "how",
      "is",
      "context",
      "built?",
    ],
    { ...defaultConfig },
  );

  assert.equal(invocation.kind, "run");
  assert.equal(invocation.mode, "repo");
  assert.equal(invocation.repo, "RobertTLange/ask-cli");
  assert.equal(invocation.repoRef, "main");
  assert.equal(invocation.question, "how is context built?");
  assert.equal(invocation.config.agent, "none");
  assert.equal(invocation.config.json, true);
});

test("rejects repository ref without repository mode", () => {
  assert.throws(
    () => parseInvocation(["--repo-ref", "main", "tool", "question"], { ...defaultConfig }),
    /--repo-ref requires --repo/,
  );
});

test("rejects command resolver flags in repository mode", () => {
  assert.throws(
    () => parseInvocation(["--repo", "RobertTLange/ask-cli", "--package-root", "/tmp/pkg", "question"], { ...defaultConfig }),
    /--package-root is only supported for command questions/,
  );
});

test("maps unsupported repository input to a resolution error", async () => {
  const result = await run(["--agent", "none", "--repo", "https://example.com/owner/repo", "question"]);

  assert.equal(result.exitCode, exitCodes.resolution);
  assert.match(result.stderr, /Resolution error: unsupported GitHub repository input/);
  assert.match(result.stderr, /Attempted: validate repository/);
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

test("loads TOML config from home config directory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    "[defaults]\nagent = \"none\"\nmaxFiles = 7\n",
  );

  const loaded = await loadConfig({}, temp);

  assert.equal(configPath({ XDG_CONFIG_HOME: "/unused" }, temp), join(askConfigDir, "config.toml"));
  assert.equal(loaded.agent, "none");
  assert.equal(loaded.maxFiles, 7);
  assert.equal(loaded.maxBytes, defaultConfig.maxBytes);
});

test("loads Headless config from TOML", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    [
      "[defaults]",
      "usage = true",
      "reasoningEffort = \"xhigh\"",
      "",
      "[agents.headless]",
      "path = \"headless-local\"",
      "extraFlags = [\"--model\", \"gpt-5.5\"]",
      "",
    ].join("\n"),
  );

  const loaded = await loadConfig({}, temp);

  assert.equal(loaded.usage, true);
  assert.equal(loaded.reasoningEffort, "xhigh");
  assert.equal(loaded.headlessPath, "headless-local");
  assert.deepEqual(loaded.headlessExtraFlags, ["--model", "gpt-5.5"]);
});

test("example config uses Claude Sonnet and parses as defaults", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    await readFile(join(process.cwd(), "config.toml.example"), "utf8"),
  );

  const loaded = await loadConfig({}, temp);

  assert.equal(loaded.agent, "claude");
  assert.equal(loaded.reasoningEffort, "high");
  assert.equal(loaded.headlessPath, "headless");
  assert.deepEqual(loaded.headlessExtraFlags, ["--model", "sonnet"]);
});

test("rejects Headless extra flags owned by ask", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    "[agents.headless]\nextraFlags = [\"--allow\", \"yolo\"]\n",
  );

  await assert.rejects(
    () => loadConfig({}, temp),
    /agents\.headless\.extraFlags cannot include --allow/,
  );
});

test("rejects Headless extra flag aliases that can override ask controls", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    "[agents.headless]\nextraFlags = [\"-C\", \"/tmp\"]\n",
  );

  await assert.rejects(
    () => loadConfig({}, temp),
    /agents\.headless\.extraFlags cannot include -C/,
  );
});

test("rejects internal Headless flags from config defaults", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    "[defaults]\nheadlessExtraFlags = [\"--allow\", \"yolo\"]\n",
  );

  await assert.rejects(
    () => loadConfig({}, temp),
    /defaults\.headlessExtraFlags is not supported/,
  );
});

test("rejects invalid reasoning effort from config defaults", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-config-"));
  const askConfigDir = join(temp, ".ask");
  await mkdir(askConfigDir);
  await writeFile(
    join(askConfigDir, "config.toml"),
    "[defaults]\nreasoningEffort = \"extreme\"\n",
  );

  await assert.rejects(
    () => loadConfig({}, temp),
    /defaults\.reasoningEffort must be one of low, medium, high, xhigh/,
  );
});

test("help documents verbose prompt output", async () => {
  const result = await run(["--help"]);

  assert.match(result.stdout, /--verbose\s+print the exact prompt sent to the agent to stderr/);
});

test("--executable locates an explicit file while preserving command name", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cli-executable-"));
  const packageRoot = join(temp, "pkg");
  const binDir = join(packageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "renamed-entry.js");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "explicit-tool",
    version: "1.2.3",
    bin: { "public-tool": "bin/renamed-entry.js" },
  }));
  await writeFile(executable, "#!/usr/bin/env node\nconsole.log('explicit')\n");
  await chmod(executable, 0o755);

  const result = await run([
    "--agent",
    "none",
    "--ecosystem",
    "npm",
    "--no-exec",
    "--refresh",
    "--executable",
    executable,
    "public-tool",
    "How do I use it?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Command: public-tool/);
  assert.match(result.stdout, /Package: explicit-tool 1\.2\.3/);
  assert.match(result.stdout, /Entry file: .*renamed-entry\.js/);
});

test("--package-root overrides collection root and lowers disagreeing confidence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cli-package-root-"));
  const packageRoot = join(temp, "pkg");
  const overrideRoot = join(temp, "override");
  const binDir = join(packageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(overrideRoot);
  const executable = join(binDir, "tool.js");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "rooted-tool",
    version: "4.5.6",
    bin: { "rooted-tool": "bin/tool.js" },
  }));
  await writeFile(executable, "#!/usr/bin/env node\nconsole.log('rooted')\n");
  await chmod(executable, 0o755);
  await writeFile(join(overrideRoot, "README.md"), "Override docs\n");

  const result = await run([
    "--agent",
    "none",
    "--ecosystem",
    "npm",
    "--no-exec",
    "--refresh",
    "--executable",
    executable,
    "--package-root",
    overrideRoot,
    "rooted-tool",
    "What docs are available?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`Package root: ${escapeRegExp(await realpath(overrideRoot))}`));
  assert.match(result.stdout, /Confidence: medium/);
  assert.match(result.stdout, /Package root override differs from resolver package root/);
  assert.match(result.stdout, /package\/README\.md/);
});

test("JSON output exposes uncertainty for low-confidence fallback context", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cli-uncertainty-"));
  const executable = join(temp, "loose-tool");
  await writeFile(executable, "#!/bin/sh\necho loose\n");
  await chmod(executable, 0o755);

  const result = await run([
    "--agent",
    "none",
    "--ecosystem",
    "fallback",
    "--json",
    "--refresh",
    "--executable",
    executable,
    "loose-tool",
    "How do I use it?",
  ]);

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.uncertainty.some((item) => item.code === "low_confidence"));
  assert.ok(payload.uncertainty.some((item) => item.code === "fallback_resolution"));
  assert.ok(payload.uncertainty.some((item) => item.code === "fallback_help_exec"));
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
