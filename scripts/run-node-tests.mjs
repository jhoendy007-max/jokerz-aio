#!/usr/bin/env node
/** Cross-platform `node --test scripts/*.test.mjs` (Windows cmd does not expand globs; Node 20 does not either). */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = readdirSync("scripts").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `scripts/${f}`);
const TS = ["src/jokerz/engine/alertDedupe.test.ts", "src/jokerz/engine/apiTypes.test.ts", "src/jokerz/lib/drops.test.ts", "src/jokerz/lib/backup.test.ts", "src/jokerz/lib/monitorHistory.test.ts", "src/jokerz/lib/alertImage.test.ts", "src/jokerz/lib/dailySummary.test.ts", "src/jokerz/lib/monitorPolicy.test.ts", "src/jokerz/lib/extras.test.ts", "src/lib/app-data/app-data.test.ts", "src/lib/auth/gate-identity.test.ts"];
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
// TypeScript tests need Node >= 22.6 (or a Node 20 build with --experimental-strip-types)
const probe = spawnSync(process.execPath, ["--experimental-strip-types", "-e", "0"], { stdio: "ignore" });
if (probe.status !== 0) {
  console.log(`\nSkipping ${TS.length} TypeScript test files: Node ${process.version} has no --experimental-strip-types (use Node 22 LTS to run them).`);
  process.exit(0);
}
const t = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...TS], { stdio: "inherit" });
process.exit(t.status ?? 1);
