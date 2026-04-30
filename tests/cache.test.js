import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CacheStore, cacheKeyForResolution, defaultCacheRoot } from "../dist/cache/store.js";

test("cache root honors XDG_CACHE_HOME", () => {
  assert.equal(defaultCacheRoot({ XDG_CACHE_HOME: "/tmp/cache-home" }), "/tmp/cache-home/ask");
});

test("cache key includes entry source hash", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cache-"));
  const entryFile = join(temp, "entry.js");
  await writeFile(entryFile, "one");

  const first = await cacheKeyForResolution(resolution({ entryFile }));
  await writeFile(entryFile, "two");
  const second = await cacheKeyForResolution(resolution({ entryFile }));

  assert.notEqual(first, second);
});

test("cache key includes collection options", async () => {
  const base = resolution();

  const noExec = await cacheKeyForResolution(base, collectionOptions({ noExec: true }));
  const execAllowed = await cacheKeyForResolution(base, collectionOptions({ noExec: false }));
  const smallerFiles = await cacheKeyForResolution(base, collectionOptions({ maxFiles: 1 }));
  const smallerBytes = await cacheKeyForResolution(base, collectionOptions({ maxBytes: 128 }));

  assert.notEqual(noExec, execAllowed);
  assert.notEqual(noExec, smallerFiles);
  assert.notEqual(noExec, smallerBytes);
});

test("cache key includes metadata file content", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cache-metadata-"));
  const metadata = join(temp, "package.json");
  await writeFile(metadata, "{\"version\":\"one\"}\n");

  const first = await cacheKeyForResolution(
    resolution({ metadataFiles: [metadata] }),
    collectionOptions(),
  );
  await writeFile(metadata, "{\"version\":\"two\"}\n");
  const second = await cacheKeyForResolution(
    resolution({ metadataFiles: [metadata] }),
    collectionOptions(),
  );

  assert.notEqual(first, second);
});

test("cache stores and restores context bundles with bigint fields", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cache-"));
  const store = new CacheStore(temp);
  const bundle = {
    resolution: resolution({ executableMtimeNs: 42n }),
    helpOutputs: [],
    files: [],
    totalBytes: 0,
    warnings: [],
  };

  await store.setBundle("key", bundle);
  const restored = await store.getBundle("key");

  assert.equal(restored.resolution.executableMtimeNs, 42n);
});

test("cache stores workspace contents and evicts least-recent entries", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-cache-"));
  const workspace = join(temp, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "ASK_CONTEXT.md"), "context");

  const store = new CacheStore(join(temp, "cache"));
  await store.storeWorkspace("workspace-key", workspace);
  assert.equal(
    await readFile(join(temp, "cache", "workspaces", "workspace-key", "ASK_CONTEXT.md"), "utf8"),
    "context",
  );

  await writeFile(join(temp, "cache", "large.bin"), "x".repeat(2048));
  await store.evict(0.0001);

  await assert.rejects(readFile(join(temp, "cache", "large.bin"), "utf8"));
});

function resolution(overrides = {}) {
  return {
    command: "tool",
    executablePath: "/bin/tool",
    executableRealPath: "/bin/tool",
    executableMtimeNs: 1n,
    ecosystem: "fallback",
    packageName: "tool",
    version: "1.0.0",
    packageRoot: null,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings: [],
    shim: null,
    ...overrides,
  };
}

function collectionOptions(overrides = {}) {
  return {
    maxFiles: 200,
    maxBytes: 8_388_608,
    noExec: false,
    allowHelpExec: true,
    packageRootOverride: undefined,
    executableOverride: undefined,
    ...overrides,
  };
}
