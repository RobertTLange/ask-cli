import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exitCodes } from "../dist/cli/constants.js";
import { run } from "../dist/cli/index.js";
import { findOnPath, locateExecutable } from "../dist/resolvers/locate.js";

test("locate finds executable on PATH without external which", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-locate-"));
  const bin = join(temp, "bin");
  await mkdir(bin);
  const tool = join(bin, "fixture-tool");
  await writeFile(tool, "#!/usr/bin/env node\nconsole.log('ok')\n");
  await chmod(tool, 0o755);

  const found = await findOnPath("fixture-tool", bin);

  assert.equal(found, tool);
});

test("locate records realpath, symlink chain, shebang, and mtime", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-locate-"));
  const bin = join(temp, "bin");
  await mkdir(bin);
  const target = join(bin, "target-tool");
  const link = join(bin, "linked-tool");
  await writeFile(target, "#!/usr/bin/env python3\nprint('ok')\n");
  await chmod(target, 0o755);
  await symlink(target, link);
  const realTarget = await realpath(target);

  const located = await locateExecutable("linked-tool", {
    env: { PATH: bin, SHELL: "/missing-shell" },
  });

  assert.equal(located.path, link);
  assert.equal(located.realPath, realTarget);
  assert.deepEqual(located.symlinkChain, [`${link} -> ${target}`]);
  assert.equal(located.shebang, "/usr/bin/env python3");
  assert.equal(located.executableKind, "script");
  assert.equal(typeof located.mtimeNs, "bigint");
});

test("locate rejects missing commands with resolution details", async () => {
  await assert.rejects(
    locateExecutable("definitely-missing", { env: { PATH: "", SHELL: "/missing-shell" } }),
    (error) => {
      assert.equal(error.exitCode, exitCodes.resolution);
      assert.match(error.message, /not found/);
      assert.match(error.attempted, /locate executable/);
      assert.match(error.nextStep, /--executable/);
      return true;
    },
  );
});

test("locate rejects files without user execute bit", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-locate-"));
  const tool = join(temp, "not-executable");
  await writeFile(tool, "#!/bin/sh\n");
  await chmod(tool, 0o644);

  await assert.rejects(
    locateExecutable(tool, { env: { PATH: "", SHELL: "/missing-shell" } }),
    (error) => {
      assert.equal(error.exitCode, exitCodes.resolution);
      assert.match(error.message, /not user-executable/);
      return true;
    },
  );
});

test("locate rejects shell builtins even when a PATH file exists", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-locate-"));
  const cd = join(temp, "cd");
  await writeFile(cd, "#!/bin/sh\n");
  await chmod(cd, 0o755);

  await assert.rejects(
    locateExecutable("cd", { env: { PATH: temp, SHELL: process.env.SHELL } }),
    (error) => {
      assert.equal(error.exitCode, exitCodes.resolution);
      assert.match(error.message, /shell alias, function, or builtin/);
      return true;
    },
  );
});

test("CLI maps missing command to exit 2 with actionable error", async () => {
  const result = await run(["--agent", "none", "definitely-not-a-real-command", "help"]);

  assert.equal(result.exitCode, exitCodes.resolution);
  assert.match(result.stderr, /Resolution error:/);
  assert.match(result.stderr, /Attempted:/);
  assert.match(result.stderr, /Next step:/);
});
