/**
 * Update check / apply from the GitHub repo.
 *  - git mode: the folder is a git clone → git fetch / git pull --ff-only.
 *  - zip mode: anything else (e.g. a Drive folder) → GitHub API with your token, download the
 *    zip of the branch, back up the files that will change, copy the new ones over.
 * Your data is never touched: server/.*.json, logs/, .env*, node_modules/, backups/, browser storage.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import os from "node:os";

const run = promisify(execFile);
const ROOT = process.cwd();
const DATA = process.env.JOKERZ_DATA || join(ROOT, "server");
const CFG_FILE = join(DATA, ".update-config.json");
const VERSION_FILE = join(ROOT, ".jokerz-version");
export const DEFAULT_REPO = "jhoendy007-max/jokerz-aio";

/** Paths never overwritten by an update. */
export function isProtected(rel) {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    /^(node_modules|logs|backups|\.git|\.sessions|\.vinxi|\.output|dist)(\/|$)/.test(p) ||
    /^server\/\.[^/]+$/.test(p) ||
    /(^|\/)\.env(\.|$)/.test(p) ||
    p === ".jokerz-version" ||
    /\.(pem|key)$/.test(p)
  );
}

export function loadUpdateConfig() {
  try {
    return { repo: DEFAULT_REPO, branch: "main", token: "", ...JSON.parse(readFileSync(CFG_FILE, "utf8")) };
  } catch {
    return { repo: DEFAULT_REPO, branch: "main", token: "" };
  }
}
export function saveUpdateConfig(patch = {}) {
  const cur = loadUpdateConfig();
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(CFG_FILE, JSON.stringify(next, null, 2));
  return publicConfig(next);
}
const isGit = () => existsSync(join(ROOT, ".git"));
/** git folder without a saved token → git pull; with a token → GitHub API zip (works for private repos without git credentials) */
const useGit = (c = loadUpdateConfig()) => isGit() && !c.token;
export const publicConfig = (c = loadUpdateConfig()) => ({ repo: c.repo, branch: c.branch, hasToken: Boolean(c.token), mode: useGit(c) ? "git" : "zip" });
async function git(...args) {
  const { stdout } = await run("git", args, { cwd: ROOT, timeout: 120000 });
  return stdout.trim();
}

function localVersion() {
  try {
    return JSON.parse(readFileSync(VERSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function gh(path, cfg, { raw = false } = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: raw ? "application/vnd.github+json" : "application/vnd.github+json", "User-Agent": "jokerz-aio-updater", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    redirect: "follow",
  });
  if (r.status === 404) throw new Error(cfg.token ? "Repo not found — check the repo name and that the token can read it" : "Private repo — add a GitHub token (read-only, Contents: Read) in Settings → General → Updates");
  if (r.status === 401) throw new Error("GitHub token rejected — create a new one");
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  return raw ? r : r.json();
}

export async function checkForUpdate() {
  const cfg = loadUpdateConfig();
  if (useGit()) {
    try {
      await git("fetch", "--quiet", "origin", cfg.branch);
      const head = await git("rev-parse", "HEAD");
      const behind = Number(await git("rev-list", "--count", `HEAD..origin/${cfg.branch}`)) || 0;
      const log = behind ? await git("log", "--format=%h%x09%cI%x09%s", `HEAD..origin/${cfg.branch}`, "-n", "30") : "";
      const commits = log ? log.split("\n").map((l) => { const [sha, date, ...m] = l.split("\t"); return { sha, date, message: m.join("\t") }; }) : [];
      return { ok: true, mode: "git", current: head.slice(0, 7), available: behind > 0, behind, commits };
    } catch (e) {
      return { ok: false, mode: "git", error: `git: ${e?.stderr || e?.message || e}`.slice(0, 300) };
    }
  }
  try {
    const latest = await gh(`/repos/${cfg.repo}/commits/${cfg.branch}`, cfg);
    const cur = localVersion();
    let commits = [];
    if (cur?.sha && cur.sha !== latest.sha) {
      const cmp = await gh(`/repos/${cfg.repo}/compare/${cur.sha}...${latest.sha}`, cfg).catch(() => null);
      commits = (cmp?.commits || []).reverse().slice(0, 30).map((c) => ({ sha: c.sha.slice(0, 7), date: c.commit?.committer?.date, message: String(c.commit?.message || "").split("\n")[0] }));
    } else if (!cur?.sha) {
      commits = [{ sha: latest.sha.slice(0, 7), date: latest.commit?.committer?.date, message: String(latest.commit?.message || "").split("\n")[0] }];
    }
    return { ok: true, mode: "zip", current: cur?.sha?.slice(0, 7) || "unknown", latest: latest.sha.slice(0, 7), available: cur?.sha !== latest.sha, behind: commits.length, commits };
  } catch (e) {
    return { ok: false, mode: "zip", error: e?.message || String(e) };
  }
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(base, p);
    if (isProtected(rel)) continue;
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(rel);
  }
  return out;
}

async function npmInstallIfNeeded(changed) {
  if (!changed.some((f) => /^package(-lock)?\.json$/.test(f.replace(/\\/g, "/")))) return { ran: false };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["install", "--no-fund", "--no-audit"], { cwd: ROOT, timeout: 15 * 60000, shell: process.platform === "win32" });
  return { ran: true };
}

export async function applyUpdate() {
  const cfg = loadUpdateConfig();
  if (useGit()) {
    try {
      const before = await git("rev-parse", "HEAD");
      await git("pull", "--ff-only", "origin", cfg.branch);
      const after = await git("rev-parse", "HEAD");
      const changed = before === after ? [] : (await git("diff", "--name-only", before, after)).split("\n").filter(Boolean);
      const npm = await npmInstallIfNeeded(changed);
      return { ok: true, mode: "git", from: before.slice(0, 7), to: after.slice(0, 7), changed: changed.length, npmInstall: npm.ran, restartNeeded: changed.length > 0 };
    } catch (e) {
      return { ok: false, mode: "git", error: `git: ${e?.stderr || e?.message || e}`.slice(0, 400) };
    }
  }
  const tmp = join(os.tmpdir(), `jokerz-update-${Date.now()}`);
  try {
    const latest = await gh(`/repos/${cfg.repo}/commits/${cfg.branch}`, cfg);
    const r = await gh(`/repos/${cfg.repo}/zipball/${latest.sha}`, cfg, { raw: true });
    mkdirSync(tmp, { recursive: true });
    const zip = join(tmp, "update.zip");
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    // Windows 10+ / macOS / Linux all ship `tar` that can read zip files
    await run("tar", ["-xf", zip, "-C", tmp], { timeout: 120000 });
    const top = readdirSync(tmp).map((n) => join(tmp, n)).find((p) => statSync(p).isDirectory());
    if (!top || !existsSync(join(top, "package.json"))) throw new Error("Downloaded update looks wrong (no package.json)");
    const files = walk(top);
    const changed = files.filter((rel) => {
      const dst = join(ROOT, rel);
      return !existsSync(dst) || !readFileSync(dst).equals(readFileSync(join(top, rel)));
    });
    const backupDir = join(ROOT, "backups", `update-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    for (const rel of changed) {
      const dst = join(ROOT, rel);
      if (existsSync(dst)) {
        mkdirSync(dirname(join(backupDir, rel)), { recursive: true });
        cpSync(dst, join(backupDir, rel));
      }
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(top, rel), dst);
    }
    writeFileSync(VERSION_FILE, JSON.stringify({ sha: latest.sha, date: latest.commit?.committer?.date, at: Date.now() }));
    const npm = await npmInstallIfNeeded(changed);
    return { ok: true, mode: "zip", to: latest.sha.slice(0, 7), changed: changed.length, backup: changed.length ? relative(ROOT, backupDir) : null, npmInstall: npm.ran, restartNeeded: changed.length > 0 };
  } catch (e) {
    return { ok: false, mode: "zip", error: e?.message || String(e) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
