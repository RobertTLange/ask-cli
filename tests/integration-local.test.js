import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const agents = ["claude", "codex", "cursor", "gemini", "opencode", "pi"];
const selectedAgents = parseSelectedAgents(process.env.ASK_INTEGRATION_AGENTS);
const commandTimeoutMs = Number.parseInt(process.env.ASK_INTEGRATION_TIMEOUT_MS ?? "300000", 10);
const suiteNonce = `ask-local-${Date.now()}-${process.pid}`;

function parseSelectedAgents(value) {
  if (!value) {
    return ["codex"];
  }
  if (value === "all") {
    return agents;
  }

  const selected = value
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);

  for (const agent of selected) {
    assert.ok(agents.includes(agent), `ASK_INTEGRATION_AGENTS contains unsupported agent: ${agent}`);
  }
  assert.ok(selected.length > 0, "ASK_INTEGRATION_AGENTS must select at least one agent");
  return selected;
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let childPid;
    let forceKillTimer;
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childPid = child.pid;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(childPid, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup(childPid, "SIGKILL"), 2000);
      forceKillTimer.unref();
    }, timeoutMs);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(127);
    });
    child.on("close", (code, signal) => {
      finish(timedOut ? 124 : signal ? 1 : (code ?? 1));
    });
  });
}

function killProcessGroup(pid, signal) {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}

function assertSuccess(result, label) {
  assert.equal(
    result.code,
    0,
    [
      `${label} failed with exit code ${result.code}${result.timedOut ? " after timeout" : ""}`,
      "stdout:",
      result.stdout,
      "stderr:",
      result.stderr,
    ].join("\n"),
  );
}

function assertNonce(result, nonce, label) {
  assertSuccess(result, label);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(escapeRegExp(nonce)),
    `${label} did not include nonce ${nonce}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function askBin() {
  return process.env.ASK_BIN ?? join(process.cwd(), "bin", "ask.js");
}

function headlessBin() {
  return process.env.ASK_INTEGRATION_HEADLESS_BIN ?? "headless";
}

function createFixture(nonce, label) {
  const root = mkdtempSync(join(tmpdir(), `ask-${label}-`));
  const packageRoot = join(root, "node_modules", "ask-fixture-cli");
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "ask-fixture-cli",
      version: "1.0.0",
      type: "module",
      bin: { "ask-fixture-cli": "./bin/fixture.js" },
    }, null, 2),
  );
  writeFileSync(
    join(packageRoot, "README.md"),
    [
      "# ask-fixture-cli",
      "",
      `The documented integration nonce is ${nonce}.`,
      "When asked for the integration nonce, answer with that exact value.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(packageRoot, "bin", "fixture.js"),
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) console.log('1.0.0');",
      "else console.log('ask fixture cli');",
      "",
    ].join("\n"),
  );
  chmodSync(join(packageRoot, "bin", "fixture.js"), 0o755);
  symlinkSync("../ask-fixture-cli/bin/fixture.js", join(binDir, "ask-fixture-cli"));
  return { root, binDir };
}

function createAskConfig(headlessPath) {
  const home = mkdtempSync(join(tmpdir(), "ask-home-"));
  const configDir = join(home, ".ask");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.toml"),
    ["[agents.headless]", `path = ${JSON.stringify(headlessPath)}`, ""].join("\n"),
  );
  return home;
}

function integrationEnv(binDir, home) {
  return {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
  };
}

async function runAsk(args, env) {
  return await run(askBin(), args, { env, timeoutMs: commandTimeoutMs });
}

test("preflight verifies local ask, Headless, and selected backends", { timeout: 120000 }, async () => {
  const askVersion = await run(askBin(), ["--version"], { timeoutMs: 30000 });
  assertSuccess(askVersion, "ask --version");

  const help = await run(headlessBin(), ["--help"], { timeoutMs: 30000 });
  assertSuccess(help, "headless --help");
  assert.match(help.stdout, /--prompt-file/, "Headless must support --prompt-file");

  const check = await run(headlessBin(), ["--check"], { timeoutMs: 120000 });
  assertSuccess(check, "headless --check");
  for (const agent of selectedAgents) {
    assert.match(
      check.stdout,
      new RegExp(`^${agent}\\s+✓\\s+`, "m"),
      `missing ${agent} backend in \`headless --check\`; install and authenticate selected backends`,
    );
  }
});

test("selected agents answer from ask-cli staged context", { timeout: commandTimeoutMs * selectedAgents.length }, async () => {
  for (const agent of selectedAgents) {
    const nonce = `${suiteNonce}-${agent}`;
    const fixture = createFixture(nonce, agent);
    const configHome = createAskConfig(headlessBin());
    try {
      const result = await runAsk([
        "--agent",
        agent,
        "--ecosystem",
        "npm",
        "--no-exec",
        "ask-fixture-cli",
        "What is the documented integration nonce? Include the exact nonce.",
      ], integrationEnv(fixture.binDir, configHome));

      assertNonce(result, nonce, `${agent} ask run`);
      assert.match(result.stdout, /Package: ask-fixture-cli 1\.0\.0/);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
      rmSync(configHome, { force: true, recursive: true });
    }
  }
});

test("default agent delegates to Headless auto selection", { timeout: commandTimeoutMs }, async (context) => {
  if (!selectedAgents.includes("codex")) {
    context.skip("default-agent smoke runs with the default Codex hook selection");
    return;
  }

  const nonce = `${suiteNonce}-default`;
  const fixture = createFixture(nonce, "default");
  const configHome = createAskConfig(headlessBin());
  try {
    const result = await runAsk([
      "--ecosystem",
      "npm",
      "--no-exec",
      "ask-fixture-cli",
      "What is the documented integration nonce? Include the exact nonce.",
    ], integrationEnv(fixture.binDir, configHome));

    assertNonce(result, nonce, "default ask run");
    assert.match(result.stdout, /Package: ask-fixture-cli 1\.0\.0/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
    rmSync(configHome, { force: true, recursive: true });
  }
});
