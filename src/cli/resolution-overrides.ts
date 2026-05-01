import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AskError } from "../errors.js";
import type { Resolution } from "../types.js";
import { exitCodes } from "./constants.js";

export async function applyPackageRootOverride(
  resolution: Resolution,
  packageRootOverride: string | undefined,
): Promise<Resolution> {
  if (!packageRootOverride) {
    return resolution;
  }

  const resolvedRoot = resolve(packageRootOverride);
  const rootStat = await stat(resolvedRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new AskError(
      "--package-root must point to a directory",
      exitCodes.resolution,
      `validate package root override ${resolvedRoot}`,
      "pass an existing package directory",
    );
  }

  const realOverride = await realpath(resolvedRoot);
  const existingRoot = resolution.packageRoot
    ? await realpath(resolution.packageRoot).catch(() => resolution.packageRoot)
    : null;
  const warnings = [`Package root override applied: ${realOverride}`];
  let confidence = resolution.confidence;

  if (existingRoot && existingRoot !== realOverride) {
    warnings.push("Package root override differs from resolver package root; confidence lowered to medium");
    confidence = lowerConfidenceToMedium(confidence);
  }

  if (resolution.entryFile && !isWithin(realOverride, resolution.entryFile)) {
    warnings.push("Resolver entry file is outside package root override and may be skipped from staged package source");
    confidence = lowerConfidenceToMedium(confidence);
  }

  return {
    ...resolution,
    packageRoot: realOverride,
    confidence,
    warnings: [...resolution.warnings, ...warnings],
  };
}

function lowerConfidenceToMedium(confidence: Resolution["confidence"]): Resolution["confidence"] {
  return confidence === "high" ? "medium" : confidence;
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(root, path);
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath) && !relPath.startsWith(sep));
}
