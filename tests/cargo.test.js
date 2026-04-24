import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { collectContext } from "../dist/collectors/context.js";
import { defaultLimits } from "../dist/collectors/limits.js";
import { run } from "../dist/cli/index.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolveCargoPackage } from "../dist/resolvers/cargo.js";

test("cargo resolver matches a local target binary to Cargo.toml", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cargo-target-"));
  await mkdir(join(temp, "src"), { recursive: true });
  await mkdir(join(temp, "target", "release"), { recursive: true });
  const executable = join(temp, "target", "release", "fixture-cargo");
  const entryFile = join(temp, "src", "main.rs");

  await writeFile(join(temp, "Cargo.toml"), [
    "[package]",
    'name = "fixture-cargo"',
    'version = "0.4.0"',
    "",
  ].join("\n"));
  await writeFile(entryFile, "fn main() {}\n");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "fixture-cargo" });

  assert.equal(resolution.ecosystem, "cargo");
  assert.equal(resolution.packageName, "fixture-cargo");
  assert.equal(resolution.version, "0.4.0");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.packageRoot, await realpath(temp));
  assert.equal(resolution.entryFile, await realpath(entryFile));
});

test("cargo resolver uses cargo install metadata and registry source", async () => {
  const cargoHome = await mkdtemp(join(tmpdir(), "ask-cargo-home-"));
  const binDir = join(cargoHome, "bin");
  const sourceRoot = join(cargoHome, "registry", "src", "index.crates.io-abcdef", "ripgrep-14.1.1");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(sourceRoot, "crates", "rg"), { recursive: true });
  const executable = join(binDir, "rg");
  const entryFile = join(sourceRoot, "crates", "rg", "main.rs");

  await writeFile(join(cargoHome, ".crates2.json"), JSON.stringify({
    installs: {
      "ripgrep 14.1.1 (registry+https://github.com/rust-lang/crates.io-index)": {
        bins: ["rg"],
      },
    },
  }));
  await writeFile(join(sourceRoot, "Cargo.toml"), [
    "[package]",
    'name = "ripgrep"',
    'version = "14.1.1"',
    "",
    "[[bin]]",
    'name = "rg"',
    'path = "crates/rg/main.rs"',
    "",
  ].join("\n"));
  await writeFile(entryFile, "fn main() {}\n");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "rg" });
  const bundle = await collectContext(resolution, defaultLimits, { noExec: true });

  assert.equal(resolution.packageName, "ripgrep");
  assert.equal(resolution.version, "14.1.1");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.packageRoot, await realpath(sourceRoot));
  assert.equal(resolution.entryFile, await realpath(entryFile));
  assert.ok(bundle.files.some((file) => file.relPath === "Cargo.toml"));
  assert.ok(bundle.files.some((file) => file.relPath === "crates/rg/main.rs"));
});

test("cargo resolver uses path install metadata when the source root exists", async () => {
  const cargoHome = await mkdtemp(join(tmpdir(), "ask-cargo-home-path-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "ask-cargo-source-"));
  const binDir = join(cargoHome, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  const executable = join(binDir, "todui");
  const entryFile = join(sourceRoot, "src", "main.rs");

  await writeFile(join(cargoHome, ".crates2.json"), JSON.stringify({
    installs: {
      [`todui 0.1.0 (path+${pathToFileURL(sourceRoot).href})`]: {
        bins: ["todui"],
      },
    },
  }));
  await writeFile(join(sourceRoot, "Cargo.toml"), [
    "[package]",
    'name = "todui"',
    'version = "0.1.0"',
    "",
  ].join("\n"));
  await writeFile(entryFile, "fn main() {}\n");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "todui" });

  assert.equal(resolution.packageName, "todui");
  assert.equal(resolution.version, "0.1.0");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.packageRoot, await realpath(sourceRoot));
  assert.equal(resolution.entryFile, await realpath(entryFile));
});

test("cargo resolver returns package metadata without source as medium confidence", async () => {
  const cargoHome = await mkdtemp(join(tmpdir(), "ask-cargo-home-nosource-"));
  const binDir = join(cargoHome, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "tool");

  await writeFile(join(cargoHome, ".crates2.json"), JSON.stringify({
    installs: {
      "tool 1.2.3 (registry+https://github.com/rust-lang/crates.io-index)": {
        bins: ["tool"],
      },
    },
  }));
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "tool" });

  assert.equal(resolution.packageName, "tool");
  assert.equal(resolution.version, "1.2.3");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.packageRoot, null);
  assert.match(resolution.warnings[0], /source root was not found/);
});

test("cargo resolver ignores malformed install metadata", async () => {
  const cargoHome = await mkdtemp(join(tmpdir(), "ask-cargo-home-bad-"));
  const binDir = join(cargoHome, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "tool");
  await writeFile(join(cargoHome, ".crates2.json"), await readFile(new URL("./fixtures/pollution/node_modules/polluted-tool/package.json", import.meta.url), "utf8"));
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "tool" });

  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.packageRoot, null);
});

test("cargo resolver rejects traversal-like crate names in install metadata", async () => {
  const cargoHome = await mkdtemp(join(tmpdir(), "ask-cargo-home-traversal-"));
  const binDir = join(cargoHome, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "tool");

  await writeFile(join(cargoHome, ".crates2.json"), JSON.stringify({
    installs: {
      "../outside 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)": {
        bins: ["tool"],
      },
    },
  }));
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "tool" });

  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.packageRoot, null);
});

test("cargo resolver does not treat arbitrary project executables as target builds", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cargo-arbitrary-"));
  await mkdir(join(temp, "scripts"), { recursive: true });
  await mkdir(join(temp, "src"), { recursive: true });
  const executable = join(temp, "scripts", "fixture-cargo");

  await writeFile(join(temp, "Cargo.toml"), [
    "[package]",
    'name = "fixture-cargo"',
    'version = "0.4.0"',
    "",
  ].join("\n"));
  await writeFile(join(temp, "src", "main.rs"), "fn main() {}\n");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "fixture-cargo" });

  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.packageRoot, null);
});

test("cargo resolver rejects manifest bin paths outside the package root", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cargo-bin-escape-"));
  const outside = join(temp, "outside.rs");
  const packageRoot = join(temp, "pkg");
  await mkdir(join(packageRoot, "target", "release"), { recursive: true });
  const executable = join(packageRoot, "target", "release", "fixture-cargo");

  await writeFile(join(packageRoot, "Cargo.toml"), [
    "[package]",
    'name = "fixture-cargo"',
    'version = "0.4.0"',
    "",
    "[[bin]]",
    'name = "fixture-cargo"',
    'path = "../outside.rs"',
    "",
  ].join("\n"));
  await writeFile(outside, "fn main() {}\n");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  const located = await locateExecutable(executable, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolveCargoPackage({ ...located, command: "fixture-cargo" });

  assert.equal(resolution.entryFile, null);
  assert.equal(resolution.confidence, "medium");
});

test("CLI auto-detects local Cargo target binaries", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cargo-cli-"));
  await mkdir(join(temp, "src"), { recursive: true });
  await mkdir(join(temp, "target", "release"), { recursive: true });
  const executable = join(temp, "target", "release", "fixture-cargo");

  await writeFile(join(temp, "Cargo.toml"), [
    "[package]",
    'name = "fixture-cargo"',
    'version = "0.5.0"',
    "",
  ].join("\n"));
  await writeFile(join(temp, "src", "main.rs"), "fn main() {}\n");
  await writeFile(executable, "#!/bin/sh\necho fixture\n");
  await chmod(executable, 0o755);

  const result = await run([
    "--agent",
    "none",
    "--no-exec",
    executable,
    "How do I use it?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Ecosystem: cargo/);
  assert.match(result.stdout, /Package: fixture-cargo 0\.5\.0/);
  assert.match(result.stdout, /Confidence: high/);
});
