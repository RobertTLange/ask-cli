import type { Limits } from "../types.js";

export const defaultLimits: Limits = {
  maxFiles: 200,
  maxBytesPerFile: 262_144,
  maxTotalBytes: 8_388_608,
  helpTimeoutMs: 5_000,
  helpStdoutBytes: 131_072,
  subcommandHelpLimit: 10,
};
