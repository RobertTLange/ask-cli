import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readUtf8FileWithinLimit, readUtf8Prefix } from "../dist/fs/read-prefix.js";

test("readUtf8Prefix reads only the requested prefix", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-prefix-"));
  const path = join(temp, "large.txt");
  await writeFile(path, `${"a".repeat(1024)}tail`);

  const result = await readUtf8Prefix(path, 8);

  assert.deepEqual(result, {
    text: "aaaaaaaa",
    sizeBytes: 1028,
    truncated: true,
  });
});

test("readUtf8FileWithinLimit rejects oversized files before decoding content", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ask-prefix-limit-"));
  const path = join(temp, "large-wrapper");
  await writeFile(path, "exec ./target\n");

  const result = await readUtf8FileWithinLimit(path, 4);

  assert.equal(result, null);
});
