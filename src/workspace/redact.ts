const secretPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
];

export function redactText(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): { text: string; redactions: number } {
  let text = input;
  let redactions = 0;

  for (const pattern of secretPatterns) {
    text = text.replace(pattern, () => {
      redactions += 1;
      return "[REDACTED]";
    });
  }

  for (const [name, value] of Object.entries(env)) {
    if (!value || !isSensitiveEnvName(name)) {
      continue;
    }

    const occurrences = text.split(value).length - 1;
    if (occurrences > 0) {
      redactions += occurrences;
      text = text.replaceAll(value, "[REDACTED]");
    }
  }

  return { text, redactions };
}

function isSensitiveEnvName(name: string): boolean {
  return /(?:_TOKEN|_KEY|_SECRET|_PASSWORD)$/i.test(name);
}
