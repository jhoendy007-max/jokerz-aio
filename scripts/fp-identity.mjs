/**
 * Sticky browser identity per task.
 * Same task = same GPU/viewport/hw forever. Different tasks = different PC.
 * Never logs proxy credentials.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.env.JOKERZ_DATA || join(process.cwd(), "server");
const FILE = process.env.JOKERZ_FP_FILE || join(ROOT, ".fp-identities.json");

const GPUS = [
  ["Google Inc. (Intel)", "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (Intel)", "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (AMD)", "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
  ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)"],
];

const VIEWS = [
  [1920, 1080],
  [1920, 1200],
  [1680, 1050],
  [1600, 900],
  [1536, 864],
  [1440, 900],
  [1366, 768],
];

const CORES = [4, 6, 8, 12, 16];
const RAM = [8, 8, 16, 16, 32];

const TZ = [
  { tz: "America/New_York", lat: 40.758, lon: -73.985, offset: -300 },
  { tz: "America/Chicago", lat: 41.878, lon: -87.629, offset: -360 },
  { tz: "America/Denver", lat: 39.739, lon: -104.99, offset: -420 },
  { tz: "America/Los_Angeles", lat: 34.052, lon: -118.244, offset: -480 },
  { tz: "America/New_York", lat: 27.767, lon: -82.64, offset: -300 },
];

function hash(s) {
  return createHash("sha256").update(String(s || "x")).digest();
}

function pick(arr, n) {
  return arr[n % arr.length];
}

function loadAll() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8") || "{}");
  } catch {
    /* */
  }
  return {};
}

function saveAll(obj) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, FILE);
}

export function getIdentity(taskId) {
  const id = String(taskId || "").trim() || "anon";
  const all = loadAll();
  if (all[id]?.gpu && all[id]?.width) {
    if (!all[id].seed) {
      all[id].seed = hash(id).readUInt32LE(8) || 1;
    }
    if (!all[id].tz || all[id].lat == null) {
      const zone = pick(TZ, hash(id)[7]);
      all[id].tz = all[id].tz || zone.tz;
      all[id].lat = zone.lat;
      all[id].lon = zone.lon;
      all[id].tzOffset = zone.offset;
    }
    saveAll(all);
    return all[id];
  }
  const h = hash(id);
  const gpu = pick(GPUS, h[0]);
  const view = pick(VIEWS, h[1]);
  const zone = pick(TZ, h[7]);
  const ident = {
    taskId: id,
    gpuVendor: gpu[0],
    gpuRenderer: gpu[1],
    width: view[0],
    height: view[1],
    cores: pick(CORES, h[2]),
    memory: pick(RAM, h[3]),
    dpr: h[4] % 5 === 0 ? 1.25 : 1,
    canvasNoise: h[5] / 255,
    audioNoise: (h[6] - 128) / 5000,
    seed: h.readUInt32LE(8) || 1,
    tz: zone.tz,
    lat: zone.lat,
    lon: zone.lon,
    tzOffset: zone.offset,
    lang: "en-US",
    at: Date.now(),
  };
  all[id] = ident;
  saveAll(all);
  return ident;
}

export function identityHint(ident) {
  if (!ident) return "fp-none";
  const gpu = String(ident.gpuRenderer || "").match(/Intel|NVIDIA|AMD/i)?.[0] || "GPU";
  return `${ident.width}x${ident.height} · ${ident.cores}c/${ident.memory}G · ${gpu} · audio`;
}