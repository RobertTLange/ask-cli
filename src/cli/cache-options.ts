import type { CollectionCacheOptions } from "../cache/store.js";
import type { ParsedInvocation } from "./args.js";

export function cacheOptionsForInvocation(invocation: ParsedInvocation): CollectionCacheOptions {
  return {
    maxFiles: invocation.config.maxFiles,
    maxBytes: invocation.config.maxBytes,
    noExec: invocation.config.noExec,
    allowHelpExec: invocation.config.allowHelpExec,
    packageRootOverride: invocation.config.packageRoot,
    executableOverride: invocation.config.executable,
  };
}
