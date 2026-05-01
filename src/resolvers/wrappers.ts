import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readUtf8FileWithinLimit } from "../fs/read-prefix.js";

const maxWrapperBytes = 16_384;

export async function resolveLocalWrapperTarget(wrapperPath: string): Promise<string | null> {
  const wrapperRealPath = await realpath(wrapperPath).catch(() => wrapperPath);
  const content = await readUtf8FileWithinLimit(wrapperRealPath, maxWrapperBytes);
  if (!content || content.includes("\u0000")) {
    return null;
  }

  const wrapperDir = dirname(wrapperRealPath);
  const containmentRoot = dirname(wrapperDir);
  for (const specifier of localTargetSpecifiers(content)) {
    const candidate = resolveSpecifier(wrapperDir, specifier);
    if (!candidate) {
      continue;
    }

    const target = await realpath(candidate).catch(() => null);
    if (!target || target === wrapperRealPath || !isWithin(containmentRoot, target)) {
      continue;
    }

    try {
      if ((await stat(target)).isFile()) {
        return target;
      }
    } catch {
      // Keep scanning other simple wrapper target patterns.
    }
  }

  return null;
}

function localTargetSpecifiers(content: string): readonly string[] {
  const specs: string[] = [];
  const patterns = [
    /\$basedir\/([^"'\s)]+)/g,
    /\$\{basedir\}\/([^"'\s)]+)/g,
    /\b(?:require|import)\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\bos\.execv\(\s*["']([^"']+)["']/g,
    /\bexec(?:v|ve)?\(\s*["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        specs.push(match[1]);
      }
    }
  }

  return specs;
}

function resolveSpecifier(wrapperDir: string, specifier: string): string | null {
  if (specifier.length === 0) {
    return null;
  }

  if (isAbsolute(specifier)) {
    return specifier;
  }

  return resolve(join(wrapperDir, specifier));
}

function isWithin(root: string, path: string): boolean {
  const relPath = relative(root, path);
  return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith(sep));
}
