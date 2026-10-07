#!/usr/bin/env node
/** Cross-platform `node --test scripts/*.test.mjs` (Windows cmd does not expand globs; Node 20 does not either). */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = readdirSync("scripts").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `scripts/${f}`);
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
