import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../dist/cli/index.js";
import { locateExecutable } from "../dist/resolvers/locate.js";
import { resolvePythonPackage } from "../dist/resolvers/python.js";

const fixtureBin = join(process.cwd(), "tests", "fixtures", "python", "bin");
const fixtureExecutable = join(fixtureBin, "fixture-cli-py");

test("python resolver parses dist-info metadata for fixture CLI", async () => {
  const located = await locateExecutable("fixture-cli-py", {
    env: { PATH: fixtureBin, SHELL: "/missing-shell" },
  });

  const resolution = await resolvePythonPackage(located);

  assert.equal(resolution.ecosystem, "python");
  assert.equal(resolution.packageName, "fixture-cli-py");
  assert.equal(resolution.version, "0.1.0");
  assert.equal(resolution.confidence, "medium");
  assert.match(resolution.packageRoot, /fixture_cli_py$/);
  assert.match(resolution.entryFile, /fixture_cli_py\/cli\.py$/);
  assert.equal(resolution.executableRealPath, await realpath(fixtureExecutable));
});

test("python resolver roots native wheel binaries from RECORD", async () => {
  const fixture = await createNativeWheelFixture();

  const located = {
    command: "native-py-cli",
    path: fixture.executable,
    realPath: await realpath(fixture.executable),
    symlinkChain: [],
    shebang: null,
    executableKind: "unknown",
    mtimeNs: 1n,
    shim: null,
  };

  const resolution = await resolvePythonPackage(located);

  assert.equal(resolution.ecosystem, "python");
  assert.equal(resolution.packageName, "native-py-cli");
  assert.equal(resolution.version, "1.2.3");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.packageRoot, fixture.packageRoot);
  assert.equal(resolution.entryFile, join(fixture.packageRoot, "__main__.py"));
  assert.deepEqual(resolution.metadataFiles.sort(), [
    join(fixture.distInfo, "METADATA"),
    join(fixture.distInfo, "RECORD"),
  ].sort());
});

test("python resolver scans pipx uv rye style venv layouts", async () => {
  for (const layout of [
    ["pipx", "venvs", "venv-tool"],
    ["uv", "tools", "venv-tool"],
    [".rye", "tools", "venv-tool"],
  ]) {
    const fixture = await createVenvFixture(layout);
    const located = await locateExecutable(fixture.executable, { env: { PATH: "", SHELL: "/missing-shell" } });
    const resolution = await resolvePythonPackage({ ...located, command: "venv-tool" });

    assert.equal(resolution.packageName, "venv-tool");
    assert.equal(resolution.version, "0.2.0");
    assert.match(resolution.packageRoot, /venv_tool$/);
    assert.match(resolution.entryFile, /venv_tool\/cli\.py$/);
  }
});

test("python resolver follows local python wrapper scripts to dist metadata", async () => {
  const fixture = await createVenvFixture(["wrapped"]);
  const wrapper = join(fixture.temp, "bin", "wrapped-tool");
  await mkdir(join(fixture.temp, "bin"), { recursive: true });
  await writeFile(wrapper, [
    "#!/usr/bin/env python3",
    "import os, sys",
    `os.execv(${JSON.stringify(fixture.executable)}, [${JSON.stringify(fixture.executable)}] + sys.argv[1:])`,
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);

  const located = await locateExecutable(wrapper, { env: { PATH: "", SHELL: "/missing-shell" } });
  const resolution = await resolvePythonPackage({ ...located, command: "venv-tool" });

  assert.equal(resolution.packageName, "venv-tool");
  assert.match(resolution.warnings.join("; "), /wrapper script/);
});

test("CLI auto fallback upgrades native Python wheel binaries", async () => {
  const fixture = await createNativeWheelFixture();
  const originalPath = process.env.PATH;
  process.env.PATH = join(fixture.temp, "bin");

  try {
    const result = await run([
      "--agent",
      "none",
      "--no-exec",
      "--refresh",
      "native-py-cli",
      "Where is it configured?",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Ecosystem: python/);
    assert.match(result.stdout, /Package: native-py-cli 1\.2\.3/);
    assert.match(result.stdout, /Package root: .*native_py_cli/);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("python resolver returns low confidence when metadata is unavailable", async () => {
  const located = {
    command: "missing-python-cli",
    path: "/tmp/missing-python-cli",
    realPath: "/tmp/missing-python-cli",
    symlinkChain: [],
    shebang: "/usr/bin/env python3",
    executableKind: "script",
    mtimeNs: 1n,
    shim: null,
  };

  const resolution = await resolvePythonPackage(located);

  assert.equal(resolution.packageName, null);
  assert.equal(resolution.confidence, "low");
  assert.match(resolution.warnings[0], /metadata was not found/);
});

test("CLI --agent none reports Python fixture resolution", async () => {
  const result = await run([
    "--agent",
    "none",
    "--ecosystem",
    "python",
    "fixture-cli-py",
    "How do I use the sample option?",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Package: fixture-cli-py 0\.1\.0/);
  assert.match(result.stdout, /Confidence: medium/);
});

async function createNativeWheelFixture() {
  const temp = await mkdtemp(join(tmpdir(), "ask-python-native-"));
  const executable = join(temp, "bin", "native-py-cli");
  const sitePackages = join(temp, "lib", "python3.12", "site-packages");
  const packageRoot = join(sitePackages, "native_py_cli");
  const distInfo = join(sitePackages, "native_py_cli-1.2.3.dist-info");

  await mkdir(join(temp, "bin"), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await mkdir(distInfo, { recursive: true });
  await writeFile(executable, "binary-ish");
  await chmod(executable, 0o755);
  await writeFile(join(packageRoot, "__init__.py"), "");
  await writeFile(join(packageRoot, "__main__.py"), "def main(): pass\n");
  await writeFile(join(distInfo, "METADATA"), "Name: native-py-cli\nVersion: 1.2.3\n");
  await writeFile(join(distInfo, "RECORD"), [
    "../../../bin/native-py-cli,sha256=fake,10",
    "native_py_cli/__init__.py,sha256=fake,0",
    "native_py_cli/__main__.py,sha256=fake,16",
    "native_py_cli-1.2.3.dist-info/METADATA,sha256=fake,42",
    "native_py_cli-1.2.3.dist-info/RECORD,,",
    "",
  ].join("\n"));

  return { temp, executable, packageRoot, distInfo };
}

async function createVenvFixture(layout) {
  const temp = await mkdtemp(join(tmpdir(), "ask-python-venv-"));
  const venvRoot = join(temp, ...layout);
  const executable = join(venvRoot, "bin", "venv-tool");
  const sitePackages = join(venvRoot, "lib", "python3.12", "site-packages");
  const packageRoot = join(sitePackages, "venv_tool");
  const distInfo = join(sitePackages, "venv_tool-0.2.0.dist-info");

  await mkdir(join(venvRoot, "bin"), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await mkdir(distInfo, { recursive: true });
  await writeFile(executable, "#!/usr/bin/env python3\n");
  await chmod(executable, 0o755);
  await writeFile(join(packageRoot, "__init__.py"), "");
  await writeFile(join(packageRoot, "cli.py"), "def main(): pass\n");
  await writeFile(join(distInfo, "METADATA"), "Name: venv-tool\nVersion: 0.2.0\n");
  await writeFile(join(distInfo, "entry_points.txt"), "[console_scripts]\nvenv-tool = venv_tool.cli:main\n");
  await writeFile(join(distInfo, "RECORD"), [
    "../../../bin/venv-tool,sha256=fake,10",
    "venv_tool/__init__.py,sha256=fake,0",
    "venv_tool/cli.py,sha256=fake,16",
    "venv_tool-0.2.0.dist-info/METADATA,sha256=fake,42",
    "venv_tool-0.2.0.dist-info/entry_points.txt,sha256=fake,42",
    "venv_tool-0.2.0.dist-info/RECORD,,",
    "",
  ].join("\n"));

  return { temp, executable, packageRoot, distInfo };
}
