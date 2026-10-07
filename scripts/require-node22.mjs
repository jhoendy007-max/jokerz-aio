#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/** Tests need Node >= 22.6 (they run TypeScript files with --experimental-strip-types). */
export const MIN = [22, 6];
export function nodeOk(v = process.versions.node) {
  const [maj, min] = v.split(".").map(Number);
  return maj > MIN[0] || (maj === MIN[0] && min >= MIN[1]);
}
export function requireNode22() {
  if (nodeOk()) return;
  console.error(
    [
      "",
      `  Tests need Node ${MIN.join(".")} or newer — you have ${process.version}.`,
      "  Los tests necesitan Node 22 LTS (22.6+). Instálalo desde https://nodejs.org (o: nvm install 22 && nvm use 22).",
      "  The app itself still runs on Node 20 (START-JOKERZ.bat).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) requireNode22();
