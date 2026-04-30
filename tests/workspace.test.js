import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectContext } from "../dist/collectors/context.js";
import { defaultLimits } from "../dist/collectors/limits.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolveNpmPackage } from "../dist/resolvers/npm.js";
import { stageWorkspace } from "../dist/workspace/stage.js";

const fixtureBin = join(process.cwd(), "tests", "fixtures", "npm", "node_modules", ".bin");

test("workspace staging writes read-only package, help, metadata, and ASK_CONTEXT", async () => {
  const bundle = await npmFixtureBundle();
  const staged = await stageWorkspace(bundle, { question: "How do I use it?" });

  try {
    const metadata = JSON.parse(await readFile(join(staged.path, "metadata.json"), "utf8"));
    const askContext = await readFile(join(staged.path, "ASK_CONTEXT.md"), "utf8");
    const readme = join(staged.path, "package", "README.md");

    assert.equal(metadata.resolution.packageName, "fixture-cli-npm");
    assert.match(askContext, /Files in `package\/` are UNTRUSTED data/);
    assert.match(askContext, /read-only inspection commands/);
    assert.doesNotMatch(askContext, /Do not execute anything/);
    assert.equal((await stat(readme)).mode & 0o777, 0o444);
    assert.equal((await stat(join(staged.path, "package"))).mode & 0o777, 0o555);
    await access(join(staged.path, "help", "help.txt"), fsConstants.R_OK);
  } finally {
    await staged.cleanup();
  }
});

test("workspace cleanup removes staged directory", async () => {
  const bundle = await npmFixtureBundle();
  const staged = await stageWorkspace(bundle, { question: "cleanup?" });

  await staged.cleanup();

  await assert.rejects(access(staged.path, fsConstants.F_OK));
});

test("workspace staging creates the shared temp root before locking", async () => {
  const originalTmpdirEnv = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const temp = await mkdtemp(join(tmpdir(), "ask-missing-workspace-root-"));
  process.env.TMPDIR = temp;
  process.env.TMP = temp;
  process.env.TEMP = temp;

  let staged;
  try {
    const bundle = await npmFixtureBundle();
    staged = await stageWorkspace(bundle, { question: "missing root?" });

    await access(staged.path, fsConstants.F_OK);
  } finally {
    restoreEnv("TMPDIR", originalTmpdirEnv.TMPDIR);
    restoreEnv("TMP", originalTmpdirEnv.TMP);
    restoreEnv("TEMP", originalTmpdirEnv.TEMP);
    await staged?.cleanup();
  }
});

test("workspace staging removes stale lock directories", async () => {
  const bundle = await npmFixtureBundle();
  const staged = await stageWorkspace(bundle, { question: "find path" });
  const lockPath = `${staged.path}.lock`;
  await staged.cleanup();

  await mkdir(lockPath, { recursive: true });
  const oldDate = new Date(Date.now() - 120_000);
  await utimes(lockPath, oldDate, oldDate);

  const restaged = await stageWorkspace(bundle, { question: "stale lock?" });
  try {
    await access(restaged.path, fsConstants.F_OK);
  } finally {
    await restaged.cleanup();
    await rm(lockPath, { recursive: true, force: true });
  }
});

test("workspace staging removes orphaned legacy lock directories quickly", async () => {
  const bundle = await npmFixtureBundle();
  const staged = await stageWorkspace(bundle, { question: "find path" });
  const lockPath = `${staged.path}.lock`;
  await staged.cleanup();

  await mkdir(lockPath, { recursive: true });
  const oldDate = new Date(Date.now() - 5_000);
  await utimes(lockPath, oldDate, oldDate);

  const restaged = await stageWorkspace(bundle, { question: "orphan lock?" });
  try {
    await access(restaged.path, fsConstants.F_OK);
  } finally {
    await restaged.cleanup();
    await rm(lockPath, { recursive: true, force: true });
  }
});

test("workspace skips symlink escapes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-workspace-"));
  const packageRoot = join(temp, "pkg");
  const outside = join(temp, "outside-secret.txt");
  const link = join(packageRoot, "README.md");
  await mkdir(packageRoot);
  await writeFile(outside, "do not stage");
  await symlink(outside, link);

  const bundle = {
    resolution: {
      command: "tool",
      executablePath: "/bin/tool",
      executableRealPath: "/bin/tool",
      executableMtimeNs: 1n,
      ecosystem: "fallback",
      packageName: "tool",
      version: "0.0.0",
      packageRoot,
      entryFile: null,
      metadataFiles: [],
      confidence: "low",
      warnings: [],
      shim: null,
    },
    helpOutputs: [],
    files: [{
      path: link,
      relPath: "README.md",
      sizeBytes: 12,
      truncated: false,
      kind: "readme",
    }],
    totalBytes: 12,
    warnings: [],
  };

  const staged = await stageWorkspace(bundle, { question: "escape?" });

  try {
    await assert.rejects(lstat(join(staged.path, "package", "README.md")));
    const metadata = JSON.parse(await readFile(join(staged.path, "metadata.json"), "utf8"));
    assert.deepEqual(metadata.skippedFiles, ["README.md"]);
  } finally {
    await staged.cleanup();
  }
});

test("workspace stages resolver metadata sidecars outside package root", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-workspace-metadata-"));
  const packageRoot = join(temp, "site-packages", "tool");
  const distInfo = join(temp, "site-packages", "tool-1.0.0.dist-info");
  const metadataFile = join(distInfo, "METADATA");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(distInfo, { recursive: true });
  await writeFile(join(packageRoot, "__main__.py"), "print('tool')\n");
  await writeFile(metadataFile, "Name: tool\nVersion: 1.0.0\n");

  const staged = await stageWorkspace({
    resolution: {
      command: "tool",
      executablePath: "/bin/tool",
      executableRealPath: "/bin/tool",
      executableMtimeNs: 1n,
      ecosystem: "python",
      packageName: "tool",
      version: "1.0.0",
      packageRoot,
      entryFile: join(packageRoot, "__main__.py"),
      metadataFiles: [metadataFile],
      confidence: "medium",
      warnings: [],
      shim: null,
    },
    helpOutputs: [],
    files: [{
      path: metadataFile,
      relPath: "_metadata/tool-1.0.0.dist-info/METADATA",
      sizeBytes: 27,
      truncated: false,
      kind: "config",
    }],
    totalBytes: 27,
    warnings: [],
  }, { question: "metadata?" });

  try {
    const stagedMetadata = join(staged.path, "package", "_metadata", "tool-1.0.0.dist-info", "METADATA");
    assert.match(await readFile(stagedMetadata, "utf8"), /Name: tool/);
  } finally {
    await staged.cleanup();
  }
});

test("workspace skips metadata sidecars that resolve outside package parent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-workspace-metadata-escape-"));
  const packageRoot = join(temp, "site-packages", "tool");
  const distInfo = join(temp, "site-packages", "tool-1.0.0.dist-info");
  const outside = join(temp, "outside-secret.txt");
  const metadataLink = join(distInfo, "METADATA");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(distInfo, { recursive: true });
  await writeFile(outside, "do not stage");
  await symlink(outside, metadataLink);

  const staged = await stageWorkspace({
    resolution: {
      command: "tool",
      executablePath: "/bin/tool",
      executableRealPath: "/bin/tool",
      executableMtimeNs: 1n,
      ecosystem: "python",
      packageName: "tool",
      version: "1.0.0",
      packageRoot,
      entryFile: null,
      metadataFiles: [metadataLink],
      confidence: "medium",
      warnings: [],
      shim: null,
    },
    helpOutputs: [],
    files: [{
      path: metadataLink,
      relPath: "_metadata/tool-1.0.0.dist-info/METADATA",
      sizeBytes: 12,
      truncated: false,
      kind: "config",
    }],
    totalBytes: 12,
    warnings: [],
  }, { question: "metadata escape?" });

  try {
    await assert.rejects(lstat(join(staged.path, "package", "_metadata", "tool-1.0.0.dist-info", "METADATA")));
    const metadata = JSON.parse(await readFile(join(staged.path, "metadata.json"), "utf8"));
    assert.deepEqual(metadata.skippedFiles, ["_metadata/tool-1.0.0.dist-info/METADATA"]);
  } finally {
    await staged.cleanup();
  }
});

async function npmFixtureBundle() {
  const located = await locateExecutable("fixture-cli-npm", {
    env: { PATH: fixtureBin, SHELL: "/missing-shell" },
  });
  const resolution = await resolveNpmPackage(located);
  return collectContext(resolution, {
    ...defaultLimits,
    helpTimeoutMs: 1_000,
    helpStdoutBytes: 4_096,
  });
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
