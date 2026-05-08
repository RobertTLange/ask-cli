import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkoutGitRepository,
  normalizeGitHubRepository,
  validateRepositoryRef,
} from "../dist/repos/github.js";

test("normalizes GitHub owner/name and HTTPS URL inputs", () => {
  assert.deepEqual(normalizeGitHubRepository("RobertTLange/ask-cli"), {
    input: "RobertTLange/ask-cli",
    owner: "RobertTLange",
    name: "ask-cli",
    slug: "RobertTLange/ask-cli",
    remoteUrl: "https://github.com/RobertTLange/ask-cli.git",
  });

  assert.equal(
    normalizeGitHubRepository("https://github.com/RobertTLange/ask-cli.git").remoteUrl,
    "https://github.com/RobertTLange/ask-cli.git",
  );
});

test("rejects unsupported GitHub repository inputs", () => {
  for (const input of [
    "git@github.com:RobertTLange/ask-cli.git",
    "https://token@github.com/RobertTLange/ask-cli.git",
    "https://example.com/RobertTLange/ask-cli.git",
    "https://github.com/RobertTLange/ask-cli/issues",
  ]) {
    assert.throws(() => normalizeGitHubRepository(input), /unsupported GitHub repository/);
  }
});

test("validates safe repository refs", () => {
  assert.equal(validateRepositoryRef("main"), "main");
  assert.equal(validateRepositoryRef("release/v1.2.3"), "release/v1.2.3");
  assert.throws(() => validateRepositoryRef("-main"), /unsupported repository ref/);
  assert.throws(() => validateRepositoryRef("main^{commit}"), /unsupported repository ref/);
  assert.throws(() => validateRepositoryRef("feature branch"), /unsupported repository ref/);
});

test("checkoutGitRepository caches a bare clone and creates a read-only full worktree", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-github-repo-"));
  const source = join(temp, "source");
  const cacheRoot = join(temp, "cache");
  await mkdir(source);
  await git(["init", "-b", "main"], source);
  await git(["config", "user.email", "test@example.com"], source);
  await git(["config", "user.name", "Test User"], source);
  await writeFile(join(source, "README.md"), "# Fixture\n");
  await mkdir(join(source, "src"));
  await writeFile(join(source, "src", "index.js"), "export const answer = 42;\n");
  await git(["add", "."], source);
  await git(["commit", "-m", "initial"], source);
  const commit = (await git(["rev-parse", "HEAD"], source)).trim();

  const result = await checkoutGitRepository({
    repository: {
      input: "local/repo",
      owner: "local",
      name: "repo",
      slug: "local/repo",
      remoteUrl: source,
    },
    question: "Where is answer defined?",
    ref: "main",
    cacheRoot,
    refresh: false,
  });

  try {
    assert.equal(result.commit, commit);
    assert.equal(result.resolvedRef, "main");
    assert.equal(await readFile(join(result.workspacePath, "README.md"), "utf8"), "# Fixture\n");
    assert.equal(await readFile(join(result.workspacePath, "src", "index.js"), "utf8"), "export const answer = 42;\n");
    await assert.rejects(access(join(result.workspacePath, ".git"), fsConstants.F_OK));
    assert.match(await readFile(join(result.workspacePath, "ASK_CONTEXT.md"), "utf8"), /Repository: local\/repo/);
    assert.equal((await stat(join(result.workspacePath, "README.md"))).mode & 0o777, 0o444);
  } finally {
    await result.cleanup();
  }
});

async function git(args, cwd) {
  const result = await run("git", args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
