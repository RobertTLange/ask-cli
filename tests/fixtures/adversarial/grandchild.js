#!/usr/bin/env node
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
setTimeout(() => {}, 60_000);
