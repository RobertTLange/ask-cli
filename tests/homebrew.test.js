import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectContext } from "../dist/collectors/context.js";
import { defaultLimits } from "../dist/collectors/limits.js";
import { run } from "../dist/cli/index.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolveHomebrewPackage } from "../dist/resolvers/homebrew.js";

test("homebrew resolver derives formula metadata from Cellar realpath", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "ask-homebrew-"));
  const packageRoot = join(prefix, "Cellar", "wget", "1.21.4");
  const binDir = join(packageRoot, "bin");
  const docDir = join(packageRoot, "share", "doc", "wget");
  const manDir = join(packageRoot, "share", "man", "man1");
  await mkdir(binDir, { recursive: true });
  await mkdir(docDir, { recursive: true });
  await mkdir(manDir, { recursive: true });
  const executable = join(binDir, "wget");
  const receipt = join(packageRoot, "INSTALL_RECEIPT.json");
  const docs = join(docDir, "README.md");
  const manpage = join(manDir, "wget.1");

  await writeFile(receipt, JSON.stringify({ source: { tap: "homebrew/core" } }));
  await writeFile(docs, "Wget docs\n");
  await writeFile(manpage, ".TH wget 1\n");
  await writeFile(executable, "binary-ish");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveHomebrewPackage({ ...located, command: "wget" });
  const bundle = await collectContext(resolution, defaultLimits, { noExec: true });

  assert.equal(resolution.ecosystem, "homebrew");
  assert.equal(resolution.packageName, "wget");
  assert.equal(resolution.version, "1.21.4");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.packageRoot, null);
  assert.equal(resolution.entryFile, null);
  const realReceipt = await realpath(receipt);
  assert.ok(bundle.files.some((file) => file.path === realReceipt));
  assert.ok(resolution.metadataFiles.includes(await realpath(docs)));
  assert.ok(resolution.metadataFiles.includes(await realpath(manpage)));
});

test("homebrew resolver keeps script entry files for wrapper CLIs", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "ask-homebrew-script-"));
  const packageRoot = join(prefix, "Cellar", "wrapped", "2.0.0");
  const binDir = join(packageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "wrapped");

  await writeFile(executable, "#!/bin/sh\necho wrapped\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveHomebrewPackage({ ...located, command: "wrapped" });

  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.entryFile, await realpath(executable));
  assert.match(resolution.warnings[0], /metadata files were not found/);
});

test("homebrew resolver follows bin symlinks into Cellar", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "ask-homebrew-link-"));
  const packageRoot = join(prefix, "Cellar", "jq", "1.7.1");
  const binDir = join(packageRoot, "bin");
  const prefixBin = join(prefix, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(prefixBin, { recursive: true });
  const executable = join(binDir, "jq");
  const link = join(prefixBin, "jq");

  await writeFile(executable, "#!/bin/sh\necho jq\n");
  await chmod(executable, 0o755);
  await symlink(executable, link);

  const located = await locateExecutable(link, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveHomebrewPackage({ ...located, command: "jq" });

  assert.equal(resolution.packageName, "jq");
  assert.equal(resolution.version, "1.7.1");
  assert.equal(resolution.packageRoot, null);
});

test("CLI auto-detects Homebrew symlinked commands", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "ask-homebrew-cli-"));
  const packageRoot = join(prefix, "Cellar", "jq", "1.7.1");
  const binDir = join(packageRoot, "bin");
  const prefixBin = join(prefix, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(prefixBin, { recursive: true });
  const executable = join(binDir, "jq");
  const link = join(prefixBin, "jq");

  await writeFile(join(packageRoot, "INSTALL_RECEIPT.json"), "{}\n");
  await writeFile(executable, "#!/bin/sh\necho jq\n");
  await chmod(executable, 0o755);
  await symlink(executable, link);

  const result = await run([
    "--agent",
    "none",
    "--no-exec",
    link,
    "How do I use it?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Ecosystem: homebrew/);
  assert.match(result.stdout, /Package: jq 1\.7\.1/);
});

test("homebrew resolver falls back when realpath is not under Cellar", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-homebrew-none-"));
  const executable = join(temp, "tool");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveHomebrewPackage({ ...located, command: "tool" });

  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.packageRoot, null);
  assert.match(resolution.warnings[0], /Homebrew Cellar path was not found/);
});

test("homebrew resolver ignores formula symlink escapes", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "ask-homebrew-escape-"));
  const packageRoot = join(prefix, "Cellar", "escaped", "1.0.0");
  const binDir = join(packageRoot, "bin");
  const formulaDir = join(packageRoot, ".brew");
  const outside = join(prefix, "outside.rb");
  await mkdir(binDir, { recursive: true });
  await mkdir(formulaDir, { recursive: true });
  const executable = join(binDir, "escaped");
  const formulaLink = join(formulaDir, "escaped.rb");

  await writeFile(outside, "class Escaped < Formula; end\n");
  await writeFile(executable, "#!/bin/sh\necho escaped\n");
  await chmod(executable, 0o755);
  await symlink(outside, formulaLink);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveHomebrewPackage({ ...located, command: "escaped" });

  assert.deepEqual(resolution.metadataFiles, []);
});
