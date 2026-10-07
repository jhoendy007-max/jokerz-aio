#!/usr/bin/env node
/** Runs ALL tests (scripts/*.test.mjs + TypeScript tests). Requires Node 22.6+. Cross-platform (Windows cmd does not expand globs). */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { requireNode22 } from "./require-node22.mjs";

requireNode22();
const files = readdirSync("scripts").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `scripts/${f}`);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`]));
const TS = walk("src").filter((f) => f.endsWith(".test.ts")).sort();
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`\n${files.length} script test files OK · running ${TS.length} TypeScript test files`);
const t = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...TS], { stdio: "inherit" });
process.exit(t.status ?? 1);
