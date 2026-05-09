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

test("npm resolver prefers parent package for platform optional binaries", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-npm-platform-"));
  const modulesRoot = join(temp, "node_modules");
  const packageRoot = join(modulesRoot, "host-tool");
  const packageBin = join(packageRoot, "bin");
  const platformRoot = join(modulesRoot, "host-tool-darwin-arm64");
  const platformBin = join(platformRoot, "bin");
  await mkdir(packageBin, { recursive: true });
  await mkdir(platformBin, { recursive: true });
  const wrapper = join(packageBin, "host.cjs");
  const nativeBinary = join(platformBin, "host");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "host-tool",
    version: "3.2.1",
    bin: { host: "bin/host.cjs" },
    optionalDependencies: {
      "host-tool-darwin-arm64": "3.2.1",
    },
  }));
  await writeFile(join(platformRoot, "package.json"), JSON.stringify({
    name: "host-tool-darwin-arm64",
    version: "3.2.1",
    bin: { host: "bin/host" },
  }));
  await writeFile(wrapper, "#!/usr/bin/env node\nconsole.log('wrapper')\n");
  await chmod(wrapper, 0o755);
  await writeFile(nativeBinary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  await chmod(nativeBinary, 0o755);

  const located = await locateExecutable(nativeBinary, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveNpmPackage({ ...located, command: "host" });

  assert.equal(resolution.packageName, "host-tool");
  assert.equal(resolution.version, "3.2.1");
  assert.equal(resolution.packageRoot, await realpath(packageRoot));
  assert.equal(resolution.entryFile, await realpath(wrapper));
  assert.deepEqual(resolution.warnings, []);
});

test("npm resolver follows local shell wrapper shims to package metadata", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-npm-wrapper-"));
  const binDir = join(temp, "node_modules", ".bin");
  const packageRoot = join(temp, "node_modules", "wrapped-tool");
  const packageBin = join(packageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(packageBin, { recursive: true });
  const wrapper = join(binDir, "wrapped-tool");
  const target = join(packageBin, "cli.js");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "wrapped-tool",
    version: "9.8.7",
    bin: { "wrapped-tool": "bin/cli.js" },
  }));
  await writeFile(wrapper, "#!/bin/sh\nbasedir=$(dirname \"$0\")\nexec node \"$basedir/../wrapped-tool/bin/cli.js\" \"$@\"\n");
  await chmod(wrapper, 0o755);
  await writeFile(target, "#!/usr/bin/env node\nconsole.log('wrapped')\n");
  await chmod(target, 0o755);

  const located = await locateExecutable(wrapper, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveNpmPackage({ ...located, command: "wrapped-tool" });

  assert.equal(resolution.packageName, "wrapped-tool");
  assert.equal(resolution.version, "9.8.7");
  assert.equal(resolution.entryFile, await realpath(target));
  assert.match(resolution.warnings.join("; "), /wrapper script/);
});

test("npm resolver follows local node wrapper shims to package metadata", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-npm-node-wrapper-"));
  const binDir = join(temp, "node_modules", ".bin");
  const packageRoot = join(temp, "node_modules", "node-wrapped-tool");
  const packageBin = join(packageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(packageBin, { recursive: true });
  const wrapper = join(binDir, "node-wrapped-tool");
  const target = join(packageBin, "cli.js");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "node-wrapped-tool",
    version: "1.0.1",
    bin: { "node-wrapped-tool": "bin/cli.js" },
  }));
  await writeFile(wrapper, "#!/usr/bin/env node\nrequire('../node-wrapped-tool/bin/cli.js');\n");
  await chmod(wrapper, 0o755);
  await writeFile(target, "#!/usr/bin/env node\nconsole.log('node wrapped')\n");
  await chmod(target, 0o755);

  const located = await locateExecutable(wrapper, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveNpmPackage({ ...located, command: "node-wrapped-tool" });

  assert.equal(resolution.packageName, "node-wrapped-tool");
  assert.equal(resolution.entryFile, await realpath(target));
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
