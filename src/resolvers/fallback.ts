import type { LocatedExecutable, Resolution } from "../types.js";

export function resolveCargoStub(located: LocatedExecutable): Resolution {
  return stubResolution(
    located,
    "cargo",
    "Cargo source-level resolution is not available in the MVP; using fallback context only",
  );
}

export function resolveHomebrewStub(located: LocatedExecutable): Resolution {
  return stubResolution(
    located,
    "homebrew",
    "Homebrew source-level resolution is not available in the MVP; using fallback context only",
  );
}

export function resolveGenericFallback(located: LocatedExecutable): Resolution {
  return stubResolution(
    located,
    "fallback",
    "Source-level resolution is not available; using help, version, man, and completion context only",
  );
}

function stubResolution(
  located: LocatedExecutable,
  ecosystem: Resolution["ecosystem"],
  warning: string,
): Resolution {
  return {
    command: located.command,
    executablePath: located.path,
    executableRealPath: located.realPath,
    executableMtimeNs: located.mtimeNs,
    ecosystem,
    packageName: null,
    version: null,
    packageRoot: null,
    entryFile: null,
    metadataFiles: [],
    confidence: "low",
    warnings: [warning],
    shim: located.shim,
  };
}
