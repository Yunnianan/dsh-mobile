import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync("./lib/index.js", "utf8");
// Pull the class out and stub the two constants it closes over.
const start = src.indexOf("class PairingStore");
const end = src.indexOf("\n}", src.indexOf("checkAutoPairSecret")) + 2;
let body = src.slice(start, end);
const prelude = `
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
function randomId(n) { return randomBytes(n).toString("hex").slice(0, n * 2); }
function safeEqual(a, b) { return typeof a === "string" && typeof b === "string" && a.length === b.length && a === b; }
function describeDevice() { return "test device"; }
`;
const dir = mkdtempSync(join(tmpdir(), "store-"));
const file = join(dir, "m.mjs");
writeFileSync(file, prelude + body + "\nexport { PairingStore };\n", "utf8");
const mod = await import("file:///" + file.replace(/\\/g, "/"));

const storePath = join(dir, "store.json");
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
writeFileSync(storePath, JSON.stringify({
  devices: {
    fresh:    { createdAt: now - DAY,     expiresAt: now + 30 * DAY, lastSeenAt: now - 60000 },   // just used
    stale6d:  { createdAt: now - 20 * DAY, expiresAt: now + 20 * DAY, lastSeenAt: now - 6 * DAY }, // 6 days idle - keep
    idle8d:   { createdAt: now - 30 * DAY, expiresAt: now + 20 * DAY, lastSeenAt: now - 8 * DAY }, // 8 days idle - drop
    noSeen:   { createdAt: now - 10 * DAY, expiresAt: now + 20 * DAY },                            // legacy, no lastSeenAt
    expired:  { createdAt: now - 40 * DAY, expiresAt: now - DAY,      lastSeenAt: now - 60000 },   // expired - drop
  },
  pairing: { old: { token: "x", expiresAt: now - 1000 }, live: { token: "y", expiresAt: now + 60000 } },
  config: {},
}, null, 2), "utf8");

const store = new mod.PairingStore(storePath);
store.sweep(now);
const left = Object.keys(store.state.devices).sort();
const checks = [
  ["keeps the device seen a minute ago", left.includes("fresh")],
  ["keeps a device idle 6 days (< 7)",   left.includes("stale6d")],
  ["drops a device idle 8 days",         !left.includes("idle8d")],
  ["drops a legacy record using createdAt", !left.includes("noSeen")],
  ["drops an expired device",            !left.includes("expired")],
  ["drops the expired token",            !Object.keys(store.state.pairing).includes("old")],
  ["keeps the live token",               Object.keys(store.state.pairing).includes("live")],
];
let fail = 0;
for (const [label, ok] of checks) { if (!ok) fail++; console.log("  " + (ok ? "ok  " : "FAIL") + " " + label); }
console.log("  remaining devices:", left.join(", "));
console.log(fail ? `  ${fail} 项失败` : "  ✅ 全部通过");
process.exit(fail ? 1 : 0);
