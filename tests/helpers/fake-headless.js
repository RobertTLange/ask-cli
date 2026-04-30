import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export async function withFakeNpx(callback, options = {}) {
  return withFakeHeadless("npx", callback, options);
}

export async function withFakeHeadless(command, callback, options = {}) {
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
const stdoutChunks = process.env.ASK_NPX_STDOUT_CHUNKS ? JSON.parse(process.env.ASK_NPX_STDOUT_CHUNKS) : null;
const stdoutText = process.env.ASK_NPX_STDOUT || "{\\"type\\":\\"agent_message\\",\\"text\\":\\"headless answer\\"}\\n";
const exitCode = Number(process.env.ASK_NPX_EXIT || "0");
const sleepMs = Number(process.env.ASK_NPX_SLEEP_MS || "0");
if (argv.includes("--print-command")) {
  process.stdout.write(process.env.ASK_NPX_PRINT_COMMAND || "");
  process.exit(exitCode);
}
if (stdoutChunks) {
  let index = 0;
  const writeNext = () => {
    if (index >= stdoutChunks.length) {
      if (sleepMs > 0) {
        setTimeout(() => process.exit(exitCode), sleepMs);
      } else {
        process.exit(exitCode);
      }
      return;
    }
    process.stdout.write(stdoutChunks[index]);
    index += 1;
    setTimeout(writeNext, 20);
  };
  writeNext();
} else {
  process.stdout.write(stdoutText);
  if (sleepMs > 0) {
    setTimeout(() => process.exit(exitCode), sleepMs);
  } else {
    process.exit(exitCode);
  }
}
`);
  await chmod(commandPath, 0o755);

  const previous = {
    PATH: process.env.PATH,
    ASK_NPX_CAPTURE: process.env.ASK_NPX_CAPTURE,
    ASK_NPX_EXIT: process.env.ASK_NPX_EXIT,
    ASK_NPX_STDERR: process.env.ASK_NPX_STDERR,
    ASK_NPX_STDOUT: process.env.ASK_NPX_STDOUT,
    ASK_NPX_STDOUT_CHUNKS: process.env.ASK_NPX_STDOUT_CHUNKS,
    ASK_NPX_PRINT_COMMAND: process.env.ASK_NPX_PRINT_COMMAND,
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
      ASK_NPX_STDOUT_CHUNKS: options.stdoutChunks === undefined ? undefined : JSON.stringify(options.stdoutChunks),
      ASK_NPX_PRINT_COMMAND: options.printCommand,
      ASK_NPX_SLEEP_MS: options.sleepMs === undefined ? undefined : String(options.sleepMs),
      ASK_NPX_GRANDCHILD_MARKER: options.grandchildMarker,
      ASK_NPX_GRANDCHILD_DELAY_MS: options.grandchildDelayMs === undefined ? undefined : String(options.grandchildDelayMs),
    }, async () => ({ capturePath, result: await callback() }));
  } finally {
    restoreEnv(previous);
  }
}

export async function withEnv(values, callback) {
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

export function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export async function eventually(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail("condition was not met before timeout");
}

export async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
