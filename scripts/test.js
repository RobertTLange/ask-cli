#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const filters = process.argv.slice(2);
const testDir = new URL("../tests/", import.meta.url);
const entries = await readdir(testDir);
const testFiles = entries
  .filter((entry) => entry.endsWith(".test.js"))
  .map((entry) => join(testDir.pathname, entry));

const args = ["--test"];
if (filters.length > 0) {
  args.push("--test-name-pattern", filters.join("|"));
}
args.push(...testFiles);

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
