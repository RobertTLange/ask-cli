#!/usr/bin/env node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const filters = process.argv.slice(2);
const testDir = new URL("../tests/", import.meta.url);
const entries = await readdir(testDir);
const testFiles = entries
  .filter((entry) => entry.endsWith(".test.js"))
  .filter((entry) => entry !== "integration-local.test.js")
  .map((entry) => join(testDir.pathname, entry));

const args = ["--test"];
if (filters.length > 0) {
  args.push("--test-name-pattern", filters.join("|"));
}
args.push(...testFiles);

const testHome = await mkdtemp(join(tmpdir(), "ask-test-home-"));
const child = spawn(process.execPath, args, {
  env: {
    ...process.env,
    HOME: testHome,
    XDG_CACHE_HOME: join(testHome, ".cache"),
  },
  stdio: "inherit",
  shell: false,
});

child.on("exit", async (code, signal) => {
  await rm(testHome, { force: true, recursive: true }).catch(() => {});
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
