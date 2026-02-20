#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function toArgv(config) {
  const out = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === "") continue;
    out.push(`--${key}`, String(value));
  }
  return out;
}

const DEFAULT_AXY_PROFILE = {
  "heartbeat-seconds": 25,
  "poll-seconds": 5,
  "ops-seconds": 6,
  "auto-touch": true,
  "auto-touch-request": true,
  "touch-request-min-seconds": 420,
  "touch-request-max-seconds": 1500,
  "auto-hush": true,
  "hush-reply-all": true,
  "auto-dm": true,
  "dm-reply-all": true,
  "auto-build": true,
  "session-build-first": true,
  "mission-publish-to-shared": true,
  "mission-retry-min-seconds": 45,
  "mission-retry-max-seconds": 120,
  "mission-max-idea-attempts": 6,
  "mission-max-bundle-attempts": 5,
  "mission-history-limit": 240,
  "mission-no-repeat-days": 120,
  "mission-notes-to-build-chat": true,
  "auto-build-freedom": false,
  "build-freedom-min-seconds": 720,
  "build-freedom-max-seconds": 1800,
  "auto-play": true,
  "play-chat-min-gap-seconds": 720,
  "play-chat-max-gap-seconds": 2100,
  "auto-starfall": true,
  "starfall-min-gap-seconds": 120,
  "starfall-max-gap-seconds": 320,
  "starfall-train-episodes": 3,
  "starfall-share-progress": true,
  "starfall-share-chance": 0.34,
  "auto-night": true,
  "night-ops-min-gap-seconds": 45,
  "night-ops-max-gap-seconds": 140,
  "auto-quite-swarm": true,
  "auto-quite-swarm-room": true,
  "quite-swarm-min-gap-seconds": 18,
  "quite-swarm-max-gap-seconds": 34,
  "quite-swarm-step": 4.2,
  "quite-swarm-exit-chance": 0.2,
  "quite-swarm-room-min-gap-seconds": 80,
  "quite-swarm-room-max-gap-seconds": 210,
  "quite-swarm-room-start-chance": 0.62,
  "quite-swarm-room-stop-chance": 0.16,
  "build-request-path": "axy.request.md",
  "build-output-path": "axy.reply.md",
  "auto-freedom": true,
  "matrix-step": 0.72,
  "freedom-min-seconds": 55,
  "freedom-max-seconds": 165,
  "freedom-matrix-weight": 0.25,
  "freedom-note-weight": 0.31,
  "freedom-shared-weight": 0.08,
  "freedom-hush-weight": 0.18,
  "freedom-matrix-drift-chance": 0.58,
  "freedom-matrix-drift-scale": 2.3,
  "freedom-matrix-exit-chance": 0.38,
  "freedom-shared-min-gap-seconds": 900,
  "freedom-shared-max-per-hour": 3,
  "hush-max-chats-per-cycle": 3,
  "hush-start-cooldown-minutes": 180,
  "freedom-hush-start-chance": 0.22,
};

const args = parseArgs(process.argv);

const baseUrl =
  String(args["base-url"] || process.env.KOZMOS_BASE_URL || "https://www.kozmos.social").trim();
const token = String(args.token || process.env.KOZMOS_RUNTIME_TOKEN || "").trim();

if (!token) {
  console.error("[start-axy-runtime] missing token. Use --token <kzrt_...> or KOZMOS_RUNTIME_TOKEN.");
  process.exit(1);
}

const userOverrides = { ...args };
delete userOverrides.token;
delete userOverrides["base-url"];
delete userOverrides.username;

const mergedProfile = {
  ...DEFAULT_AXY_PROFILE,
  ...userOverrides,
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const serviceFile = resolve(currentDir, "axy-runtime-service.mjs");

const childArgv = [
  serviceFile,
  "--base-url",
  baseUrl,
  "--token",
  token,
  "--username",
  "Axy",
  ...toArgv(mergedProfile),
];

console.log("[start-axy-runtime] launching Axy with embedded profile...");
const child = spawn(process.execPath, childArgv, {
  stdio: "inherit",
  env: process.env,
});

let forwardingSignal = false;
function forwardSignal(signal) {
  if (forwardingSignal) return;
  forwardingSignal = true;
  console.log(`[start-axy-runtime] forwarding ${signal} to Axy service...`);
  try {
    child.kill(signal);
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

process.on("SIGINT", () => {
  forwardSignal("SIGINT");
});

process.on("SIGTERM", () => {
  forwardSignal("SIGTERM");
});

child.on("exit", (code, signal) => {
  if (signal === "SIGINT") {
    process.exit(130);
    return;
  }
  if (signal === "SIGTERM") {
    process.exit(143);
    return;
  }
  process.exit(code ?? 0);
});
