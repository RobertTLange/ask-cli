import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolveNpmPackage } from "../dist/resolvers/npm.js";

const fixtureBin = join(process.cwd(), "tests", "fixtures", "npm", "node_modules", ".bin");
const fixtureEntry = join(
  process.cwd(),
  "tests",
  "fixtures",
  "npm",
  "node_modules",
  "fixture-cli-npm",
  "bin",
  "fixture.js",
);

test("npm resolver matches package.json bin target", async () => {
  const located = await locateExecutable("fixture-cli-npm", {
    env: { PATH: fixtureBin, SHELL: "/missing-shell" },
  });

  const resolution = await resolveNpmPackage(located);

  assert.equal(resolution.ecosystem, "npm");
  assert.equal(resolution.packageName, "fixture-cli-npm");
  assert.equal(resolution.version, "0.1.0");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.entryFile, await realpath(fixtureEntry));
});

test("npm resolver falls back to package root inside node_modules", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-npm-"));
  const packageRoot = join(temp, "node_modules", "fallback-tool");
  const binDir = join(packageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const entry = join(binDir, "tool.js");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fallback-tool",
    version: "2.0.0",
  }));
  await writeFile(entry, "#!/usr/bin/env node\n");
  await chmod(entry, 0o755);

  const located = await locateExecutable(entry, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveNpmPackage({ ...located, command: "fallback-tool" });

  assert.equal(resolution.packageName, "fallback-tool");
  assert.equal(resolution.confidence, "medium");
  assert.match(resolution.warnings[0], /No exact package\.json bin match/);
});

test("CLI --agent none reports npm fixture resolution", async () => {
  const result = await run([
    "--agent",
    "none",
    "--ecosystem",
    "npm",
    "fixture-cli-npm",
    "How do I enable json output?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Package: fixture-cli-npm 0\.1\.0/);
  assert.match(result.stdout, /Confidence: high/);
});
