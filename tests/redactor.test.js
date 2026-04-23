import assert from "node:assert/strict";
import test from "node:test";

import { redactText } from "../dist/workspace/redact.js";

test("redactor masks common API key patterns", () => {
  const input = [
    "aws AKIA1234567890ABCDEF",
    "github ghp_abcdefghijklmnopqrstuvwxyz",
    "slack xoxb-1234567890-abcdef",
    "jwt eyJabc.def.ghi",
    "openai sk-abcdefghijklmnopqrstuvwxyz",
    "anthropic sk-ant-abcdefghijklmnopqrstuvwxyz",
  ].join("\n");

  const result = redactText(input, {});

  assert.equal(result.redactions, 6);
  assert.doesNotMatch(result.text, /AKIA1234567890ABCDEF/);
  assert.doesNotMatch(result.text, /ghp_/);
  assert.doesNotMatch(result.text, /xoxb-/);
  assert.doesNotMatch(result.text, /eyJabc/);
  assert.doesNotMatch(result.text, /sk-/);
});

test("redactor masks sensitive environment values", () => {
  const result = redactText("token is secret-value", {
    FIXTURE_TOKEN: "secret-value",
    ORDINARY_VALUE: "token is",
  });

  assert.equal(result.text, "token is [REDACTED]");
  assert.equal(result.redactions, 1);
});
