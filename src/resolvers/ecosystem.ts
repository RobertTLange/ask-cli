import { dirname, sep } from "node:path";
import type { Ecosystem as CliEcosystem } from "../cli/config.js";
import type { Ecosystem, LocatedExecutable } from "../types.js";

export interface EcosystemDecision {
  readonly ecosystem: Ecosystem;
  readonly ruleMatched: string;
}

export function detectEcosystem(
  located: LocatedExecutable,
  override: CliEcosystem = "auto",
): EcosystemDecision {
  if (override !== "auto") {
    return { ecosystem: override, ruleMatched: "override" };
  }

  if (isPythonShebang(located.shebang)) {
    return { ecosystem: "python", ruleMatched: "shebang:python" };
  }

  if (isNodeShebang(located.shebang)) {
    return { ecosystem: "npm", ruleMatched: "shebang:node" };
  }

  const executableDir = dirname(located.realPath);
  if (isInsidePythonPackages(executableDir)) {
    return { ecosystem: "python", ruleMatched: "path:site-packages" };
  }

  if (isInsideNodeBin(executableDir) || isInsideNvm(executableDir)) {
    return { ecosystem: "npm", ruleMatched: "path:node-bin" };
  }

  if (isInsideCargoBin(executableDir)) {
    return { ecosystem: "cargo", ruleMatched: "path:cargo-bin" };
  }

  if (isInsideHomebrew(executableDir)) {
    return { ecosystem: "homebrew", ruleMatched: "path:homebrew" };
  }

  return { ecosystem: "fallback", ruleMatched: "fallback" };
}

function isPythonShebang(shebang: string | null): boolean {
  return shebang !== null && /(^|\s|\/)python[0-9.]*($|\s)/.test(shebang);
}

function isNodeShebang(shebang: string | null): boolean {
  return shebang !== null && /(^|\s|\/)node($|\s)/.test(shebang);
}

function isInsidePythonPackages(path: string): boolean {
  return path.split(sep).some((part) => part === "site-packages" || part === "dist-packages");
}

function isInsideNodeBin(path: string): boolean {
  return path.includes(`${sep}node_modules${sep}.bin`);
}

function isInsideNvm(path: string): boolean {
  return path.includes(`${sep}.nvm${sep}versions${sep}node${sep}`);
}

function isInsideCargoBin(path: string): boolean {
  return path.includes(`${sep}.cargo${sep}bin`);
}

function isInsideHomebrew(path: string): boolean {
  return (
    path.startsWith(`${sep}opt${sep}homebrew${sep}`) ||
    path.startsWith(`${sep}usr${sep}local${sep}Cellar${sep}`) ||
    path.startsWith(`${sep}home${sep}linuxbrew${sep}`)
  );
}
