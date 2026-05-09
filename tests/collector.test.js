import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectContext } from "../dist/collectors/context.js";
import { defaultLimits } from "../dist/collectors/limits.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolveNpmPackage } from "../dist/resolvers/npm.js";

const fixtureBin = join(process.cwd(), "tests", "fixtures", "npm", "node_modules", ".bin");

test("collector gathers help output and useful package files", async () => {
  const resolution = await npmFixtureResolution();
  const bundle = await collectContext(resolution, {
    ...defaultLimits,
    helpTimeoutMs: 1_000,
    helpStdoutBytes: 4_096,
  });

  assert.ok(bundle.helpOutputs.some((output) => output.command.includes("--help")));
  assert.ok(bundle.helpOutputs.some((output) => output.command.includes("--version")));
  assertKind(bundle, "readme");
  assertKind(bundle, "changelog");
  assertKind(bundle, "docs");
  assertKind(bundle, "source");
  assertKind(bundle, "config");
  assertKind(bundle, "env");
  assertKind(bundle, "test");
  assertKind(bundle, "example");
});

test("collector honors --no-exec", async () => {
  const resolution = await npmFixtureResolution();
  const bundle = await collectContext(resolution, defaultLimits, { noExec: true });

  assert.equal(bundle.helpOutputs.length, 0);
  assert.ok(bundle.files.length > 0);
});

test("collector only gathers man output for fallback resolutions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-npm-no-man-"));
  const fakeBinDir = join(temp, "fake-bin");
  await mkdir(fakeBinDir);
  const man = join(fakeBinDir, "man");
  await writeFile(man, "#!/bin/sh\necho 'npm fixture manual should not be collected'\n");
  await chmod(man, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

  try {
    const bundle = await collectContext(await npmFixtureResolution(), {
      ...defaultLimits,
      helpTimeoutMs: 1_000,
      helpStdoutBytes: 4_096,
    });

    assert.ok(!bundle.helpOutputs.some((output) => output.command[0] === "man"));
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("collector includes dist entrypoint and local imports", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-collector-dist-"));
  const dist = join(temp, "dist");
  await mkdir(dist);
  const executable = join(temp, "tool");
  const entryFile = join(dist, "main.js");
  const pricingFile = join(dist, "pricing-launch.js");

  await writeFile(join(temp, "package.json"), JSON.stringify({ name: "tool", version: "1.0.0" }));
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  await writeFile(entryFile, "import { fetchPricing } from './pricing-launch.js';\nfetchPricing();\n");
  await writeFile(pricingFile, "export function fetchPricing() { return process.env.AGENTLENS_PRICING; }\n");

  const bundle = await collectContext({
    command: "tool",
    executablePath: executable,
    executableRealPath: executable,
    executableMtimeNs: 1n,
    ecosystem: "npm",
    packageName: "tool",
    version: "1.0.0",
    packageRoot: temp,
    entryFile,
    metadataFiles: [],
    confidence: "high",
    warnings: [],
    shim: null,
  }, defaultLimits, { noExec: true });

  assertCollectedRelPath(bundle, "dist/main.js");
  assertCollectedRelPath(bundle, "dist/pricing-launch.js");
});

test("collector includes package skill markdown as docs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-collector-skills-"));
  const skillsDir = join(temp, "skills", "review");
  await mkdir(skillsDir, { recursive: true });
  const executable = join(temp, "tool");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  await writeFile(join(temp, "package.json"), JSON.stringify({ name: "tool", version: "1.0.0" }));
  await writeFile(join(skillsDir, "SKILL.md"), "Review instructions\n");

  const bundle = await collectContext({
    command: "tool",
    executablePath: executable,
    executableRealPath: executable,
    executableMtimeNs: 1n,
    ecosystem: "npm",
    packageName: "tool",
    version: "1.0.0",
    packageRoot: temp,
    entryFile: executable,
    metadataFiles: [],
    confidence: "high",
    warnings: [],
    shim: null,
  }, defaultLimits, { noExec: true });

  assertCollectedRelPath(bundle, "skills/review/SKILL.md");
});

test("collector skips generated directories and package artifacts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-collector-generated-"));
  const src = join(temp, "src");
  const target = join(temp, "target", "debug", ".fingerprint", "dep");
  await mkdir(src, { recursive: true });
  await mkdir(target, { recursive: true });
  const executable = join(temp, "tool");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  await writeFile(join(temp, "package.json"), JSON.stringify({ name: "tool", version: "1.0.0" }));
  await writeFile(join(temp, "README.md"), "docs");
  await writeFile(join(src, "main.rs"), "fn main() {}\n");
  await writeFile(join(target, "lib-generated.json"), JSON.stringify({ package: "generated" }));
  await writeFile(join(temp, "tool-1.0.0.tgz"), "package/package.json");

  const bundle = await collectContext({
    command: "tool",
    executablePath: executable,
    executableRealPath: executable,
    executableMtimeNs: 1n,
    ecosystem: "npm",
    packageName: "tool",
    version: "1.0.0",
    packageRoot: temp,
    entryFile: join(src, "main.rs"),
    metadataFiles: [],
    confidence: "high",
    warnings: [],
    shim: null,
  }, defaultLimits, { noExec: true });

  assertCollectedRelPath(bundle, "src/main.rs");
  assertNoCollectedRelPath(bundle, "target/debug/.fingerprint/dep/lib-generated.json");
  assertNoCollectedRelPath(bundle, "tool-1.0.0.tgz");
});

test("collector enforces file count and byte truncation limits", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-collector-"));
  await writeFile(join(temp, "README.md"), "x".repeat(100));
  await writeFile(join(temp, "CHANGELOG.md"), "changes");
  const executable = join(temp, "tool");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const resolution = {
    command: "tool",
    executablePath: executable,
    executableRealPath: executable,
    executableMtimeNs: 1n,
    ecosystem: "fallback",
    packageName: "tool",
    version: "0.0.0",
    packageRoot: temp,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings: [],
    shim: null,
  };

  const bundle = await collectContext(resolution, {
    ...defaultLimits,
    maxFiles: 2,
    maxBytesPerFile: 10,
    maxTotalBytes: 10,
  }, { noExec: true });

  assert.equal(bundle.files.length, 2);
  assert.ok(bundle.files.some((file) => file.truncated));
  assert.match(bundle.warnings[0], /limits/);
});

test("fallback collector stages script body, adjacent docs, and man output", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-fallback-context-"));
  const binDir = join(temp, "bin");
  const fakeBinDir = join(temp, "fake-bin");
  const manDir = join(temp, "man", "man1");
  await mkdir(binDir, { recursive: true });
  await mkdir(fakeBinDir);
  await mkdir(manDir, { recursive: true });
  const executable = join(binDir, "loose-tool");
  const man = join(fakeBinDir, "man");
  await writeFile(executable, "#!/bin/sh\ncase \"$1\" in --help) echo usage loose;; esac\n");
  await chmod(executable, 0o755);
  await writeFile(man, "#!/bin/sh\necho 'LOOSE-TOOL(1) fake manual'\n");
  await chmod(man, 0o755);
  await writeFile(join(binDir, "README.md"), "Loose tool docs\n");
  await writeFile(join(binDir, "loose-tool.conf"), "setting = true\n");
  await writeFile(join(manDir, "loose-tool.1"), ".TH loose-tool 1\n.SH NAME\nloose-tool\n");

  const resolution = {
    command: "loose-tool",
    executablePath: executable,
    executableRealPath: executable,
    executableMtimeNs: 1n,
    ecosystem: "fallback",
    packageName: null,
    version: null,
    packageRoot: null,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings: [],
    shim: null,
  };

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;

  const bundle = await collectContext(resolution, {
    ...defaultLimits,
    helpTimeoutMs: 1_000,
    helpStdoutBytes: 4_096,
  });

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  assertCollectedRelPath(bundle, "bin/loose-tool");
  assertCollectedRelPath(bundle, "bin/README.md");
  assertCollectedRelPath(bundle, "bin/loose-tool.conf");
  assert.ok(bundle.helpOutputs.some((output) => output.command[0] === "man"));
});

async function npmFixtureResolution() {
  const located = await locateExecutable("fixture-cli-npm", {
    env: { PATH: fixtureBin, SHELL: "/missing-shell" },
  });
  return resolveNpmPackage(located);
}

function assertKind(bundle, kind) {
  assert.ok(
    bundle.files.some((file) => file.kind === kind),
    `expected collected file kind ${kind}`,
  );
}

function assertCollectedRelPath(bundle, relPath) {
  assert.ok(
    bundle.files.some((file) => file.relPath === relPath),
    `expected collected file ${relPath}`,
  );
}

function assertNoCollectedRelPath(bundle, relPath) {
  assert.ok(
    !bundle.files.some((file) => file.relPath === relPath),
    `expected not to collect file ${relPath}`,
  );
}
