import type { ContextBundle, Resolution, Uncertainty } from "../types.js";

export function buildUncertainty(
  resolution: Resolution,
  bundle: ContextBundle,
): readonly Uncertainty[] {
  const items: Uncertainty[] = [];

  if (resolution.confidence === "low") {
    items.push({
      code: "low_confidence",
      message: "Resolver confidence is low; package identity or source coverage may be incomplete.",
    });
  }

  if (resolution.ecosystem === "fallback") {
    items.push({
      code: "fallback_resolution",
      message: "ask could not resolve package metadata and used fallback command context.",
    });
  }

  if (
    bundle.warnings.some((warning) => /limit|truncat/i.test(warning))
    || bundle.files.some((file) => file.truncated)
    || bundle.helpOutputs.some((output) => output.truncated)
  ) {
    items.push({
      code: "context_truncated",
      message: "Collected context hit file, byte, or output limits.",
    });
  }

  if (resolution.ecosystem === "fallback" && bundle.helpOutputs.length > 0) {
    items.push({
      code: "fallback_help_exec",
      message: "Bounded help/version/man commands were executed for fallback context.",
    });
  }

  return items;
}

export function formatUncertaintyBlock(uncertainty: readonly Uncertainty[]): string {
  if (uncertainty.length === 0) {
    return "";
  }

  return [
    "Uncertainty:",
    ...uncertainty.map((item) => `- ${item.message} [${item.code}]`),
    "",
  ].join("\n");
}
